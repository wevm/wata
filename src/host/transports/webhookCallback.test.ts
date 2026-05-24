/**
 * End-to-end test for the webhook-callback transport, exercised
 * against the real consumer + host adapters wired together by
 * `Wata.create`.
 *
 * No real network: both peers' HTTP routes are exposed via
 * `transport.fetch`, and the consumer / host `fetch` overrides
 * route every cross-origin request straight into the right peer's
 * handler. Lets us prove the same `.fetch` handler runs on Node,
 * Cloudflare Workers, etc.
 */

import { Base64, Bytes, Ed25519, Hex } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Discovery, Envelope, Kv, MessageSig, Rpc, Wata, webhookCallback } from 'wata'
import {
  Wata as HostWata,
  WebhookCallback as HostWebhookCallback,
  webhookCallback as hostWebhookCallback,
} from 'wata/host'
import { consumerWellknown, hostWellknown } from 'wata/server'

function ed25519Pubkey(publicKey: Hex.Hex): string {
  return Base64.fromBytes(Bytes.from(publicKey), { pad: false, url: true })
}

const expectedApprovalSurfaceCsp = [
  "default-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "style-src 'self' 'unsafe-inline'",
].join('; ')

/**
 * In-memory store with key iteration. Lets the test harness find the
 * pending intent's opaque code without going through the
 * browser-facing /verify UI.
 */
function memoryWithScan(): Kv.AtomicKv & { scanKeys: (prefix: string) => string[] } {
  const inner = new Map<string, { expiresAt?: number; value: unknown }>()
  const isExpired = (entry: { expiresAt?: number }) =>
    entry.expiresAt !== undefined && Date.now() >= entry.expiresAt
  return {
    async delete(key) {
      inner.delete(key)
    },
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const entry = inner.get(key)
      if (!entry || isExpired(entry)) return undefined
      return entry.value as T
    },
    scanKeys(prefix) {
      const out: string[] = []
      for (const [key, entry] of inner)
        if (key.startsWith(prefix) && !isExpired(entry)) out.push(key)
      return out
    },
    async set(key, value, options) {
      const expiresAt = options?.ttl ? Date.now() + options.ttl * 1000 : undefined
      inner.set(key, expiresAt !== undefined ? { expiresAt, value } : { value })
    },
    async take<T = unknown>(key: string): Promise<T | undefined> {
      const entry = inner.get(key)
      inner.delete(key)
      if (!entry || isExpired(entry)) return undefined
      return entry.value as T
    },
  }
}

type PairOptions = {
  consumerDiscoveryPublicKey?: string | null | undefined
  hostAuthenticate?:
    | NonNullable<Parameters<typeof hostWebhookCallback>[0]['html']['authenticate']>
    | undefined
  hostDelivery?:
    | ((
        request: Request,
        next: (request: Request) => Promise<Response>,
      ) => Promise<Response> | Response)
    | undefined
  hostExpiresIn?: number | undefined
  hostPendingIntentLimit?: HostWebhookCallback.Options['pendingIntentLimit'] | undefined
  hostRegistrationRateLimit?: HostWebhookCallback.Options['registrationRateLimit'] | undefined
  hostRetrySeconds?: number | undefined
  hostValidateOutboundRequest?: HostWebhookCallback.Options['validateOutboundRequest'] | undefined
}

type ApprovalTokenSession = { cookie: string; token: string }

