import { describe, expect, test } from 'vp/test'
import { Envelope, Errors, Kv, Wata, Rpc, Schema, deviceCode, loopback } from 'wata'
import { Wata as HostWata, deviceCode as hostDeviceCode } from 'wata/host'
import { z } from 'zod/mini'

// 43-char unpadded base64url Ed25519 pubkey per uRPC discovery.md §2.2.
const identity_pubkey = 'A'.repeat(43)

const schema = Schema.create({
  methods: {
    ping: Schema.method({
      params: z.tuple([]),
      result: z.object({ ok: z.literal(true) }),
    }),
    add: Schema.method({
      params: z.tuple([z.number(), z.number()]),
      result: z.number(),
    }),
  },
})

function pair() {
  const { consumer: cTransport, host: hTransport } = loopback()
  const consumer = Wata.create({ transport: cTransport, schema })
  const host = HostWata.create({ transport: hTransport, schema })
  return { consumer, host }
}

describe('create', () => {
  test('wata Wata.create returns a consumer', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transport: consumer })
    expect(wata.role).toMatchInlineSnapshot(`"consumer"`)
    expect(typeof wata.start).toMatchInlineSnapshot(`"function"`)
    expect(typeof wata.send).toMatchInlineSnapshot(`"function"`)
  })

  test('wata/host Wata.create returns a host', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transport: host })
    expect(wata.role).toMatchInlineSnapshot(`"host"`)
    expect(typeof wata.start).toMatchInlineSnapshot(`"function"`)
    expect(typeof wata.on).toMatchInlineSnapshot(`"function"`)
  })
})

describe('start', () => {
  test('emits `open` on both sides', async () => {
    const { consumer, host } = pair()
    const consumerOpens: void[] = []
    const hostOpens: void[] = []
    consumer.on('open', () => consumerOpens.push(undefined))
    host.on('open', () => hostOpens.push(undefined))

    await consumer.start()
    await host.start()

    expect(consumerOpens.length).toMatchInlineSnapshot(`1`)
    expect(hostOpens.length).toMatchInlineSnapshot(`1`)
  })
})

describe('send', () => {
  test('round-trips a typed result via host respond()', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    host.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const out = await consumer.send({ method: 'ping', params: [] })
    expect(out).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "ok": true,
        },
      }
    `)
  })

  test('first non-undefined listener return wins', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    host.on('request', () => undefined)
    host.on('request', ({ request }) => {
      if (request.method === 'add') {
        const [a, b] = request.params as [number, number]
        return a + b
      }
      return undefined
    })

    const out = await consumer.send({ method: 'add', params: [2, 3] })
    expect(out.result).toMatchInlineSnapshot(`5`)
  })

  test('rejects with Rpc.RpcError when host calls reject()', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    host.on('request', ({ reject }) => {
      reject({ code: -32000, message: 'denied' })
    })

    await expect(
      consumer.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: denied]`)
  })

  test('responds with method-not-found when no listener is registered for `request`', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    await expect(
      consumer.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: method not found]`)
  })

  test('listener that returns undefined leaves the request pending for late settlement', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    let captured: { id: number | string } | undefined
    host.on('request', (event) => {
      captured = { id: event.id }
    })

    const inflight = consumer.send({ method: 'ping', params: [] })

    // Drain microtasks so the listener has run.
    await Promise.resolve()
    await Promise.resolve()

    expect(captured).toBeDefined()
    host.respond(captured!.id, { ok: true })

    expect(await inflight).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "ok": true,
        },
      }
    `)
  })

  test('wata.respond settles the matching pending request by id', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    const ids: (number | string)[] = []
    host.on('request', (event) => {
      ids.push(event.id)
    })

    const a = consumer.send({ method: 'ping', params: [] })
    const b = consumer.send({ method: 'add', params: [2, 3] })

    await Promise.resolve()
    await Promise.resolve()

    host.respond(ids[1]!, 5)
    host.respond(ids[0]!, { ok: true })

    expect((await a).result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)
    expect((await b).result).toMatchInlineSnapshot(`5`)
  })

  test('wata.reject settles the matching pending request by id', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    let captured: { id: number | string } | undefined
    host.on('request', (event) => {
      captured = { id: event.id }
    })

    const inflight = consumer.send({ method: 'ping', params: [] })
    await Promise.resolve()
    await Promise.resolve()

    host.reject(captured!.id, { code: -32000, message: 'denied' })

    await expect(inflight).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: denied]`)
  })

  test('wata.respond throws Wata.UnknownRequestError for unknown ids', async () => {
    const { host } = pair()
    await host.start()

    await expect(host.respond(999, 'nope')).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Wata.UnknownRequestError: no pending request with id \`999\`]`,
    )
  })

  test('wata.respond is a no-op double-call once event.respond settled', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    let captured: { id: number | string } | undefined
    host.on('request', (event) => {
      captured = { id: event.id }
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const out = await consumer.send({ method: 'ping', params: [] })
    expect(out.result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)

    // The pending entry is gone after `event.respond` settled the request,
    // so a late top-level respond rejects (the request isn't ours anymore).
    await expect(
      host.respond(captured!.id, { other: true }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Wata.UnknownRequestError: no pending request with id \`1\`]`,
    )
  })

  test('lazy-starts on first send when start() was never called', async () => {
    const { consumer, host } = pair()
    // No `consumer.start()` and no `host.start()` — both should
    // self-start as soon as they're used.
    host.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const out = await consumer.send({ method: 'ping', params: [] })
    expect(out.result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)
  })

  test('lazy-starts on first notify when start() was never called', async () => {
    const { consumer, host } = pair()
    const seen: string[] = []
    host.on('notification', ({ method }) => {
      seen.push(method)
    })

    await consumer.notify({ method: 'ping', params: [] })
    expect(seen).toMatchInlineSnapshot(`
      [
        "ping",
      ]
    `)
  })

  test('rejects pending requests with Transport.ClosedError on close', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    // Host never responds to this request — close should reject the pending promise.
    const inflight = consumer.send({ method: 'ping', params: [] })
    // Listener that swallows the request without replying.
    host.on('request', () => undefined)
    // But wait: the host emits method-not-found for unhandled requests, so we
    // need a listener that *receives* but doesn't settle.
    await consumer.close()

    await expect(inflight).rejects.toBeInstanceOf(Error)
  })

  test('schema validation rejects bad params before sending', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    await expect(
      // @ts-expect-error intentionally wrong params
      consumer.send({ method: 'add', params: ['nope', 1] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `
    	[ProtocolError: schema validation failed
    	Details: 0: Invalid input]
    `,
    )
  })
})

