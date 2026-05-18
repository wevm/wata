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

/**
 * In-memory store with key iteration. Lets the test harness find the
 * pending intent's opaque code without going through the
 * browser-facing /verify UI.
 */
function memoryWithScan(): Kv.Kv & { scanKeys: (prefix: string) => string[] } {
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
  consumerOnPrompt?: Parameters<typeof webhookCallback>[0]['onPrompt'] | undefined
  consumerDiscoveryPublicKey?: string | null | undefined
  hostAuthenticate?:
    | NonNullable<Parameters<typeof hostWebhookCallback>[0]['html']['authenticate']>
    | undefined
  hostExpiresIn?: number | undefined
  hostRetrySeconds?: number | undefined
}

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
  let deliverySignatureInput: string | undefined
  let registerSignatureInput: string | undefined

  const hostFetchOverride = (async (input: Request | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const request = input instanceof Request ? input : new Request(url, init)
    if (url.startsWith(consumerOrigin)) {
      if (url.endsWith('/.well-known/urpc/consumer.json')) return consumerWk.fetch(request)
      deliveryBody = await request.clone().text()
      deliverySignatureInput = request.headers.get('signature-input') ?? undefined
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
      render: () => new Response('ok'),
      ...(options.hostAuthenticate ? { authenticate: options.hostAuthenticate } : {}),
    },
    path: hostPath,
    retrySeconds: options.hostRetrySeconds,
    store: hostStore,
  })

  consumerTransport = webhookCallback({
    fetch: consumerFetchOverride,
    host: hostOrigin,
    onPrompt: options.consumerOnPrompt,
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
    return await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=${encodeURIComponent(code)}`, {
        body,
        headers: { 'content-type': 'application/json', origin: hostOrigin },
        method: 'POST',
      }),
    )
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
    getDeliverySignatureInput,
    getDeliveryBody,
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

describe('webhookCallback end-to-end', () => {
  test('register → approve → outbound webhook → consumer resolves send()', async () => {
    const setup = pair()
    const { approve, consumerTransport, hostTransport } = setup
    const wata = Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transport: consumerTransport,
    })
    HostWata.create({ privateKey: setup.hostKeypair.privateKey, transport: hostTransport })

    const sendPromise = wata.send({ method: 'ping', params: [] })
    const approvalBody =
      '{\n  "payload": [\n    { "jsonrpc": "2.0", "result": { "ok": true }, "id": 1 }\n  ],\n  "type": "rpc-responses"\n}'
    await approve(approvalBody)
    const { result } = await sendPromise
    const register = MessageSig.parseSignatureInput(setup.getRegisterSignatureInput() ?? '')
    const delivery = MessageSig.parseSignatureInput(setup.getDeliverySignatureInput() ?? '')
    expect(register.parameters.keyid).toMatchInlineSnapshot(`"https://acme.dev#identity"`)
    expect(delivery.parameters.keyid).toMatchInlineSnapshot(`"https://wallet.example#identity"`)
    expect(setup.getDeliveryBody()).toBe(approvalBody)
    expect(result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)
  })

  test('user denial delivers `-32000 denied by user` to the consumer', async () => {
    const { consumerKeypair, consumerOrigin, consumerTransport, deny, hostKeypair, hostTransport } =
      pair()
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transport: consumerTransport,
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transport: hostTransport })

    const sendPromise = wata.send({ method: 'ping', params: [] })
    await deny()

    await expect(sendPromise).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Rpc.RpcError: denied by user]`,
    )
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
      transport: consumerTransport,
    })
    const host = HostWata.create({ privateKey: hostKeypair.privateKey, transport: hostTransport })
    host.on('request', (event) => event.respond({ ok: true }))
    await host.start()

    const sendPromise = consumer.send({ method: 'ping', params: [] })
    const code = await setup.findActiveCode()
    const response = await hostTransport.fetch(
      new Request(`${setup.hostOrigin}${setup.hostPath}/verify`, {
        body: new URLSearchParams({ decision: 'approve', code: code }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: setup.hostOrigin,
        },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('Approved')
    await expect(sendPromise).resolves.toMatchObject({ result: { ok: true } })
  })

  test('sets approval-surface hardening headers', async () => {
    const { hostOrigin, hostPath, hostTransport } = pair()

    const response = await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify?code=unknown`),
    )

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe(
      [
        "default-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
        "style-src 'self' 'unsafe-inline'",
      ].join('; '),
    )
    expect(response.headers.get('pragma')).toBe('no-cache')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
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

  test('preserves host-provided approval-surface hardening headers', async () => {
    const transport = hostWebhookCallback({
      html: {
        render: () =>
          new Response('ok', {
            headers: {
              'content-security-policy': "default-src 'none'",
              'referrer-policy': 'same-origin',
            },
          }),
      },
      store: Kv.memory(),
    })

    const response = await transport.fetch(new Request('https://wallet.example/verify'))

    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(response.headers.get('referrer-policy')).toBe('same-origin')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  test('clamps advertised retry_seconds to the spec bounds', async () => {
    async function registerWith(retrySeconds: number) {
      const prompts: Array<{ retrySeconds: number | undefined }> = []
      const setup = pair({
        consumerOnPrompt: (prompt) => {
          prompts.push(prompt)
        },
        hostRetrySeconds: retrySeconds,
      })
      Wata.create({
        baseUrl: setup.consumerOrigin,
        privateKey: setup.consumerKeypair.privateKey,
        transport: setup.consumerTransport,
      })

      await setup.consumerTransport.send(
        Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      )
      const code = await setup.findActiveCode()
      const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
        `webhook:code:${code}`,
      )) as HostWebhookCallback.PendingRecord

      return { prompt: prompts[0], record }
    }

    const low = await registerWith(1)
    const high = await registerWith(100_000)

    expect(low.prompt?.retrySeconds).toBe(300)
    expect(low.record.retrySeconds).toBe(300)
    expect(high.prompt?.retrySeconds).toBe(86400)
    expect(high.record.retrySeconds).toBe(86400)
  })

  test('clamps advertised expires_in to the spec approval-window ceiling', async () => {
    const prompts: Array<{ expiresIn: number | undefined }> = []
    const setup = pair({
      consumerOnPrompt: (prompt) => {
        prompts.push(prompt)
      },
      hostExpiresIn: 1_000,
    })
    Wata.create({
      baseUrl: setup.consumerOrigin,
      privateKey: setup.consumerKeypair.privateKey,
      transport: setup.consumerTransport,
    })

    await setup.consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await setup.findActiveCode()
    const record = (await setup.hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord

    expect(prompts[0]?.expiresIn).toBe(600)
    expect(record.expiresAt - record.createdAt).toBe(600_000)
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
        transport,
      })

      await expect(
        transport.send(Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])),
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
      'https://wallet.example/auth?code=opaque',
      'verification_uri origin does not match host auth_url_origin',
      'https://auth.wallet.example',
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
      transport: consumerTransport,
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
      transport: consumerTransport,
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
      transport: consumerTransport,
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

  test('rejects /register without a correlatable JSON-RPC request id', async () => {
    const { consumerKeypair, consumerOrigin, consumerTransport, hostStore } = pair()
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transport: consumerTransport,
    })

    await expect(
      consumerTransport.send(Envelope.rpcRequests([Rpc.notification({ method: 'ping', params: [] })])),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: webhook-callback /register returned status 400: {"error":"invalid_request","error_description":"\`message\` must contain at least one JSON-RPC request id"}]`,
    )
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
        "error_description": "\`webhook_url\` must use https",
      }
    `)
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

  test('rejects /register when consumer.json omits identity_pubkey', async () => {
    const { consumerKeypair, consumerOrigin, consumerTransport } = pair({
      consumerDiscoveryPublicKey: null,
    })
    Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transport: consumerTransport,
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
      transport: consumerTransport,
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transport: hostTransport })

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
      transport: consumerTransport,
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transport: hostTransport })

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
      transport: consumerTransport,
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]))
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
      transport: consumerTransport,
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
      transport: consumerTransport,
    })

    const sendPromise = consumer.send({ method: 'ping', params: [] })
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
    await expect(sendPromise).resolves.toMatchObject({ result: { ok: true } })
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
      transport: consumerTransport,
    })

    await consumerTransport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
    )
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    const body = JSON.stringify(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]))
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
      transport: consumerTransport,
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
      transport: consumerTransport,
    })
    HostWata.create({ privateKey: hostKeypair.privateKey, transport: hostTransport })

    const sendPromise = wata.send({ method: 'ping', params: [] })
    // Wait until the consumer has registered + we have a code,
    // so we can extract the auth_req_id for the replay payload below.
    const code = await findActiveCode()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:code:${code}`,
    )) as HostWebhookCallback.PendingRecord
    await approve()
    await sendPromise

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
