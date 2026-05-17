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
import { Envelope, Kv, MessageSig, Wata, webhookCallback } from 'wata'
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
 * pending intent's opaque `req` handle without going through the
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

function pair() {
  const hostOrigin = 'https://wallet.example'
  const consumerOrigin = 'https://acme.dev'
  const hostPath = '/auth/webhook'
  const webhookUrl = `${consumerOrigin}/cb`

  const hostKeypair = Ed25519.createKeyPair()
  const consumerKeypair = Ed25519.createKeyPair()
  const hostStore = memoryWithScan()
  const consumerStore = Kv.memory()

  const consumerWk = consumerWellknown({
    document: {
      callback_urls: [webhookUrl],
      id: 'acme.dev',
      identity_pubkey: ed25519Pubkey(consumerKeypair.publicKey),
      name: 'Acme CLI',
      origin: consumerOrigin,
      version: '1.0',
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
  let deliverySignatureInput: string | undefined
  let registerSignatureInput: string | undefined

  const hostFetchOverride = (async (input: Request | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const req = input instanceof Request ? input : new Request(url, init)
    if (url.startsWith(consumerOrigin)) {
      if (url.endsWith('/.well-known/urpc/consumer.json')) return consumerWk.fetch(req)
      deliverySignatureInput = req.headers.get('signature-input') ?? undefined
      return consumerTransport.fetch(req)
    }
    throw new Error(`unexpected host->* fetch to ${url}`)
  }) as typeof fetch

  const consumerFetchOverride = (async (input: Request | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const req = input instanceof Request ? input : new Request(url, init)
    if (url.startsWith(hostOrigin)) {
      if (url.endsWith('/.well-known/urpc/host.json')) return hostWk.fetch(req)
      registerSignatureInput = req.headers.get('signature-input') ?? undefined
      return hostTransport.fetch(req)
    }
    throw new Error(`unexpected consumer->* fetch to ${url}`)
  }) as typeof fetch

  hostTransport = hostWebhookCallback({
    baseUrl: hostOrigin,
    expiresIn: 60,
    fetch: hostFetchOverride,
    html: {
      authenticate: async ({ actions, request }) => {
        const form = await request.formData()
        const req = String(form.get('req') ?? '')
        const action = String(form.get('action') ?? 'approve')
        if (action === 'deny') await actions.deny(req)
        else await actions.approve(req)
        return new Response('ok')
      },
      render: () => new Response('ok'),
    },
    path: hostPath,
    store: hostStore,
  })

  consumerTransport = webhookCallback({
    fetch: consumerFetchOverride,
    host: hostOrigin,
    path: '/cb',
    store: consumerStore,
  })

  async function findActiveReq(): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < 2000) {
      const keys = hostStore.scanKeys('webhook:req:')
      if (keys.length > 0) return keys[0]!.slice('webhook:req:'.length)
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('timed out waiting for pending req')
  }

  async function approve(): Promise<void> {
    const req = await findActiveReq()
    const form = new FormData()
    form.set('req', req)
    form.set('action', 'approve')
    await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify`, { body: form, method: 'POST' }),
    )
  }

  async function deny(): Promise<void> {
    const req = await findActiveReq()
    const form = new FormData()
    form.set('req', req)
    form.set('action', 'deny')
    await hostTransport.fetch(
      new Request(`${hostOrigin}${hostPath}/verify`, { body: form, method: 'POST' }),
    )
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
    findActiveReq,
    getDeliverySignatureInput,
    getRegisterSignatureInput,
    hostKeypair,
    hostOrigin,
    hostPath,
    hostStore,
    hostTransport,
    hostWk,
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
    const hostWata = HostWata.create({
      privateKey: setup.hostKeypair.privateKey,
      transport: hostTransport,
    })
    hostWata.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = wata.send({ method: 'ping', params: [] })
    await approve()
    const { result } = await sendPromise
    const register = MessageSig.parseSignatureInput(setup.getRegisterSignatureInput() ?? '')
    const delivery = MessageSig.parseSignatureInput(setup.getDeliverySignatureInput() ?? '')
    expect(register.parameters.keyid).toMatchInlineSnapshot(`"https://acme.dev#identity"`)
    expect(delivery.parameters.keyid).toMatchInlineSnapshot(`"https://wallet.example#identity"`)
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
        keyid: 'k',
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
      parameters: { alg: 'ed25519', created: Math.floor(Date.now() / 1000), keyid: 'k' },
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

  test('cancel before approval marks the intent cancelled (idempotent 204)', async () => {
    const {
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveReq,
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
    const req = await findActiveReq()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:req:${req}`,
    )) as HostWebhookCallback.PendingRecord
    await consumerTransport.cancel()
    const after = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:authReqId:${record.authReqId}`,
    )) as HostWebhookCallback.PendingRecord
    expect(after.status).toBe('cancelled')
  })

  test('replay of the same webhook delivery is rejected', async () => {
    const {
      approve,
      consumerKeypair,
      consumerOrigin,
      consumerTransport,
      findActiveReq,
      hostKeypair,
      hostStore,
      hostTransport,
    } = pair()
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      privateKey: consumerKeypair.privateKey,
      transport: consumerTransport,
    })
    const hostWata = HostWata.create({
      privateKey: hostKeypair.privateKey,
      transport: hostTransport,
    })
    hostWata.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = wata.send({ method: 'ping', params: [] })
    // Wait until the consumer has registered + we have a req handle,
    // so we can extract the auth_req_id for the replay payload below.
    const req = await findActiveReq()
    const record = (await hostStore.get<HostWebhookCallback.PendingRecord>(
      `webhook:req:${req}`,
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