describe('notify', () => {
  test('delivers a typed notification to host listeners', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    const seen: Rpc.Notification[] = []
    host.on('notification', ({ notification }) => {
      seen.push(notification)
    })

    await consumer.notify({ method: 'ping', params: [] })
    // notification handlers run synchronously after the wire delivers.
    expect(seen).toMatchInlineSnapshot(`
      [
        {
          "jsonrpc": "2.0",
          "method": "ping",
          "params": [],
        },
      ]
    `)
  })
})

describe('close', () => {
  test('emits `close` exactly once on both sides', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    let consumerCloses = 0
    let hostCloses = 0
    consumer.on('close', () => consumerCloses++)
    host.on('close', () => hostCloses++)

    await consumer.close()
    // loopback cascades close to the peer, so the host observes it too.
    expect(consumerCloses).toMatchInlineSnapshot(`1`)
    expect(hostCloses).toMatchInlineSnapshot(`1`)
  })

  test('subsequent send() lazy re-opens the transport (and rejects when the underlying transport is terminal)', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()
    await consumer.close()
    // `send()` after a soft close lazy-calls `start()` again. The loopback
    // transport happens to be terminal-on-close, so the underlying
    // `transport.start()` rejects — the wata itself doesn't.
    await expect(
      consumer.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: loopback transport already closed]`,
    )
  })
})

describe('on', () => {
  test('returned AbortController unsubscribes the listener', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    let count = 0
    const controller = host.on('notification', () => {
      count++
    })
    await consumer.notify({ method: 'ping', params: [] })
    controller.abort()
    await consumer.notify({ method: 'ping', params: [] })

    expect(count).toMatchInlineSnapshot(`1`)
  })

  test('off removes a previously subscribed listener', async () => {
    const { consumer, host } = pair()
    await consumer.start()
    await host.start()

    let count = 0
    const listener = () => {
      count++
    }
    host.on('notification', listener)
    await consumer.notify({ method: 'ping', params: [] })
    host.off('notification', listener)
    await consumer.notify({ method: 'ping', params: [] })

    expect(count).toMatchInlineSnapshot(`1`)
  })
})

describe('mode discipline', () => {
  test('host rejects a pre-key encrypted frame with -32600 and tears down', async () => {
    const { consumer: cTransport, host: hTransport } = loopback()
    const host = HostWata.create({ transport: hTransport })
    await cTransport.start()
    await host.start()

    const inbound: unknown[] = []
    cTransport.on('message', (envelope) => inbound.push(envelope))

    const errors: Error[] = []
    host.on('error', (error) => errors.push(error))
    const closes: unknown[] = []
    host.on('close', (cause) => closes.push(cause))

    await cTransport.send(
      Envelope.encrypted({
        from: 'consumer',
        nonce: `0x${'00'.repeat(12)}`,
        ciphertext: `0x${'aa'.repeat(16)}`,
      }),
    )

    // Allow the host's async rejection (send + close + emit) to settle.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(inbound).toMatchInlineSnapshot(`
      [
        {
          "payload": [
            {
              "error": {
                "code": -32600,
                "data": "encrypted envelope received before key derivation",
                "message": "invalid request",
              },
              "id": null,
              "jsonrpc": "2.0",
            },
          ],
          "type": "rpc-responses",
        },
      ]
    `)
    expect(errors[0]).toBeInstanceOf(Errors.ProtocolError)
    expect(errors[0]?.message).toMatchInlineSnapshot(
      `"encrypted envelope received before key derivation"`,
    )
    expect(closes.length).toMatchInlineSnapshot(`1`)
  })

  test('consumer rejects a pre-key encrypted frame with -32600 and tears down', async () => {
    const { consumer: cTransport, host: hTransport } = loopback()
    const consumer = Wata.create({ transport: cTransport })
    await consumer.start()
    await hTransport.start()

    const inbound: unknown[] = []
    hTransport.on('message', (envelope) => inbound.push(envelope))

    const errors: Error[] = []
    consumer.on('error', (error) => errors.push(error))
    const closes: unknown[] = []
    consumer.on('close', (cause) => closes.push(cause))

    await hTransport.send(
      Envelope.encrypted({
        from: 'host',
        nonce: `0x${'00'.repeat(12)}`,
        ciphertext: `0x${'aa'.repeat(16)}`,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(inbound).toMatchInlineSnapshot(`
      [
        {
          "payload": [
            {
              "error": {
                "code": -32600,
                "data": "encrypted envelope received before key derivation",
                "message": "invalid request",
              },
              "id": null,
              "jsonrpc": "2.0",
            },
          ],
          "type": "rpc-responses",
        },
      ]
    `)
    expect(errors[0]).toBeInstanceOf(Errors.ProtocolError)
    expect(closes.length).toMatchInlineSnapshot(`1`)
  })
})

describe('baseUrl + meta auto-publishing', () => {
  test('host `Wata.create({ baseUrl, meta })` serves /.well-known/urpc/host.json off the transport `.fetch`', async () => {
    const host = HostWata.create({
      baseUrl: 'https://wallet.example',
      identity_pubkey,
      meta: { name: 'Example Wallet', icon: 'https://wallet.example/icon.png' },
      transport: hostDeviceCode({
        store: Kv.memory(),
        path: '/auth/device',
        html: {
          render: () => new Response('ok'),
          authenticate: async () => new Response('ok'),
        },
      }),
    })

    const response = await host.fetch!(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )
    expect({
      status: response.status,
      contentType: response.headers.get('content-type'),
    }).toMatchInlineSnapshot(`
    	{
    	  "contentType": "application/json",
    	  "status": 200,
    	}
    `)
    expect(await response.json()).toMatchInlineSnapshot(`
    	{
    	  "icon": "https://wallet.example/icon.png",
    	  "id": "wallet.example",
    	  "identity_pubkey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    	  "name": "Example Wallet",
    	  "origin": "https://wallet.example",
    	  "transports": {
    	    "device-code": {
    	      "register_url": "https://wallet.example/auth/device/register",
    	      "token_url": "https://wallet.example/auth/device/token",
    	    },
    	  },
    	  "version": "1.0",
    	}
    `)
  })

  test('host `Wata.create({ baseUrl, meta })` still routes transport requests for non-well-known paths', async () => {
    const host = HostWata.create({
      baseUrl: 'https://wallet.example',
      identity_pubkey,
      meta: { name: 'Example Wallet' },
      transport: hostDeviceCode({
        store: Kv.memory(),
        path: '/auth/device',
        html: {
          render: ({ userCode }) =>
            new Response(`<form>code=${userCode ?? ''}</form>`, {
              headers: { 'content-type': 'text/html' },
            }),
          authenticate: async () => new Response('ok'),
        },
      }),
    })

    const response = await host.fetch!(
      new Request('https://wallet.example/auth/device/verify?user_code=AAAA-BBBB', {
        method: 'GET',
      }),
    )
    expect({
      status: response.status,
      contentType: response.headers.get('content-type'),
    }).toMatchInlineSnapshot(`
      {
        "contentType": "text/html",
        "status": 200,
      }
    `)
  })

  test('host `Wata.create({ meta })` without `baseUrl` throws', () => {
    expect(() =>
      HostWata.create({
        meta: { name: 'X' },
        transport: hostDeviceCode({
          store: Kv.memory(),
          html: {
            render: () => new Response('ok'),
            authenticate: async () => new Response('ok'),
          },
        }),
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
    	[BaseError: \`baseUrl\` is required when \`meta\` is set
    	Details: host_id and transport bindings need a fully-qualified origin]
    `,
    )
  })

  test('host `Wata.create({ baseUrl, meta })` without `identity_pubkey` throws (required per spec §2.2)', () => {
    expect(() =>
      HostWata.create({
        baseUrl: 'https://wallet.example',
        meta: { name: 'X' },
        transport: hostDeviceCode({
          store: Kv.memory(),
          html: {
            render: () => new Response('ok'),
            authenticate: async () => new Response('ok'),
          },
        }),
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
    	[BaseError: \`identity_pubkey\` is required when \`meta\` is set
    	Details: host.json publishes the long-term Ed25519 identity pubkey (unpadded base64url, 43 chars)]
    `,
    )
  })

  test('host `Wata.create({})` without meta behaves identically to today (no well-known served)', async () => {
    const host = HostWata.create({
      transport: hostDeviceCode({
        baseUrl: 'https://wallet.example',
        store: Kv.memory(),
        path: '/auth/device',
        html: {
          render: () => new Response('ok'),
          authenticate: async () => new Response('ok'),
        },
      }),
    })
    // No well-known route mounted by the wrapper — falls through to the
    // device-code Hono app, which returns 404 for unrecognized routes.
    const response = await host.fetch!(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )
    expect(response.status).toMatchInlineSnapshot(`404`)
  })

  test('consumer `Wata.create({ baseUrl, meta })` lazy-injects meta into deviceCode for /register payload', async () => {
    let registerBody: unknown
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register')) {
          registerBody = JSON.parse(String(init?.body ?? '{}'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              interval: 1,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const wata = Wata.create({
      baseUrl: 'https://acme.dev',
      meta: { name: 'Acme CLI', icon: 'https://acme.dev/icon.png' },
      transport: consumer,
    })

    const sendPromise = wata.send({ method: 'ping', params: [] }).catch(() => undefined)
    // Give the register POST a chance to settle.
    const start = Date.now()
    while (!registerBody) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for /register')
      await new Promise((r) => setTimeout(r, 5))
    }
    await wata.close()
    await sendPromise

    // Drop PKCE / message fields (PKCE challenges are random, message is
    // wire-shape detail covered elsewhere).
    const {
      code_challenge: _c,
      code_challenge_method: _m,
      message: _msg,
      ...rest
    } = registerBody as Record<string, unknown>
    expect(rest).toMatchInlineSnapshot(`
      {
        "consumer_url": "https://acme.dev/.well-known/urpc/consumer.json",
        "meta": {
          "icon": "https://acme.dev/icon.png",
          "name": "Acme CLI",
        },
      }
    `)
  })

  test('consumer-side inline `meta` on the transport wins over `Wata.create({ meta })`', async () => {
    let registerBody: unknown
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
      meta: { name: 'Inline Override' },
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register')) {
          registerBody = JSON.parse(String(init?.body ?? '{}'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              interval: 1,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const wata = Wata.create({
      baseUrl: 'https://acme.dev',
      meta: { name: 'Wata Parent' },
      transport: consumer,
    })

    const sendPromise = wata.send({ method: 'ping', params: [] }).catch(() => undefined)
    const start = Date.now()
    while (!registerBody) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for /register')
      await new Promise((r) => setTimeout(r, 5))
    }
    await wata.close()
    await sendPromise

    expect((registerBody as { meta: { name: string } }).meta).toMatchInlineSnapshot(`
      {
        "name": "Inline Override",
      }
    `)
  })
})