function pair(options: PairOptions = {}) {
  const hostOrigin = 'https://wallet.example'
  const consumerOrigin = 'https://acme.dev'
  const hostPath = '/auth/webhook'
  const webhookUrl = `${consumerOrigin}/cb`

  const hostKeypair = Ed25519.createKeyPair()
  const consumerKeypair = Ed25519.createKeyPair()
  const consumerDiscoveryPublicKey =
    options.consumerDiscoveryPublicKey === null
      ? undefined
      : (options.consumerDiscoveryPublicKey ?? ed25519Pubkey(consumerKeypair.publicKey))
  const hostStore = memoryWithScan()
  const consumerStore = Kv.memory()

  const consumerWk = consumerWellknown({
    document: {
      callback_urls: [webhookUrl],
      id: 'acme.dev',
      name: 'Acme CLI',
      origin: consumerOrigin,
      version: '1.0',
      ...(consumerDiscoveryPublicKey ? { identity_pubkey: consumerDiscoveryPublicKey } : {}),
    },
  })

  const hostWk = hostWellknown({
    meta: { name: 'Example Wallet' },
    publicKey: ed25519Pubkey(hostKeypair.publicKey),
    transports: {
      'webhook-callback': {
        auth_url_origin: hostOrigin,
        register_url: `${hostOrigin}${hostPath}/register`,
      },
    },
  })

  // Forward declarations so the two transports can route fetches to
  // each other.
  let hostTransport!: ReturnType<typeof hostWebhookCallback>
  let consumerTransport!: ReturnType<typeof webhookCallback>
  let deliveryBody: string | undefined
  let deliveryAttempts = 0
  let deliverySignatureInput: string | undefined
  let registerSignatureInput: string | undefined

  const hostFetchOverride = (async (input: Request | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const request = input instanceof Request ? input : new Request(url, init)
    if (url.startsWith(consumerOrigin)) {
      if (url.endsWith('/.well-known/urpc/consumer.json')) return consumerWk.fetch(request)
      deliveryAttempts += 1
      deliveryBody = await request.clone().text()
      deliverySignatureInput = request.headers.get('signature-input') ?? undefined
      if (options.hostDelivery)
        return await options.hostDelivery(request, (nextRequest) =>
          consumerTransport.fetch(nextRequest),
        )
      return consumerTransport.fetch(request)
    }
    throw new Error(`unexpected host->* fetch to ${url}`)
  }) as typeof fetch

  const consumerFetchOverride = (async (input: Request | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const request = input instanceof Request ? input : new Request(url, init)
    if (url.startsWith(hostOrigin)) {
      if (url.endsWith('/.well-known/urpc/host.json')) return hostWk.fetch(request)
      registerSignatureInput = request.headers.get('signature-input') ?? undefined
      return hostTransport.fetch(request)
    }
    throw new Error(`unexpected consumer->* fetch to ${url}`)
  }) as typeof fetch

  hostTransport = hostWebhookCallback({
    baseUrl: hostOrigin,
    expiresIn: options.hostExpiresIn ?? 60,
    fetch: hostFetchOverride,
    html: {
      render: ({ approvalToken }) => new Response(approvalToken ?? 'ok'),
      ...(options.hostAuthenticate ? { authenticate: options.hostAuthenticate } : {}),
    },
    path: hostPath,
    pendingIntentLimit: options.hostPendingIntentLimit,
    registrationRateLimit: options.hostRegistrationRateLimit,
    retrySeconds: options.hostRetrySeconds,
    store: hostStore,
    validateOutboundRequest: options.hostValidateOutboundRequest,
  })

  consumerTransport = webhookCallback({
    fetch: consumerFetchOverride,
    host: hostOrigin,
    path: '/cb',
    store: consumerStore,
  })

  async function findActiveCode(): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < 2000) {
      const keys = hostStore.scanKeys('webhook:code:')
      if (keys.length > 0) return keys[0]!.slice('webhook:code:'.length)
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('timed out waiting for pending code')
  }

  async function postApproval(code: string, body: string): Promise<Response> {
    const session = await getApprovalSession(code)
    const headers = new Headers({ 'content-type': 'application/json', origin: hostOrigin })
    if (session) {
      headers.set('cookie', session.cookie)
      headers.set('urpc-approval-token', session.token)
    }
    return await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body,
        headers,
        method: 'POST',
      }),
    )
  }

  async function getApprovalSession(code: string): Promise<ApprovalTokenSession | undefined> {
    const response = await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=${encodeURIComponent(code)}`),
    )
    if (!response.ok) return undefined
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) return undefined
    return { cookie, token: await response.text() }
  }

  async function submitApproval(code: string, body: string): Promise<void> {
    const response = await postApproval(code, body)
    if (!response.ok)
      throw new Error(`approval POST failed: ${response.status} ${await response.text()}`)
  }

  async function approvalBody(
    code: string,
    responseFor: (id: Rpc.Id) => Rpc.Response,
  ): Promise<string> {
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    return JSON.stringify(
      Envelope.rpcResponses(
        record.message.type === 'rpc-requests'
          ? record.message.payload.flatMap((entry) =>
              'id' in entry ? [responseFor(entry.id)] : [],
            )
          : [],
      ),
    )
  }

  async function approve(body?: string): Promise<void> {
    const code = await findActiveCode()
    await submitApproval(
      code,
      body ??
        (await approvalBody(code, (id) =>
          Rpc.success({
            id,
            result: { ok: true },
          }),
        )),
    )
  }

  async function deny(): Promise<void> {
    const code = await findActiveCode()
    await submitApproval(
      code,
      await approvalBody(code, (id) =>
        Rpc.error({
          code: -32000,
          id,
          message: 'denied by user',
        }),
      ),
    )
  }

  function getDeliveryBody(): string | undefined {
    return deliveryBody
  }

  function getDeliveryAttempts(): number {
    return deliveryAttempts
  }

  function getDeliverySignatureInput(): string | undefined {
    return deliverySignatureInput
  }

  function getRegisterSignatureInput(): string | undefined {
    return registerSignatureInput
  }

  return {
    approve,
    consumerKeypair,
    consumerOrigin,
    consumerStore,
    consumerTransport,
    consumerWk,
    deny,
    findActiveCode,
    getApprovalSession,
    getDeliveryAttempts,
    getDeliveryBody,
    getDeliverySignatureInput,
    getRegisterSignatureInput,
    hostKeypair,
    hostOrigin,
    hostPath,
    hostStore,
    hostTransport,
    hostWk,
    postApproval,
    webhookUrl,
  }
}

function signedRequest(options: signedRequest.Options): Request {
  const {
    body,
    components,
    contentEncoding,
    contentType = 'application/json',
    created,
    keyid,
    method,
    nonce,
    privateKey,
    publicKey,
    url,
  } = options
  const headers =
    body === undefined
      ? { 'urpc-public-key': publicKey }
      : {
          'content-digest': MessageSig.contentDigest(body),
          'content-type': contentType,
          'urpc-public-key': publicKey,
          ...(contentEncoding ? { 'content-encoding': contentEncoding } : {}),
        }
  const { signature, signatureInput } = MessageSig.sign({
    components,
    message: { headers, method, url },
    parameters: {
      alg: 'ed25519',
      created: created ?? Math.floor(Date.now() / 1000),
      keyid,
      ...(nonce ? { nonce } : {}),
    },
    privateKey,
  })
  const signedHeaders = { ...headers, signature, 'signature-input': signatureInput }
  if (body === undefined) return new Request(url, { headers: signedHeaders, method })
  return new Request(url, { body, headers: signedHeaders, method })
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitFor timed out')
}

declare namespace signedRequest {
  type Options = {
    body?: string | undefined
    components: readonly string[]
    contentEncoding?: string | undefined
    contentType?: string | undefined
    created?: number | undefined
    keyid: string
    method: string
    nonce?: string | undefined
    privateKey: Hex.Hex
    publicKey: string
    url: string
  }
}

describe('webhookCallback end-to-end', () => {
  test('register → approve → outbound webhook → consumer resolves send()', async () => {
    const setup = pair()
    const { approve, consumerTransport, hostTransport } = setup
    const wata = Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    HostWata.create({ privateKey: setup.hostKeypair.privateKey, transports: [hostTransport] })
    const events: Array<{ meta: Wata.RpcEnvelopeMeta; responses: Wata.RpcResponsesPayload }> = []
    wata.on('rpc-responses', (responses, meta) => events.push({ meta, responses }))

    const registration = await wata.send({ method: 'ping', params: [] })
    const approvalBody =
      '{\n  "payload": [\n    { "jsonrpc": "2.0", "result": { "ok": true }, "id": 1 }\n  ],\n  "type": "rpc-responses"\n}'
    await approve(approvalBody)
    await waitFor(() => events.length === 1)
    const register = MessageSig.parseSignatureInput(setup.getRegisterSignatureInput() ?? '')
    const delivery = MessageSig.parseSignatureInput(setup.getDeliverySignatureInput() ?? '')
    expect(register.parameters.keyid).toMatchInlineSnapshot(`"https://acme.dev#identity"`)
    expect(delivery.parameters.keyid).toMatchInlineSnapshot(`"https://wallet.example#identity"`)
    expect(setup.getDeliveryBody()).toBe(approvalBody)
    expect(registration.verificationUri).toContain(
      'https://wallet.example/auth/webhook/verify?code=',
    )
    expect(events).toMatchInlineSnapshot(`
      [
        {
          "meta": {
            "direction": "incoming",
            "transport": "webhookCallback",
            "type": "rpc-responses",
          },
          "responses": [
            {
              "id": 1,
              "jsonrpc": "2.0",
              "result": {
                "ok": true,
              },
            },
          ],
        },
      ]
    `)
  })

  test('calls outbound request guard before discovery and delivery fetches', async () => {
    const outboundRequests: Array<{ authReqId?: string | undefined; kind: string; url: string }> =
      []
    const setup = pair({
      hostValidateOutboundRequest: ({ authReqId, kind, url }) => {
        outboundRequests.push({
          kind,
          url: url.toString(),
          ...(authReqId ? { authReqId } : {}),
        })
      },
    })
    const wata = Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })
    HostWata.create({ privateKey: setup.hostKeypair.privateKey, transports: [setup.hostTransport] })

    const sendPromise = wata.send({ method: 'ping', params: [] })
    const code = await setup.findActiveCode()
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    await setup.approve()
    await sendPromise

    expect(outboundRequests).toContainEqual({
      kind: 'consumer-discovery',
      url: `${setup.consumerOrigin}/.well-known/urpc/consumer.json`,
    })
    expect(outboundRequests).toContainEqual({
      kind: 'webhook-delivery',
      url: setup.webhookUrl,
    })
    expect(outboundRequests).toContainEqual({
      authReqId: record.authReqId,
      kind: 'webhook-delivery',
      url: setup.webhookUrl,
    })
  })

  test('rejects registration when outbound request guard refuses consumer discovery', async () => {
    const setup = pair({
      hostValidateOutboundRequest: ({ kind }) => {
        if (kind === 'consumer-discovery') throw new Error('blocked private address')
      },
    })
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await expect(
      setup.consumerTransport.send(
        Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      ),
    ).rejects.toThrow('blocked private address')
    expect(setup.hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('rejects registration when outbound request guard refuses webhook_url', async () => {
    const setup = pair({
      hostValidateOutboundRequest: ({ authReqId, kind }) => {
        if (kind === 'webhook-delivery' && !authReqId) throw new Error('blocked private address')
      },
    })
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await expect(
      setup.consumerTransport.send(
        Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      ),
    ).rejects.toThrow('webhook_url validation failed: blocked private address')
    expect(setup.hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('inferred Node outbound guard rejects DNS names resolving to reserved addresses', async () => {
    const hostKeypair = Ed25519.createKeyPair()
    const consumerKeypair = Ed25519.createKeyPair()
    const hostOrigin = 'https://wallet.example'
    const hostPath = '/auth/webhook'
    const hostStore = memoryWithScan()
    const hostTransport = hostWebhookCallback({
      baseUrl: hostOrigin,
      html: { render: () => new Response('ok') },
      path: hostPath,
      store: hostStore,
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transports: [hostTransport] })
    const consumerOrigin = 'https://acme.dev'
    const consumerPublicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const registerUrl = `${hostOrigin}${hostPath}/register`
    const body = JSON.stringify({
      message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      webhook_url: 'https://lvh.me/cb',
    })

    const response = await hostTransport.fetch(
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        keyid: `${consumerOrigin}#identity`,
        method: 'POST',
        nonce: 'n',
        privateKey: consumerKeypair.privateKey,
        publicKey: consumerPublicKey,
        url: registerUrl,
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "webhook_url validation failed: outbound webhook-delivery host \`lvh.me\` resolved to reserved address 127.0.0.1",
      }
    `)
    expect(hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('rejects dotted loopback webhook_url forms before outbound validation', async () => {
    const hostKeypair = Ed25519.createKeyPair()
    const hostOrigin = 'https://wallet.example'
    const transport = hostWebhookCallback({
      baseUrl: hostOrigin,
      html: { render: () => new Response('ok') },
      path: '/auth/webhook',
      store: memoryWithScan(),
      validateOutboundRequest: () => {},
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transports: [transport] })
    const consumerKeypair = Ed25519.createKeyPair()
    const consumerOrigin = 'https://acme.dev'
    const consumerPublicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const registerUrl = `${hostOrigin}/auth/webhook/register`
    const body = JSON.stringify({
      message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      webhook_url: 'https://localhost./cb',
    })

    const response = await transport.fetch(
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        keyid: `${consumerOrigin}#identity`,
        method: 'POST',
        nonce: 'n',
        privateKey: consumerKeypair.privateKey,
        publicKey: consumerPublicKey,
        url: registerUrl,
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "\`webhook_url\` must use a public https URL (http allowed only for loopback development)",
      }
    `)
  })

  test('retries webhook delivery after a transient failure', async () => {
    let failures = 0
    const setup = pair({
      hostDelivery: async (request, next) => {
        failures += 1
        if (failures === 1) return new Response('try again', { status: 500 })
        return await next(request)
      },
    })
    const wata = Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })
    HostWata.create({ privateKey: setup.hostKeypair.privateKey, transports: [setup.hostTransport] })
    const events: Wata.RpcResponsesPayload[] = []
    wata.on('rpc-responses', (responses) => events.push(responses))

    const registration = await wata.send({ method: 'ping', params: [] })
    const code = await setup.findActiveCode()
    const response = await setup.postApproval(
      code,
      JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
    )
    await waitFor(() => events.length === 1)

    expect(response.status).toBe(200)
    expect(setup.getDeliveryAttempts()).toBe(2)
    expect(registration.verificationUri).toContain(
      'https://wallet.example/auth/webhook/verify?code=',
    )
    expect(events[0]).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "jsonrpc": "2.0",
          "result": {
            "ok": true,
          },
        },
      ]
    `)
  })

  test('stops webhook delivery retries on terminal client errors', async () => {
    const setup = pair({
      hostDelivery: () => new Response('bad request', { status: 400 }),
    })
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })
    HostWata.create({ privateKey: setup.hostKeypair.privateKey, transports: [setup.hostTransport] })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const response = await setup.postApproval(
      code,
      JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
    )

    let after: HostWebhookCallback.PendingRecord | undefined
    const start = Date.now()
    while (Date.now() - start < 2_000) {
      after = await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
        `webhook:authReqId:${record.authReqId}`,
      )
      if (after?.status === 'undeliverable') break
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(response.status).toBe(200)
    expect(setup.getDeliveryAttempts()).toBe(1)
    expect(after?.status).toBe('undeliverable')
  })

  test('does not overwrite an existing terminal delivery transition', async () => {
    let setup!: ReturnType<typeof pair>
    let authReqId = ''
    const winnerBody = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: 'winner' } })]),
    )
    const winnerResponse = Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: 'winner' } })])

    setup = pair({
      hostDelivery: async () => {
        const current = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
          `webhook:authReqId:${authReqId}`,
        )) as HostWebhookCallback.PendingRecord
        current.response = winnerResponse
        current.responseBody = winnerBody
        current.status = 'delivered'
        await setup.hostStore.set(`webhook:authReqId:${authReqId}`, current)
        return new Response('ok')
      },
    })
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })
    HostWata.create({ privateKey: setup.hostKeypair.privateKey, transports: [setup.hostTransport] })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    authReqId = record.authReqId
    const response = await setup.postApproval(
      code,
      JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
    )

    let after: HostWebhookCallback.PendingRecord | undefined
    const start = Date.now()
    while (Date.now() - start < 2_000) {
      after = await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
        `webhook:authReqId:${authReqId}`,
      )
      if (after?.status === 'delivered' && after.responseBody === winnerBody) break
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(response.status).toBe(200)
    expect(setup.getDeliveryAttempts()).toBe(1)
    expect(after?.status).toBe('delivered')
    expect(after?.responseBody).toBe(winnerBody)
  })

  test('user denial delivers `-32000 denied by user` to the consumer', async () => {
    const { consumerKeypair, consumerOrigin, consumerTransport, deny, hostKeypair, hostTransport } =
      pair()
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transports: [hostTransport] })
    const events: Wata.RpcResponsesPayload[] = []
    wata.on('rpc-responses', (responses) => events.push(responses))

    const registration = await wata.send({ method: 'ping', params: [] })
    await deny()
    await waitFor(() => events.length === 1)

    expect(registration.verificationUri).toContain(
      'https://wallet.example/auth/webhook/verify?code=',
    )
    expect(events[0]).toMatchInlineSnapshot(`
      [
        {
          "error": {
            "code": -32000,
            "message": "denied by user",
          },
          "id": 1,
          "jsonrpc": "2.0",
        },
      ]
    `)
  })

  test('form authenticate actions can approve through the host request listener', async () => {
    const setup = pair({
      hostAuthenticate: async ({ actions, request }) => {
        const form = await request.formData()
        const code = String(form.get('code') ?? '')
        const decision = String(form.get('decision') ?? '')
        if (decision === 'approve') {
          await actions.approve(code)
          return new Response('Approved')
        }
        await actions.deny(code)
        return new Response('Denied')
      },
    })
    const { consumerKeypair, consumerOrigin, consumerTransport, hostKeypair, hostTransport } = setup
    const consumer = Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    const host = HostWata.create({
      privateKey: hostKeypair.privateKey,
      transports: [hostTransport],
    })
    host.on('request', (event) => event.respond({ ok: true }))
    await host.start()
    const events: Wata.RpcResponsesPayload[] = []
    consumer.on('rpc-responses', (responses) => events.push(responses))

    await consumer.send({ method: 'ping', params: [] })
    const code = await setup.findActiveCode()
    const session = await setup.getApprovalSession(code)
    if (!session) throw new Error('approval session missing')
    const response = await hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify`, {
        body: new URLSearchParams({
          approval_token: session.token,
          code,
          decision: 'approve',
        }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: session.cookie,
          origin: setup.hostOrigin,
        },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('Approved')
    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "jsonrpc": "2.0",
          "result": {
            "ok": true,
          },
        },
      ]
    `)
  })

  test('form authenticate actions accept opaque-origin approval submissions', async () => {
    const setup = pair({
      hostAuthenticate: async ({ actions, request }) => {
        const form = await request.formData()
        const code = String(form.get('code') ?? '')
        await actions.approve(code)
        return new Response('Approved')
      },
    })
    const { consumerKeypair, consumerOrigin, consumerTransport, hostKeypair, hostTransport } = setup
    const consumer = Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    const host = HostWata.create({
      privateKey: hostKeypair.privateKey,
      transports: [hostTransport],
    })
    host.on('request', (event) => event.respond({ ok: true }))
    await host.start()
    const events: Wata.RpcResponsesPayload[] = []
    consumer.on('rpc-responses', (responses) => events.push(responses))

    await consumer.send({ method: 'ping', params: [] })
    const code = await setup.findActiveCode()
    const session = await setup.getApprovalSession(code)
    if (!session) throw new Error('approval session missing')
    const response = await hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify`, {
        body: new URLSearchParams({
          approval_token: session.token,
          code,
          decision: 'approve',
        }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: session.cookie,
          origin: 'null',
        },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('Approved')
    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "jsonrpc": "2.0",
          "result": {
            "ok": true,
          },
        },
      ]
    `)
  })

  test('sets approval-surface hardening headers', async () => {
    const { hostOrigin, hostPath, hostTransport } = pair()

    const response = await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=unknown`),
    )

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe(expectedApprovalSurfaceCsp)
    expect(response.headers.get('pragma')).toBe('no-cache')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  test('uses the public baseUrl to secure approval-session cookies', async () => {
    const store = memoryWithScan()
    const now = Date.now()
    await store.set('webhook:code:code-1', {
      authReqId: 'auth-1',
      code: 'code-1',
      consumer: {
        id: 'acme.dev',
        meta: {
          icon: 'https://acme.dev/icon.png',
          name: 'Acme',
        },
        origin: 'https://acme.dev',
        publicKey: 'A'.repeat(43),
      },
      createdAt: now,
      expiresAt: now + 60_000,
      message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      retrySeconds: 300,
      status: 'pending',
      webhookUrl: 'https://acme.dev/cb',
    } satisfies HostWebhookCallback.PendingRecord)
    const transport = hostWebhookCallback({
      baseUrl: 'https://wallet.example',
      html: { render: () => new Response('ok') },
      path: '/auth/webhook',
      store,
    })

    const response = await transport.fetch(
      new Request('http://internal.local/auth/webhook/verify?code=code-1'),
    )

    expect(response.headers.get('set-cookie')).toContain('; Secure')
  })

  test('omits internal fields from approval hook records', async () => {
    const store = memoryWithScan()
    const now = Date.now()
    await store.set('webhook:code:code-1', {
      authReqId: 'auth-1',
      code: 'code-1',
      consumer: {
        id: 'acme.dev',
        meta: {
          icon: 'https://acme.dev/icon.png',
          name: 'Acme',
        },
        origin: 'https://acme.dev',
        publicKey: 'A'.repeat(43),
      },
      createdAt: now,
      expiresAt: now + 60_000,
      message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      retrySeconds: 300,
      status: 'pending',
      webhookUrl: 'https://acme.dev/cb',
    } satisfies HostWebhookCallback.PendingRecord)
    let approvalToken = ''
    let renderHasAuthReqId: boolean | undefined
    let renderHasWebhookUrl: boolean | undefined
    let renderHasPublicKey: boolean | undefined
    let renderIcon: string | undefined
    let authenticateHasAuthReqId: boolean | undefined
    let getIcon: string | undefined
    let getHasAuthReqId: boolean | undefined
    const transport = hostWebhookCallback({
      baseUrl: 'https://wallet.example',
      html: {
        async authenticate({ actions, code, record }) {
          authenticateHasAuthReqId = !!record && 'authReqId' in record
          const fetched = code ? await actions.get(code) : undefined
          getHasAuthReqId = !!fetched && 'authReqId' in fetched
          getIcon = fetched?.consumer.meta?.icon
          return new Response('ok')
        },
        render: ({ approvalToken: token, record }) => {
          approvalToken = token ?? ''
          renderHasAuthReqId = !!record && 'authReqId' in record
          renderHasWebhookUrl = !!record && 'webhookUrl' in record
          renderHasPublicKey = !!record && 'publicKey' in record.consumer
          renderIcon = record?.consumer.meta?.icon
          return new Response('ok')
        },
      },
      path: '/auth/webhook',
      store,
    })

    const get = await transport.fetch(
      new Request('https://wallet.example/auth/webhook/verify?code=code-1'),
    )
    const cookie = get.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('approval session cookie missing')
    const post = await transport.fetch(
      new Request('https://wallet.example/auth/webhook/verify', {
        body: new URLSearchParams({ approval_token: approvalToken, code: 'code-1' }),
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://wallet.example',
        },
        method: 'POST',
      }),
    )

    expect(post.status).toBe(200)
    expect(renderHasAuthReqId).toBe(false)
    expect(renderHasWebhookUrl).toBe(false)
    expect(renderHasPublicKey).toBe(false)
    expect(renderIcon).toBe('/auth/webhook/verify/icon?code=code-1')
    expect(authenticateHasAuthReqId).toBe(false)
    expect(getHasAuthReqId).toBe(false)
    expect(getIcon).toBe('/auth/webhook/verify/icon?code=code-1')
  })

  test('proxies consumer icons through a host-origin approval route', async () => {
    const store = memoryWithScan()
    const now = Date.now()
    await store.set('webhook:code:code-1', {
      authReqId: 'auth-1',
      code: 'code-1',
      consumer: {
        id: 'acme.dev',
        meta: {
          icon: 'https://acme.dev/icon.png',
          name: 'Acme',
        },
        origin: 'https://acme.dev',
        publicKey: 'A'.repeat(43),
      },
      createdAt: now,
      expiresAt: now + 60_000,
      message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      retrySeconds: 300,
      status: 'pending',
      webhookUrl: 'https://acme.dev/cb',
    } satisfies HostWebhookCallback.PendingRecord)

    let fetches = 0
    const transport = hostWebhookCallback({
      baseUrl: 'https://wallet.example',
      fetch: async (input) => {
        fetches += 1
        expect(String(input)).toBe('https://acme.dev/icon.png')
        return new Response('icon-bytes', {
          headers: {
            'content-length': '10',
            'content-type': 'image/png',
          },
        })
      },
      html: { render: () => new Response('ok') },
      path: '/auth/webhook',
      store,
    })

    const first = await transport.fetch(
      new Request('https://wallet.example/auth/webhook/verify/icon?code=code-1'),
    )
    const second = await transport.fetch(
      new Request('https://wallet.example/auth/webhook/verify/icon?code=code-1'),
    )

    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    await expect(first.text()).resolves.toBe('icon-bytes')
    expect(second.status).toBe(200)
    await expect(second.text()).resolves.toBe('icon-bytes')
    expect(fetches).toBe(1)
  })

  test('approval actions only expose live pending records', async () => {
    const store = memoryWithScan()
    const now = Date.now()
    await store.set('webhook:code:delivered-code', {
      authReqId: 'auth-1',
      code: 'delivered-code',
      consumer: {
        id: 'acme.dev',
        origin: 'https://acme.dev',
        publicKey: 'A'.repeat(43),
      },
      createdAt: now,
      expiresAt: now + 60_000,
      message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      retrySeconds: 300,
      status: 'delivered',
      webhookUrl: 'https://acme.dev/cb',
    } satisfies HostWebhookCallback.PendingRecord)
    await store.set('webhook:code:expired-code', {
      authReqId: 'auth-2',
      code: 'expired-code',
      consumer: {
        id: 'acme.dev',
        origin: 'https://acme.dev',
        publicKey: 'A'.repeat(43),
      },
      createdAt: now - 120_000,
      expiresAt: now - 60_000,
      message: Envelope.rpcRequests([{ id: 2, jsonrpc: '2.0', method: 'pong', params: [] }]),
      retrySeconds: 300,
      status: 'pending',
      webhookUrl: 'https://acme.dev/cb',
    } satisfies HostWebhookCallback.PendingRecord)

    let delivered: HostWebhookCallback.html.ApprovalRecord | undefined
    let expired: HostWebhookCallback.html.ApprovalRecord | undefined
    const transport = hostWebhookCallback({
      html: {
        async authenticate({ actions }) {
          delivered = await actions.get('delivered-code')
          expired = await actions.get('expired-code')
          return new Response('ok')
        },
        render: () => new Response('ok'),
      },
      store,
    })

    const response = await transport.fetch(
      new Request('https://wallet.example/verify', {
        body: '',
        headers: { origin: 'https://wallet.example' },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(200)
    expect(delivered).toBeUndefined()
    expect(expired).toBeUndefined()
  })

  test('rejects supplied invalid verification codes before rendering', async () => {
    let renders = 0
    const transport = hostWebhookCallback({
      html: {
        render: () => {
          renders += 1
          return new Response('rendered')
        },
      },
      store: Kv.memory(),
    })

    const invalid = await transport.fetch(new Request('https://wallet.example/verify?code=unknown'))
    const bare = await transport.fetch(new Request('https://wallet.example/verify'))

    expect(invalid.status).toBe(410)
    expect(await invalid.json()).toMatchInlineSnapshot(`
      {
        "error": "gone",
        "error_description": "approval request is no longer available",
      }
    `)
    expect(await bare.text()).toBe('rendered')
    expect(renders).toBe(1)
  })

  test('enforces non-negotiable approval-surface hardening headers', async () => {
    const transport = hostWebhookCallback({
      html: {
        render: () =>
          new Response('ok', {
            headers: {
              'cache-control': 'public, max-age=3600',
              'content-security-policy': 'default-src *; frame-ancestors *; base-uri *',
              'referrer-policy': 'same-origin',
              'x-frame-options': 'SAMEORIGIN',
            },
          }),
      },
      store: Kv.memory(),
    })

    const response = await transport.fetch(new Request('https://wallet.example/verify'))

    expect(response.headers.get('content-security-policy')).toBe(
      `default-src *; frame-ancestors *; base-uri *, ${expectedApprovalSurfaceCsp}`,
    )
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  test('requires a store with atomic take support', () => {
    const store = {
      async delete() {},
      async get() {
        return undefined
      },
      async set() {},
    } satisfies Kv.Kv

    expect(() =>
      hostWebhookCallback({
        html: { render: () => new Response('ok') },
        store: store as unknown as HostWebhookCallback.Options['store'],
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: webhook-callback host store must implement \`take\` for single-use approval codes]`,
    )
  })

  test('clamps advertised retry_seconds to the spec bounds', async () => {
    async function registerWith(retrySeconds: number) {
      const setup = pair({
        hostRetrySeconds: retrySeconds,
      })
      Wata.create({
        baseUrl: setup.consumerOrigin,
        privateKey: setup.consumerKeypair.privateKey,
        transports: [setup.consumerTransport],
      })

      const registration = await setup.consumerTransport.send(
        Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      )
      const code = await setup.findActiveCode()
      const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
        `webhook:code:${code}`,
      )) as HostWebhookCallback.PendingRecord

      return { registration, record }
    }

    const low = await registerWith(1)
    const high = await registerWith(100_000)

    expect(low.registration.retrySeconds).toBe(300)
    expect(low.record.retrySeconds).toBe(300)
    expect(high.registration.retrySeconds).toBe(86400)
    expect(high.record.retrySeconds).toBe(86400)
  })

  test('clamps advertised expires_in to the spec approval-window ceiling', async () => {
    const setup = pair({
      hostExpiresIn: 1_000,
    })
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    const registration = await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(registration.expiresIn).toBe(600)
    expect(record.expiresAt - record.createdAt).toBe(600_000)
  })

  test('host returns distinct auth_req_id and verification code handles', async () => {
    const setup = pair()
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    const registration = await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )

    const code = new URL(registration.verificationUri).searchParams.get('code')
    if (!code) throw new Error('code missing')
    const record = await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )
    expect(record?.authReqId).toBeTruthy()
    expect(code).not.toBe(record?.authReqId)
  })

  test('consumer validates the returned verification_uri code shape', async () => {
    async function expectVerificationUriRejected(
      verificationUri: string,
      message: string,
      authUrlOrigin = 'https://wallet.example',
    ) {
      const hostKeypair = Ed25519.createKeyPair()
      const consumerKeypair = Ed25519.createKeyPair()
      const hostDocument = {
        id: 'wallet.example',
        identity_pubkey: ed25519Pubkey(hostKeypair.publicKey),
        name: 'Example Wallet',
        origin: 'https://wallet.example',
        transports: {
          'webhook-callback': {
            auth_url_origin: authUrlOrigin,
            register_url: 'https://wallet.example/register',
          },
        },
        version: '1.0',
      } satisfies Discovery.HostDocument
      const transport = webhookCallback({
        fetch: (async () =>
          Response.json({
            auth_req_id: 'auth-1',
            expires_in: 60,
            retry_seconds: 300,
            verification_uri: verificationUri,
          })) as typeof fetch,
        host: hostDocument,
        path: '/cb',
        store: Kv.memory(),
      })
      Wata.create({
        baseUrl: 'https://acme.dev',
        privateKey: consumerKeypair.privateKey,
        transports: [transport],
      })

      await expect(
        transport.send(
          Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
        ),
      ).rejects.toThrow(message)
    }

    await expectVerificationUriRejected(
      'https://wallet.example/auth?req=opaque',
      'verification_uri must contain exactly one `code` query parameter',
    )
    await expectVerificationUriRejected(
      'https://wallet.example/auth?code=opaque&auth_req_id=secret',
      'verification_uri must contain exactly one `code` query parameter',
    )
    await expectVerificationUriRejected(
      'https://wallet.example/auth?code=auth-1',
      'verification_uri code must not equal `auth_req_id`',
    )
    await expectVerificationUriRejected(
      'https://auth.wallet.example/auth?code=opaque',
      'verification_uri origin does not match host auth_url_origin',
    )
  })

  test('consumer validates webhook-callback discovery binding origins', async () => {
    const hostKeypair = Ed25519.createKeyPair()
    const consumerKeypair = Ed25519.createKeyPair()

    async function expectBindingRejected(
      binding: NonNullable<Discovery.HostDocument['transports']['webhook-callback']>,
      message: string,
    ) {
      const transport = webhookCallback({
        fetch: (async () => {
          throw new Error('unexpected fetch')
        }) as typeof fetch,
        host: {
          id: 'wallet.example',
          identity_pubkey: ed25519Pubkey(hostKeypair.publicKey),
          name: 'Example Wallet',
          origin: 'https://wallet.example',
          transports: {
            'webhook-callback': binding,
          },
          version: '1.0',
        },
        path: '/cb',
        store: Kv.memory(),
      })
      Wata.create({
        baseUrl: 'https://acme.dev',
        privateKey: consumerKeypair.privateKey,
        transports: [transport],
      })

      await expect(
        transport.send(
          Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
        ),
      ).rejects.toThrow(message)
    }

    await expectBindingRejected(
      {
        auth_url_origin: 'https://wallet.example',
        register_url: 'https://evil.example/register',
      },
      'webhook-callback register_url origin does not match host origin',
    )
    await expectBindingRejected(
      {
        auth_url_origin: 'https://wallet.example/auth',
        register_url: 'https://wallet.example/register',
      },
      'webhook-callback auth_url_origin must be the host origin',
    )
  })

  test('consumer fetches host discovery at registration time', async () => {
    const hostKeypair = Ed25519.createKeyPair()
    const consumerKeypair = Ed25519.createKeyPair()
    const hostDocument = {
      id: 'wallet.example',
      identity_pubkey: ed25519Pubkey(hostKeypair.publicKey),
      name: 'Example Wallet',
      origin: 'https://wallet.example',
      transports: {
        'webhook-callback': {
          auth_url_origin: 'https://wallet.example',
          register_url: 'https://wallet.example/register',
        },
      },
      version: '1.0',
    } satisfies Discovery.HostDocument
    const fetches: string[] = []
    const transport = webhookCallback({
      fetch: (async (input: Request | string) => {
        const url = input instanceof Request ? input.url : String(input)
        fetches.push(url)
        if (url === 'https://wallet.example/.well-known/urpc/host.json')
          return Response.json(hostDocument)
        if (url === 'https://wallet.example/register')
          return Response.json({
            auth_req_id: 'auth-1',
            expires_in: 60,
            retry_seconds: 300,
            verification_uri: 'https://wallet.example/auth?code=opaque',
          })
        throw new Error(`unexpected fetch to ${url}`)
      }) as typeof fetch,
      host: 'https://wallet.example',
      path: '/cb',
      store: Kv.memory(),
    })

    expect(fetches).toEqual([])
    Wata.create({
      baseUrl: 'https://acme.dev',
      privateKey: consumerKeypair.privateKey,
      transports: [transport],
    })
    expect(fetches).toEqual([])

    await transport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )

    expect(fetches).toEqual([
      'https://wallet.example/.well-known/urpc/host.json',
      'https://wallet.example/register',
    ])
  })

  test('consumer disables redirects for register and cancel requests', async () => {
    const hostKeypair = Ed25519.createKeyPair()
    const consumerKeypair = Ed25519.createKeyPair()
    const hostDocument = {
      id: 'wallet.example',
      identity_pubkey: ed25519Pubkey(hostKeypair.publicKey),
      name: 'Example Wallet',
      origin: 'https://wallet.example',
      transports: {
        'webhook-callback': {
          auth_url_origin: 'https://wallet.example',
          register_url: 'https://wallet.example/register',
        },
      },
      version: '1.0',
    } satisfies Discovery.HostDocument
    const requests: Array<{
      method: string | undefined
      redirect: RequestRedirect | undefined
      url: string
    }> = []
    const transport = webhookCallback({
      fetch: (async (input: Request | string, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        requests.push({ method: init?.method, redirect: init?.redirect, url })
        if (url === 'https://wallet.example/.well-known/urpc/host.json')
          return Response.json(hostDocument)
        if (url === 'https://wallet.example/register')
          return Response.json({
            auth_req_id: 'auth-1',
            expires_in: 60,
            retry_seconds: 300,
            verification_uri: 'https://wallet.example/auth?code=opaque',
          })
        if (url === 'https://wallet.example/register/auth-1')
          return new Response(null, { status: 204 })
        throw new Error(`unexpected fetch to ${url}`)
      }) as typeof fetch,
      host: 'https://wallet.example',
      path: '/cb',
      store: Kv.memory(),
    })
    Wata.create({
      baseUrl: 'https://acme.dev',
      privateKey: consumerKeypair.privateKey,
      transports: [transport],
    })

    await transport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    await transport.cancel()

    expect(requests.filter((request) => !request.url.endsWith('/host.json'))).toEqual([
      {
        method: 'POST',
        redirect: 'manual',
        url: 'https://wallet.example/register',
      },
      {
        method: 'DELETE',
        redirect: 'manual',
        url: 'https://wallet.example/register/auth-1',
      },
    ])
  })

  test('consumer requires lifetime fields in the /register response', async () => {
    async function expectRegisterResponseRejected(
      responseBody: Record<string, unknown>,
      message: string,
    ) {
      const hostKeypair = Ed25519.createKeyPair()
      const consumerKeypair = Ed25519.createKeyPair()
      const hostDocument = {
        id: 'wallet.example',
        identity_pubkey: ed25519Pubkey(hostKeypair.publicKey),
        name: 'Example Wallet',
        origin: 'https://wallet.example',
        transports: {
          'webhook-callback': {
            auth_url_origin: 'https://wallet.example',
            register_url: 'https://wallet.example/register',
          },
        },
        version: '1.0',
      } satisfies Discovery.HostDocument
      const transport = webhookCallback({
        fetch: (async () => Response.json(responseBody)) as typeof fetch,
        host: hostDocument,
        path: '/cb',
        store: Kv.memory(),
      })
      Wata.create({
        baseUrl: 'https://acme.dev',
        privateKey: consumerKeypair.privateKey,
        transports: [transport],
      })

      await expect(
        transport.send(
          Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
        ),
      ).rejects.toThrow(message)
    }

    const baseResponse = {
      auth_req_id: 'auth-1',
      retry_seconds: 300,
      verification_uri: 'https://wallet.example/auth?code=opaque',
    }

    await expectRegisterResponseRejected(
      baseResponse,
      'host /register response missing `expires_in`',
    )
    await expectRegisterResponseRejected(
      { ...baseResponse, expires_in: 60, retry_seconds: undefined },
      'host /register response missing `retry_seconds`',
    )
    await expectRegisterResponseRejected(
      { ...baseResponse, auth_req_id: '', expires_in: 60 },
      'host /register response returned invalid `auth_req_id`',
    )
    await expectRegisterResponseRejected(
      { ...baseResponse, expires_in: 0 },
      'host /register response returned invalid `expires_in`',
    )
    await expectRegisterResponseRejected(
      { ...baseResponse, expires_in: 60, retry_seconds: 299 },
      'host /register response returned invalid `retry_seconds`',
    )
    await expectRegisterResponseRejected(
      { ...baseResponse, expires_in: 60, retry_seconds: 86401 },
      'host /register response returned invalid `retry_seconds`',
    )
  })

  test('rejects approval body whose response ids do not match the queued request', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostStore,
      postApproval,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const response = await postApproval(
      code,
      JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 2, result: { ok: true } })])),
    )
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "error_description": "response id 2 is not queued",
      }
    `)
    expect(record.status).toBe('pending')
  })

  test('discards queued messages when an approval request expires', async () => {
    const setup = pair()
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    await setup.hostStore.set(`webhook:code:${code}`, {
      ...record,
      expiresAt: Date.now() - 1,
    } satisfies HostWebhookCallback.PendingRecord)

    const response = await setup.hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body: JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
        headers: {
          'content-type': 'application/json',
          origin: setup.hostOrigin,
        },
        method: 'POST',
      }),
    )
    const after = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:authReqId:${record.authReqId}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "conflict",
        "error_description": "approval request expired",
      }
    `)
    expect(after.status).toBe('cancelled')
    expect(after.message).toMatchInlineSnapshot(`
      {
        "payload": [],
        "type": "rpc-requests",
      }
    `)
  })

  test('rejects a second approval submission for the same code', async () => {
    const setup = pair()
    const consumer = Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })
    HostWata.create({ privateKey: setup.hostKeypair.privateKey, transports: [setup.hostTransport] })
    const events: Wata.RpcResponsesPayload[] = []
    consumer.on('rpc-responses', (responses) => events.push(responses))

    await consumer.send({ method: 'ping', params: [] })
    const code = await setup.findActiveCode()
    const body = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
    )
    const first = await setup.postApproval(code, body)
    const second = await setup.postApproval(code, body)

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchInlineSnapshot(`
      {
        "error": "conflict",
        "error_description": "approval request is no longer pending",
      }
    `)
    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "jsonrpc": "2.0",
          "result": {
            "ok": true,
          },
        },
      ]
    `)
  })

  test('rejects cross-origin approval submissions before consuming the intent', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostOrigin,
      hostPath,
      hostStore,
      hostTransport,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const response = await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body: JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
        headers: {
          'content-type': 'application/json',
          origin: 'https://attacker.example',
        },
        method: 'POST',
      }),
    )
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "approval origin does not match host origin",
      }
    `)
    expect(record.status).toBe('pending')
  })

  test('rejects approval submissions without origin metadata', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostOrigin,
      hostPath,
      hostStore,
      hostTransport,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const response = await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body: JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "approval submission must include a same-origin \`Origin\` or \`Referer\`",
      }
    `)
    expect(record.status).toBe('pending')
  })

  test('rejects approval submissions without an approval token', async () => {
    const setup = pair()
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const response = await setup.hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body: JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
        headers: {
          'content-type': 'application/json',
          origin: setup.hostOrigin,
        },
        method: 'POST',
      }),
    )
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "missing approval token",
      }
    `)
    expect(record.status).toBe('pending')
  })

  test('rejects form approval submissions without an approval token', async () => {
    let authenticates = 0
    const setup = pair({
      hostAuthenticate: () => {
        authenticates += 1
        return new Response('called')
      },
    })
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const response = await setup.hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify`, {
        body: new URLSearchParams({
          code,
          decision: 'approve',
        }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: setup.hostOrigin,
        },
        method: 'POST',
      }),
    )
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "missing approval token",
      }
    `)
    expect(authenticates).toBe(0)
    expect(record.status).toBe('pending')
  })

  test('rejects unknown form approval codes before authenticate', async () => {
    let authenticates = 0
    const setup = pair({
      hostAuthenticate: () => {
        authenticates += 1
        return new Response('called')
      },
    })

    const response = await setup.hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify`, {
        body: new URLSearchParams({
          code: 'unknown',
          decision: 'approve',
        }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: setup.hostOrigin,
        },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "not_found",
        "error_description": "unknown or expired approval request",
      }
    `)
    expect(authenticates).toBe(0)
  })

  test('rejects mismatched query and form approval codes', async () => {
    let authenticates = 0
    const setup = pair({
      hostAuthenticate: () => {
        authenticates += 1
        return new Response('called')
      },
    })
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const session = await setup.getApprovalSession(code)
    if (!session) throw new Error('approval session missing')
    const response = await setup.hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body: new URLSearchParams({
          approval_token: session.token,
          code: 'other-code',
          decision: 'approve',
        }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: session.cookie,
          origin: setup.hostOrigin,
        },
        method: 'POST',
      }),
    )
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "approval form code does not match verification code",
      }
    `)
    expect(authenticates).toBe(0)
    expect(record.status).toBe('pending')
  })

  test('rejects default approval submissions without a JSON content type', async () => {
    const setup = pair()
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const session = await setup.getApprovalSession(code)
    if (!session) throw new Error('approval session missing')
    const response = await setup.hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body: JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
        headers: {
          'content-type': 'text/plain',
          cookie: session.cookie,
          origin: setup.hostOrigin,
          'urpc-approval-token': session.token,
        },
        method: 'POST',
      }),
    )
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "error_description": "expected \`Content-Type: application/json\`",
      }
    `)
    expect(record.status).toBe('pending')
  })

  test('rejects default approval submissions with non-identity content-encoding', async () => {
    const setup = pair()
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const session = await setup.getApprovalSession(code)
    if (!session) throw new Error('approval session missing')
    const response = await setup.hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body: JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
        headers: {
          'content-encoding': 'gzip',
          'content-type': 'application/json',
          cookie: session.cookie,
          origin: setup.hostOrigin,
          'urpc-approval-token': session.token,
        },
        method: 'POST',
      }),
    )
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "error_description": "unsupported \`Content-Encoding\`",
      }
    `)
    expect(record.status).toBe('pending')
  })

  test('rejects approval tokens from another approval session', async () => {
    const setup = pair()
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transports: [setup.consumerTransport],
    })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const first = await setup.getApprovalSession(code)
    const second = await setup.getApprovalSession(code)
    if (!first || !second) throw new Error('approval sessions missing')
    const response = await setup.hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body: JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })])),
        headers: {
          'content-type': 'application/json',
          cookie: second.cookie,
          origin: setup.hostOrigin,
          'urpc-approval-token': first.token,
        },
        method: 'POST',
      }),
    )
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "approval token does not match approval session",
      }
    `)
    expect(record.status).toBe('pending')
  })

  test('rejects /register without a correlatable JSON-RPC request id', async () => {
    const { consumerKeypair, consumerOrigin, consumerTransport, hostStore } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await expect(
      consumerTransport.send(
        Envelope.rpcRequests([Rpc.notification({ method: 'ping', params: [] })]),
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: webhook-callback /register returned status 400: {"error":"invalid_request","error_description":"\`message\` must contain at least one JSON-RPC request id"}]`,
    )
    expect(hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('rejects /register with an invalid expiry', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair()
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const cases: Array<{ expiry: unknown; nonce: string }> = [
      { expiry: 0, nonce: 'zero-expiry' },
      { expiry: -1, nonce: 'negative-expiry' },
      { expiry: '600', nonce: 'string-expiry' },
      { expiry: null, nonce: 'null-expiry' },
    ]

    for (const { expiry, nonce } of cases) {
      const body = JSON.stringify({ expiry, message, webhook_url: webhookUrl })
      const response = await hostTransport.fetch(
        signedRequest({
          body,
          components: [
            '@method',
            '@target-uri',
            '@authority',
            'content-type',
            'content-digest',
            'urpc-public-key',
          ],
          keyid: 'https://acme.dev#identity',
          method: 'POST',
          nonce,
          privateKey: consumerKeypair.privateKey,
          publicKey,
          url: `${hostOrigin}${hostPath}/register`,
        }),
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        error_description: '`expiry` must be a positive number of seconds',
      })
    }
    expect(hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('rejects /register with a non-HTTPS webhook_url', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostTransport } = pair()
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: 'http://acme.dev/cb' })
    const digest = MessageSig.contentDigest(body)
    const response = await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/register`, {
        body,
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          'urpc-public-key': ed25519Pubkey(consumerKeypair.publicKey),
        },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "forbidden",
        "error_description": "\`webhook_url\` must use a public https URL (http allowed only for loopback development)",
      }
    `)
  })

  test('allows loopback HTTP webhook_url for local development', async () => {
    const consumerOrigin = 'http://localhost:4646'
    const hostOrigin = 'http://localhost:4747'
    const hostPath = '/auth/webhook'
    const webhookUrl = `${consumerOrigin}/cb`
    const consumerKeypair = Ed25519.createKeyPair()
    const consumerPublicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const consumerWk = consumerWellknown({
      document: {
        callback_urls: [webhookUrl],
        id: 'localhost',
        identity_pubkey: consumerPublicKey,
        name: 'Local Consumer',
        origin: consumerOrigin,
        version: '1.0',
      },
    })
    const hostTransport = hostWebhookCallback({
      baseUrl: hostOrigin,
      fetch: (async (input: Request | string, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        const request = input instanceof Request ? input : new Request(url, init)
        if (url === `${consumerOrigin}/.well-known/urpc/consumer.json`)
          return consumerWk.fetch(request)
        throw new Error(`unexpected fetch to ${url}`)
      }) as typeof fetch,
      html: { render: () => new Response('ok') },
      path: hostPath,
      store: Kv.memory(),
    })
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const digest = MessageSig.contentDigest(body)
    const registerUrl = `${hostOrigin}${hostPath}/register`
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-public-key',
      ],
      message: {
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          'urpc-public-key': consumerPublicKey,
        },
        method: 'POST',
        url: registerUrl,
      },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: `${consumerOrigin}#identity`,
        nonce: 'n',
      },
      privateKey: consumerKeypair.privateKey,
    })

    const response = await hostTransport.fetch(
      new Request(registerUrl, {
        body,
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          signature,
          'signature-input': signatureInput,
          'urpc-public-key': consumerPublicKey,
        },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(200)
  })

  test('rejects reserved webhook_url hosts from non-loopback hosts', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostTransport } = pair()
    const urls = ['https://127.0.0.1/cb', 'https://[::ffff:127.0.0.1]/cb', 'https://[fea0::1]/cb']

    for (const webhookUrl of urls) {
      const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
      const body = JSON.stringify({ message, webhook_url: webhookUrl })
      const digest = MessageSig.contentDigest(body)
      const response = await hostTransport.fetch(
        new Request(`${hostOrigin}${hostPath}/register`, {
          body,
          headers: {
            'content-digest': digest,
            'content-type': 'application/json',
            'urpc-public-key': ed25519Pubkey(consumerKeypair.publicKey),
          },
          method: 'POST',
        }),
      )

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: 'forbidden',
        error_description:
          '`webhook_url` must use a public https URL (http allowed only for loopback development)',
      })
    }
  })

  test('rejects /register when webhook_url is not in consumer.json callback_urls', async () => {
    const { consumerKeypair, consumerOrigin, hostOrigin, hostPath, hostTransport } = pair()

    // Sign a register request for a wrong webhook_url (acme.dev/evil
    // is not in the allowlist).
    const evilUrl = `${consumerOrigin}/evil`
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: evilUrl })
    const digest = MessageSig.contentDigest(body)
    const registerUrl = `${hostOrigin}${hostPath}/register`
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-public-key',
      ],
      message: {
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          'urpc-public-key': ed25519Pubkey(consumerKeypair.publicKey),
        },
        method: 'POST',
        url: registerUrl,
      },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://acme.dev#identity',
        nonce: 'n',
      },
      privateKey: consumerKeypair.privateKey,
    })
    const response = await hostTransport.fetch(
      new Request(registerUrl, {
        body,
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          signature,
          'signature-input': signatureInput,
          'urpc-public-key': ed25519Pubkey(consumerKeypair.publicKey),
        },
        method: 'POST',
      }),
    )
    expect(response.status).toBe(403)
    const json = (await response.json()) as { error: string }
    expect(json.error).toBe('forbidden')
  })

  test('rejects /register with an invalid signature (401)', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostTransport, webhookUrl } = pair()
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const digest = MessageSig.contentDigest(body)
    const registerUrl = `${hostOrigin}${hostPath}/register`
    // Sign with a different (wrong) keypair to produce an invalid
    // signature under the declared uRPC-Public-Key.
    const wrongKey = Ed25519.createKeyPair()
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-public-key',
      ],
      message: {
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          'urpc-public-key': ed25519Pubkey(consumerKeypair.publicKey),
        },
        method: 'POST',
        url: registerUrl,
      },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://acme.dev#identity',
      },
      privateKey: wrongKey.privateKey,
    })
    const response = await hostTransport.fetch(
      new Request(registerUrl, {
        body,
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          signature,
          'signature-input': signatureInput,
          'urpc-public-key': ed25519Pubkey(consumerKeypair.publicKey),
        },
        method: 'POST',
      }),
    )
    expect(response.status).toBe(401)
  })

  test('rejects /register without a signature nonce', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair()
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const response = await hostTransport.fetch(
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        keyid: 'https://acme.dev#identity',
        method: 'POST',
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: `${hostOrigin}${hostPath}/register`,
      }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "unauthorized",
        "error_description": "missing signature nonce",
      }
    `)
    expect(hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('rejects /register without a JSON content type', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair()
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const response = await hostTransport.fetch(
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        contentType: 'text/plain',
        keyid: 'https://acme.dev#identity',
        method: 'POST',
        nonce: 'wrong-content-type',
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: `${hostOrigin}${hostPath}/register`,
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "error_description": "expected \`Content-Type: application/json\`",
      }
    `)
    expect(hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('rejects /register with non-identity content-encoding', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair()
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const response = await hostTransport.fetch(
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        contentEncoding: 'gzip',
        keyid: 'https://acme.dev#identity',
        method: 'POST',
        nonce: 'encoded-register',
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: `${hostOrigin}${hostPath}/register`,
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "error_description": "unsupported \`Content-Encoding\`",
      }
    `)
    expect(hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('rejects /register outside the signature created window', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair()
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const response = await hostTransport.fetch(
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        created: Math.floor(Date.now() / 1000) - 301,
        keyid: 'https://acme.dev#identity',
        method: 'POST',
        nonce: 'stale-created',
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: `${hostOrigin}${hostPath}/register`,
      }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "unauthorized",
        "error_description": "signature created outside acceptance window",
      }
    `)
    expect(hostStore.scanKeys('webhook:code:')).toEqual([])
  })

  test('rejects replayed /register signature nonces before creating another intent', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair()
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const registerUrl = `${hostOrigin}${hostPath}/register`
    const request = () =>
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        keyid: 'https://acme.dev#identity',
        method: 'POST',
        nonce: 'fixed-register-nonce',
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: registerUrl,
      })

    const first = await hostTransport.fetch(request())
    const second = await hostTransport.fetch(request())

    expect(first.status).toBe(200)
    expect(second.status).toBe(401)
    expect(await second.json()).toMatchInlineSnapshot(`
      {
        "error": "unauthorized",
        "error_description": "replay detected",
      }
    `)
    expect(hostStore.scanKeys('webhook:code:')).toHaveLength(1)
  })

  test('rate-limits authenticated registrations per consumer', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair({
      hostRegistrationRateLimit: { max: 1, windowSeconds: 60 },
    })
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const registerUrl = `${hostOrigin}${hostPath}/register`
    const request = (nonce: string) =>
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        keyid: 'https://acme.dev#identity',
        method: 'POST',
        nonce,
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: registerUrl,
      })

    const first = await hostTransport.fetch(request('first-register'))
    const second = await hostTransport.fetch(request('second-register'))

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({
      error: 'rate_limited',
      error_description: 'registration rate limit exceeded',
    })
    expect(hostStore.scanKeys('webhook:code:')).toHaveLength(1)
  })

  test('caps concurrent pending registrations per consumer', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair({
      hostPendingIntentLimit: { max: 1 },
      hostRegistrationRateLimit: false,
    })
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const registerUrl = `${hostOrigin}${hostPath}/register`
    const request = (nonce: string) =>
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        keyid: 'https://acme.dev#identity',
        method: 'POST',
        nonce,
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: registerUrl,
      })

    const first = await hostTransport.fetch(request('first-pending'))
    const second = await hostTransport.fetch(request('second-pending'))

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({
      error: 'rate_limited',
      error_description: 'too many pending approval requests',
    })
    expect(hostStore.scanKeys('webhook:code:')).toHaveLength(1)
  })

  test('rejects /register when consumer.json omits identity_pubkey', async () => {
    const { consumerKeypair, consumerOrigin, consumerTransport } = pair({
      consumerDiscoveryPublicKey: null,
    })
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await expect(
      consumerTransport.send(
        Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: webhook-callback /register returned status 401: {"error":"unauthorized","error_description":"consumer.json missing \`identity_pubkey\` for webhook-callback"}]`,
    )
  })

  test('cancel before approval marks the intent cancelled (idempotent 204)', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      hostTransport,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transports: [hostTransport] })

    const sendPromise = consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    await sendPromise // resolves after register
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    await consumerTransport.cancel()
    const after = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:authReqId:${record.authReqId}`,
    )) as HostWebhookCallback.PendingRecord
    expect(after.status).toBe('cancelled')
    expect(after.message).toMatchInlineSnapshot(`
      {
        "payload": [],
        "type": "rpc-requests",
      }
    `)
    expect(await hostStore.get(`webhook:code:${code}`)).toBeUndefined()
  })

  test('expired cancellation returns 204 without signature headers', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostStore,
      hostTransport,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const expiredRecord = {
      ...record,
      expiresAt: Date.now() - 1,
    } satisfies HostWebhookCallback.PendingRecord
    await hostStore.set(`webhook:code:${code}`, expiredRecord)
    await hostStore.set(`webhook:authReqId:${record.authReqId}`, expiredRecord)

    const response = await hostTransport.fetch(
      new Request(
        `https://wallet.example/auth/webhook/register/${encodeURIComponent(record.authReqId)}`,
        { method: 'DELETE' },
      ),
    )
    const after = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:authReqId:${record.authReqId}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(204)
    expect(after.status).toBe('cancelled')
    expect(after.message).toMatchInlineSnapshot(`
      {
        "payload": [],
        "type": "rpc-requests",
      }
    `)
    expect(await hostStore.get(`webhook:code:${code}`)).toBeUndefined()
  })

  test('consumer cancel closes the local exchange', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostStore,
      webhookUrl,
    } = pair()
    const consumer = Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    const registration = await consumer.send({ method: 'ping', params: [] })
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    await consumerTransport.cancel()

    expect(registration.verificationUri).toContain(
      'https://wallet.example/auth/webhook/verify?code=',
    )
    const late = await consumerTransport.fetch(
      new Request(webhookUrl, {
        body: '{}',
        headers: { 'urpc-auth-req-id': record.authReqId },
        method: 'POST',
      }),
    )
    expect(late.status).toBe(200)
    expect(await late.json()).toMatchInlineSnapshot(`
      {
        "idempotent": true,
        "ok": true,
      }
    `)
  })

  test('cancel does not overwrite an already-settled approval transition', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      hostTransport,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transports: [hostTransport] })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const approvedBody = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
    )
    const approvedRecord = {
      ...record,
      response: Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
      responseBody: approvedBody,
      settledAt: Date.now(),
      status: 'approved' as const,
    } satisfies HostWebhookCallback.PendingRecord
    await hostStore.set(`webhook:code:${code}`, approvedRecord)

    await consumerTransport.cancel()

    const after = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:authReqId:${record.authReqId}`,
    )) as HostWebhookCallback.PendingRecord
    expect(after.status).toBe('approved')
    expect(after.responseBody).toBe(approvedBody)
  })

  test('rejects cancel without a signature nonce', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostStore,
      hostTransport,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const url = `https://wallet.example/auth/webhook/register/${encodeURIComponent(record.authReqId)}`
    const response = await hostTransport.fetch(
      signedRequest({
        components: ['@method', '@target-uri', '@authority', 'urpc-public-key'],
        keyid: 'https://acme.dev#identity',
        method: 'DELETE',
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url,
      }),
    )
    const after = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:authReqId:${record.authReqId}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "unauthorized",
        "error_description": "missing signature nonce",
      }
    `)
    expect(after.status).toBe('pending')
  })

  test('rejects cancel that reuses the register signature nonce', async () => {
    const { consumerKeypair, hostOrigin, hostPath, hostStore, hostTransport, webhookUrl } = pair()
    const publicKey = ed25519Pubkey(consumerKeypair.publicKey)
    const message = Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])
    const body = JSON.stringify({ message, webhook_url: webhookUrl })
    const register = await hostTransport.fetch(
      signedRequest({
        body,
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
        keyid: 'https://acme.dev#identity',
        method: 'POST',
        nonce: 'shared-nonce',
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: `${hostOrigin}${hostPath}/register`,
      }),
    )
    const { auth_req_id } = (await register.json()) as { auth_req_id: string }
    const response = await hostTransport.fetch(
      signedRequest({
        components: ['@method', '@target-uri', '@authority', 'urpc-public-key'],
        keyid: 'https://acme.dev#identity',
        method: 'DELETE',
        nonce: 'shared-nonce',
        privateKey: consumerKeypair.privateKey,
        publicKey,
        url: `${hostOrigin}${hostPath}/register/${encodeURIComponent(auth_req_id)}`,
      }),
    )
    const after = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:authReqId:${auth_req_id}`,
    )) as HostWebhookCallback.PendingRecord

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "unauthorized",
        "error_description": "replay detected",
      }
    `)
    expect(after.status).toBe('pending')
  })

  test('consumer cancel surfaces host rejection', async () => {
    const { consumerKeypair, consumerOrigin, consumerTransport, findActiveCode, hostStore } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    await hostStore.set(`webhook:authReqId:${record.authReqId}`, {
      ...record,
      consumer: {
        ...record.consumer,
        publicKey: ed25519Pubkey(Ed25519.createKeyPair().publicKey),
      },
    } satisfies HostWebhookCallback.PendingRecord)

    await expect(consumerTransport.cancel()).rejects.toThrow(
      'webhook-callback cancel returned status 401',
    )
  })

  test('returns the same terminal response for unknown and cancelled verification codes', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostOrigin,
      hostPath,
      hostTransport,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transports: [hostTransport] })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    await consumerTransport.cancel()

    const unknown = await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=unknown`),
    )
    const cancelled = await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=${encodeURIComponent(code)}`),
    )

    expect(cancelled.status).toBe(unknown.status)
    expect(cancelled.status).toBe(410)
    expect(await cancelled.text()).toBe(await unknown.text())
  })

  test('consumer rejects webhook delivery with non-identity content-encoding', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      webhookUrl,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
    )
    const headers = {
      'content-digest': MessageSig.contentDigest(body),
      'content-encoding': 'gzip',
      'content-type': 'application/json',
      'urpc-auth-req-id': record.authReqId,
      'urpc-idempotency-key': record.authReqId,
      'urpc-public-key': ed25519Pubkey(hostKeypair.publicKey),
    }
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-auth-req-id',
        'urpc-public-key',
      ],
      message: { headers, method: 'POST', url: webhookUrl },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://wallet.example#identity',
        nonce: 'n',
      },
      privateKey: hostKeypair.privateKey,
    })

    const response = await consumerTransport.fetch(
      new Request(webhookUrl, {
        body,
        headers: { ...headers, signature, 'signature-input': signatureInput },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "unsupported \`Content-Encoding\`",
      }
    `)
  })

  test('consumer treats unknown encoded webhook delivery as idempotent', async () => {
    const { consumerTransport } = pair()

    const response = await consumerTransport.fetch(
      new Request('https://acme.dev/cb', {
        body: 'not-json',
        headers: {
          'content-encoding': 'gzip',
          'urpc-auth-req-id': 'unknown',
        },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "idempotent": true,
        "ok": true,
      }
    `)
  })

  test('consumer rejects active webhook delivery without an idempotency key', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      webhookUrl,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
    )
    const headers = {
      'content-digest': MessageSig.contentDigest(body),
      'content-type': 'application/json',
      'urpc-auth-req-id': record.authReqId,
      'urpc-public-key': ed25519Pubkey(hostKeypair.publicKey),
    }
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-auth-req-id',
        'urpc-public-key',
      ],
      message: { headers, method: 'POST', url: webhookUrl },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://wallet.example#identity',
        nonce: 'missing-idempotency-key',
      },
      privateKey: hostKeypair.privateKey,
    })

    const response = await consumerTransport.fetch(
      new Request(webhookUrl, {
        body,
        headers: { ...headers, signature, 'signature-input': signatureInput },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "missing \`uRPC-Idempotency-Key\`",
      }
    `)
  })

  test('consumer rejects active webhook delivery without a JSON content type', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      webhookUrl,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
    )
    const headers = {
      'content-digest': MessageSig.contentDigest(body),
      'content-type': 'text/plain',
      'urpc-auth-req-id': record.authReqId,
      'urpc-idempotency-key': record.authReqId,
      'urpc-public-key': ed25519Pubkey(hostKeypair.publicKey),
    }
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-auth-req-id',
        'urpc-public-key',
      ],
      message: { headers, method: 'POST', url: webhookUrl },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://wallet.example#identity',
        nonce: 'wrong-content-type',
      },
      privateKey: hostKeypair.privateKey,
    })

    const response = await consumerTransport.fetch(
      new Request(webhookUrl, {
        body,
        headers: { ...headers, signature, 'signature-input': signatureInput },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "expected \`Content-Type: application/json\`",
      }
    `)
  })

  test('consumer rejects active webhook delivery with a mismatched idempotency key', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      webhookUrl,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
    )
    const headers = {
      'content-digest': MessageSig.contentDigest(body),
      'content-type': 'application/json',
      'urpc-auth-req-id': record.authReqId,
      'urpc-idempotency-key': 'different-idempotency-key',
      'urpc-public-key': ed25519Pubkey(hostKeypair.publicKey),
    }
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-auth-req-id',
        'urpc-public-key',
      ],
      message: { headers, method: 'POST', url: webhookUrl },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://wallet.example#identity',
        nonce: 'mismatched-idempotency-key',
      },
      privateKey: hostKeypair.privateKey,
    })

    const response = await consumerTransport.fetch(
      new Request(webhookUrl, {
        body,
        headers: { ...headers, signature, 'signature-input': signatureInput },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "\`uRPC-Idempotency-Key\` must match \`uRPC-Auth-Req-Id\`",
      }
    `)
  })

  test('consumer keeps nonce replay markers for the replay window', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      webhookUrl,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = '{"type":"rpc-responses","payload":['
    const headers = {
      'content-digest': MessageSig.contentDigest(body),
      'content-type': 'application/json',
      'urpc-auth-req-id': record.authReqId,
      'urpc-idempotency-key': record.authReqId,
      'urpc-public-key': ed25519Pubkey(hostKeypair.publicKey),
    }
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-auth-req-id',
        'urpc-public-key',
      ],
      message: { headers, method: 'POST', url: webhookUrl },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://wallet.example#identity',
        nonce: 'fixed-nonce',
      },
      privateKey: hostKeypair.privateKey,
    })
    const post = () =>
      consumerTransport.fetch(
        new Request(webhookUrl, {
          body,
          headers: { ...headers, signature, 'signature-input': signatureInput },
          method: 'POST',
        }),
      )

    const first = await post()
    const second = await post()
    const third = await post()

    expect(first.status).toBe(400)
    expect(second.status).toBe(401)
    expect(third.status).toBe(401)
  })

  test('consumer rejects webhook delivery outside the signature created window', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      webhookUrl,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
    )
    const headers = {
      'content-digest': MessageSig.contentDigest(body),
      'content-type': 'application/json',
      'urpc-auth-req-id': record.authReqId,
      'urpc-idempotency-key': record.authReqId,
      'urpc-public-key': ed25519Pubkey(hostKeypair.publicKey),
    }
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-auth-req-id',
        'urpc-public-key',
      ],
      message: { headers, method: 'POST', url: webhookUrl },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000) - 301,
        keyid: 'https://wallet.example#identity',
        nonce: 'stale-created',
      },
      privateKey: hostKeypair.privateKey,
    })

    const response = await consumerTransport.fetch(
      new Request(webhookUrl, {
        body,
        headers: { ...headers, signature, 'signature-input': signatureInput },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "signature created outside acceptance window",
      }
    `)
  })

  test('consumer does not consume idempotency keys for invalid webhook bodies', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      webhookUrl,
    } = pair()
    const consumer = Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    const events: Wata.RpcResponsesPayload[] = []
    consumer.on('rpc-responses', (responses) => events.push(responses))

    await consumer.send({ method: 'ping', params: [] })
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    async function postWebhook(body: string, nonce: string) {
      const headers = {
        'content-digest': MessageSig.contentDigest(body),
        'content-type': 'application/json',
        'urpc-auth-req-id': record.authReqId,
        'urpc-idempotency-key': record.authReqId,
        'urpc-public-key': ed25519Pubkey(hostKeypair.publicKey),
      }
      const { signature, signatureInput } = MessageSig.sign({
        components: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-auth-req-id',
          'urpc-public-key',
        ],
        message: { headers, method: 'POST', url: webhookUrl },
        parameters: {
          alg: 'ed25519',
          created: Math.floor(Date.now() / 1000),
          keyid: 'https://wallet.example#identity',
          nonce,
        },
        privateKey: hostKeypair.privateKey,
      })
      return await consumerTransport.fetch(
        new Request(webhookUrl, {
          body,
          headers: { ...headers, signature, 'signature-input': signatureInput },
          method: 'POST',
        }),
      )
    }

    const invalid = await postWebhook('{"type":"rpc-responses","payload":[', 'invalid-body')
    const validBody = JSON.stringify(
      Envelope.rpcResponses(
        record.message.type === 'rpc-requests'
          ? record.message.payload.flatMap((entry) =>
              'id' in entry ? [Rpc.success({ id: entry.id, result: { ok: true } })] : [],
            )
          : [],
      ),
    )
    const valid = await postWebhook(validBody, 'valid-body')

    expect(invalid.status).toBe(400)
    expect(valid.status).toBe(200)
    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "jsonrpc": "2.0",
          "result": {
            "ok": true,
          },
        },
      ]
    `)
  })

  test('consumer rejects webhook delivery without a signature nonce', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      webhookUrl,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = JSON.stringify(
      Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]),
    )
    const headers = {
      'content-digest': MessageSig.contentDigest(body),
      'content-type': 'application/json',
      'urpc-auth-req-id': record.authReqId,
      'urpc-idempotency-key': record.authReqId,
      'urpc-public-key': ed25519Pubkey(hostKeypair.publicKey),
    }
    const { signature, signatureInput } = MessageSig.sign({
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        'urpc-auth-req-id',
        'urpc-public-key',
      ],
      message: { headers, method: 'POST', url: webhookUrl },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://wallet.example#identity',
      },
      privateKey: hostKeypair.privateKey,
    })

    const response = await consumerTransport.fetch(
      new Request(webhookUrl, {
        body,
        headers: { ...headers, signature, 'signature-input': signatureInput },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "missing signature nonce",
      }
    `)
  })

  test('rejects cancel signed by a different consumer identity', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostStore,
      hostTransport,
    } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const wrongKeypair = Ed25519.createKeyPair()
    const wrongPublicKey = ed25519Pubkey(wrongKeypair.publicKey)
    const url = `https://wallet.example/auth/webhook/register/${encodeURIComponent(record.authReqId)}`
    const { signature, signatureInput } = MessageSig.sign({
      components: ['@method', '@target-uri', '@authority', 'urpc-public-key'],
      message: {
        headers: { 'urpc-public-key': wrongPublicKey },
        method: 'DELETE',
        url,
      },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: 'https://acme.dev#identity',
        nonce: 'n',
      },
      privateKey: wrongKeypair.privateKey,
    })

    const response = await hostTransport.fetch(
      new Request(url, {
        headers: {
          signature,
          'signature-input': signatureInput,
          'urpc-public-key': wrongPublicKey,
        },
        method: 'DELETE',
      }),
    )
    const after = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:authReqId:${record.authReqId}`,
    )) as HostWebhookCallback.PendingRecord
    expect(response.status).toBe(401)
    expect(after.status).toBe('pending')
  })

  test('replay of the same webhook delivery is rejected', async () => {
    const {
      approve,
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveCode,
      hostKeypair,
      hostStore,
      hostTransport,
    } = pair()
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transports: [consumerTransport],
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transports: [hostTransport] })
    const events: Wata.RpcResponsesPayload[] = []
    wata.on('rpc-responses', (responses) => events.push(responses))

    await wata.send({ method: 'ping', params: [] })
    // Wait until the consumer has registered + we have a code,
    // so we can extract the auth_req_id for the replay payload below.
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    await approve()
    await waitFor(() => events.length === 1)

    // Build a hand-rolled "replay" of the original delivery by
    // POSTing arbitrary bytes back to the consumer's webhook
    // listener with the same auth_req_id but a different idempotency
    // key — we expect the request to be ignored because the
    // single-exchange transport is already closed (no active
    // auth_req_id), and the consumer returns idempotent 200.
    const replay = await consumerTransport.fetch(
      new Request('https://acme.dev/cb', {
        body: '{"type":"rpc-responses","payload":[]}',
        headers: {
          'content-type': 'application/json',
          'urpc-auth-req-id': record.authReqId,
        },
        method: 'POST',
      }),
    )
    // After the consumer transport closes itself on terminal
    // response, `state.activeAuthReqId` is `undefined` so any
    // subsequent inbound webhook is treated as a no-op (200,
    // idempotent) without re-emitting `message`.
    expect(replay.status).toBe(200)
  })
})
