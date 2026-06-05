import { Base64, Bytes } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Discovery, Envelope, Rpc, Wata, mobileWebAuth } from 'wata'
import { MobileWebAuth, Wata as HostWata, mobileWebAuth as hostMobileWebAuth } from 'wata/host'

const callback = 'com.example.app:/auth'
const consumerOrigin = 'https://app.example'
const hostOrigin = 'https://wallet.example'

function hostDocument(): Discovery.HostDocument {
  return {
    id: 'wallet',
    identity_pubkey: Base64.fromBytes(Bytes.random(32), { pad: false, url: true }),
    name: 'Wallet',
    origin: hostOrigin,
    transports: {
      'mobile-web-auth': { auth_url: `${hostOrigin}/auth/mobile` },
    },
    version: '1.0',
  }
}

function consumerDocument(callbackUrls: readonly string[] = [callback]): unknown {
  return {
    callback_urls: callbackUrls,
    id: 'app',
    name: 'App',
    origin: consumerOrigin,
    version: '1.0',
  }
}

function pair(
  options: {
    authorizationRequest?: ((url: URL) => void) | undefined
    callbackResult?: ((url: URL) => void) | undefined
    callbackUrls?: readonly string[] | undefined
  } = {},
) {
  let authorizationUrl: string | undefined
  let authResponse: { location: string | null; status: number } | undefined
  const host = hostMobileWebAuth({
    fetch: async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${consumerOrigin}/.well-known/urpc/consumer.json`)
        return Response.json(consumerDocument(options.callbackUrls))
      throw new Error(`unexpected fetch to ${url}`)
    },
    html: {
      authenticate: ({ actions }) => actions.approve(),
    },
    path: '/auth/mobile',
  })
  const consumer = mobileWebAuth({
    callback,
    host: hostDocument(),
    openAuthSession: async (session) => {
      const authorization = new URL(session.authorizationUrl)
      options.authorizationRequest?.(authorization)
      authorizationUrl = authorization.toString()
      const response = await host.fetch(new Request(authorization.toString()))
      const location = response.headers.get('location')
      authResponse = { location, status: response.status }
      if (!location) return undefined
      if (options.callbackResult) {
        const url = new URL(location)
        options.callbackResult(url)
        return url.toString()
      }
      return location
    },
  })
  return {
    authResponse: () => authResponse,
    authorizationUrl: () => authorizationUrl,
    consumer,
    host,
  }
}

async function authorizationFrom(
  envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' }>,
): Promise<MobileWebAuth.Authorization> {
  let authorization: MobileWebAuth.Authorization | undefined
  const consumer = mobileWebAuth({
    callback,
    host: hostDocument(),
    id: consumerOrigin,
    openAuthSession: async (session) => {
      authorization = MobileWebAuth.parseAuthorization(session.authorizationUrl)
      return MobileWebAuth.errorUrl({
        authorization,
        error: { code: -32600, message: 'done' },
      })
    },
  })
  consumer.on('message', () => {})
  await consumer.send(envelope)
  if (!authorization) throw new Error('Expected authorization URL to be opened.')
  return authorization
}

async function callbackEnvelope(options: {
  envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' }>
  id?: Rpc.Id | null | undefined
  result: unknown
}): Promise<Envelope.Envelope | undefined> {
  const { envelope, id, result } = options
  let message: Envelope.Envelope | undefined
  const consumer = mobileWebAuth({
    callback,
    host: hostDocument(),
    id: consumerOrigin,
    openAuthSession: (session) => {
      const authorization = MobileWebAuth.parseAuthorization(session.authorizationUrl)
      return MobileWebAuth.successUrl({
        authorization,
        id,
        result,
      })
    },
  })
  consumer.on('message', (envelope) => {
    message = envelope
  })
  await consumer.send(envelope)
  return message
}

describe('mobileWebAuth', () => {
  test('host helpers parse authorization URLs and extract the first request', async () => {
    const authorization = await authorizationFrom(
      Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]),
    )
    const request = MobileWebAuth.firstRequest(authorization.message)

    expect({
      callback: authorization.callback,
      id: authorization.id,
      method: request?.method,
      params: request?.params,
      stateLength: Base64.toBytes(authorization.state).length,
    }).toMatchInlineSnapshot(`
      {
        "callback": "com.example.app:/auth",
        "id": "https://app.example",
        "method": "ping",
        "params": [],
        "stateLength": 32,
      }
    `)
  })

  test('serializes and restores authorization records', async () => {
    const authorization = await authorizationFrom(
      Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]),
    )

    const restored = MobileWebAuth.parseSerializedAuthorization(
      MobileWebAuth.serializeAuthorization(authorization),
    )

    expect({
      callback: restored.callback,
      id: restored.id,
      message: restored.message,
      publicKeySize: Bytes.from(restored.publicKey).length,
      stateLength: Base64.toBytes(restored.state).length,
    }).toMatchInlineSnapshot(`
      {
        "callback": "com.example.app:/auth",
        "id": "https://app.example",
        "message": {
          "payload": [
            {
              "id": 1,
              "jsonrpc": "2.0",
              "method": "ping",
              "params": [],
            },
          ],
          "type": "rpc-requests",
        },
        "publicKeySize": 32,
        "stateLength": 32,
      }
    `)
  })

  test('rejects malformed serialized authorization records', () => {
    expect(() => MobileWebAuth.parseSerializedAuthorization('')).toThrowErrorMatchingInlineSnapshot(
      `[MobileWebAuth.PreVerificationError: authorization must be valid JSON]`,
    )
    expect(() =>
      MobileWebAuth.parseSerializedAuthorization(
        JSON.stringify({
          callback,
          id: consumerOrigin,
          message: Envelope.rpcResponses([Rpc.success({ id: 1, result: null })]),
          publicKey: `0x${'00'.repeat(32)}`,
          state: Base64.fromBytes(Bytes.random(32), { pad: false, url: true }),
        }),
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `[MobileWebAuth.PreVerificationError: authorization must be a serialized mobile-web-auth request
Details: message.payload.0: Invalid input; message.type: Invalid input]`,
    )
    expect(() =>
      MobileWebAuth.parseSerializedAuthorization(
        JSON.stringify({
          callback,
          id: consumerOrigin,
          message: Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]),
          publicKey: '0x1234',
          state: Base64.fromBytes(Bytes.random(32), { pad: false, url: true }),
        }),
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `[MobileWebAuth.PreVerificationError: authorization must be a serialized mobile-web-auth request
Details: publicKey: Invalid input]`,
    )
    expect(() =>
      MobileWebAuth.parseSerializedAuthorization(
        JSON.stringify({
          callback,
          id: consumerOrigin,
          message: Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]),
          publicKey: `0x${'00'.repeat(32)}`,
          state: Base64.fromBytes(Bytes.random(8), { pad: false, url: true }),
        }),
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `[MobileWebAuth.PreVerificationError: authorization must be a serialized mobile-web-auth request
Details: state: expected at least 128 bits of base64url entropy]`,
    )
  })

  test('host helpers build encrypted success callbacks with default and explicit ids', async () => {
    const envelope_default = await callbackEnvelope({
      envelope: Envelope.rpcRequests([Rpc.request({ id: 1, method: 'one', params: [] })]),
      result: { ok: 'default' },
    })
    const envelope_explicit = await callbackEnvelope({
      envelope: Envelope.rpcRequests([
        Rpc.request({ id: 1, method: 'one', params: [] }),
        Rpc.request({ id: 2, method: 'two', params: [] }),
      ]),
      id: 2,
      result: { ok: 'explicit' },
    })

    expect({ envelope_default, envelope_explicit }).toMatchInlineSnapshot(`
      {
        "envelope_default": {
          "payload": [
            {
              "id": 1,
              "jsonrpc": "2.0",
              "result": {
                "ok": "default",
              },
            },
          ],
          "type": "rpc-responses",
        },
        "envelope_explicit": {
          "payload": [
            {
              "id": 2,
              "jsonrpc": "2.0",
              "result": {
                "ok": "explicit",
              },
            },
          ],
          "type": "rpc-responses",
        },
      }
    `)
  })

  test('responseUrl rejects non-response envelopes', async () => {
    const authorization = await authorizationFrom(
      Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]),
    )

    expect(() =>
      MobileWebAuth.responseUrl({
        authorization,
        response: Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]),
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[ProtocolError: mobile-web-auth callback response must be rpc-responses]`,
    )
  })

  test('end-to-end approval delivers an encrypted callback response', async () => {
    const { authorizationUrl, consumer, host } = pair()
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      meta: { name: 'App' },
      transports: [consumer],
    })
    const hostWata = HostWata.create({ transports: [host] })
    hostWata.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const { result } = await wata.send({ method: 'ping', params: [] })
    const url = new URL(authorizationUrl()!)

    expect({
      callback: url.searchParams.get('callback'),
      hasMessage: url.searchParams.has('message'),
      id: url.searchParams.get('id'),
      result,
      version: url.searchParams.get('version'),
    }).toMatchInlineSnapshot(`
      {
        "callback": "com.example.app:/auth",
        "hasMessage": true,
        "id": "https://app.example",
        "result": {
          "ok": true,
        },
        "version": "1",
      }
    `)
  })

  test('host renders a browser error instead of redirecting before callback verification', async () => {
    const { authResponse, consumer, host } = pair({ callbackUrls: ['com.example.other:/auth'] })
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      meta: { name: 'App' },
      transports: [consumer],
    })
    HostWata.create({ transports: [host] })

    await expect(
      wata.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Rpc.RpcError: User cancelled the mobile-web-auth session.]`,
    )
    expect(authResponse()).toMatchInlineSnapshot(`
      {
        "location": null,
        "status": 403,
      }
    `)
  })

  test('host ignores custom pre-verification error redirects', async () => {
    const host = hostMobileWebAuth({
      fetch: async () => Response.json(consumerDocument(['com.example.other:/auth'])),
      html: {
        authenticate: ({ actions }) => actions.approve(),
        renderError: () => new Response(null, { headers: { location: callback }, status: 302 }),
      },
      path: '/auth/mobile',
    })
    const consumer = mobileWebAuth({
      callback,
      host: hostDocument(),
      openAuthSession: async (session) => {
        const response = await host.fetch(new Request(session.authorizationUrl))
        return response.headers.get('location') ?? undefined
      },
    })
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      meta: { name: 'App' },
      transports: [consumer],
    })
    HostWata.create({ transports: [host] })

    await expect(
      wata.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Rpc.RpcError: User cancelled the mobile-web-auth session.]`,
    )
  })

  test('host-side denial returns JSON-RPC -32600 through the callback', async () => {
    let authorizationUrl: string | undefined
    const host = hostMobileWebAuth({
      fetch: async () => Response.json(consumerDocument()),
      html: {
        authenticate: ({ actions }) => actions.deny(),
      },
      path: '/auth/mobile',
    })
    const consumer = mobileWebAuth({
      callback,
      host: hostDocument(),
      openAuthSession: async (session) => {
        authorizationUrl = session.authorizationUrl
        const response = await host.fetch(new Request(session.authorizationUrl))
        return response.headers.get('location') ?? undefined
      },
    })
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      meta: { name: 'App' },
      transports: [consumer],
    })
    HostWata.create({ transports: [host] })

    await expect(
      wata.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: User denied the request.]`)
    expect(new URL(authorizationUrl!).searchParams.get('callback')).toMatchInlineSnapshot(
      `"com.example.app:/auth"`,
    )
  })

  test('renders an approval page before a later form submission approves', async () => {
    let renderedState: string | undefined
    const host = hostMobileWebAuth({
      fetch: async () => Response.json(consumerDocument()),
      html: {
        authenticate: async ({ actions, request }) => {
          const form = await request.formData()
          return await actions.approve(String(form.get('state')))
        },
        render: ({ authorization }) => {
          renderedState = authorization.state
          return new Response(authorization.state)
        },
      },
      path: '/auth/mobile',
    })
    const consumer = mobileWebAuth({
      callback,
      host: hostDocument(),
      openAuthSession: async (session) => {
        const get = await host.fetch(new Request(session.authorizationUrl))
        const state = await get.text()
        const form = new FormData()
        form.set('state', state)
        const post = await host.fetch(
          new Request(`${hostOrigin}/auth/mobile`, {
            body: form,
            method: 'POST',
          }),
        )
        return post.headers.get('location') ?? undefined
      },
    })
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      meta: { name: 'App' },
      transports: [consumer],
    })
    const hostWata = HostWata.create({ transports: [host] })
    hostWata.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const { result } = await wata.send({ method: 'ping', params: [] })

    expect({
      renderedStateLength: renderedState ? Base64.toBytes(renderedState).length : undefined,
      result,
    }).toMatchInlineSnapshot(`
      {
        "renderedStateLength": 32,
        "result": {
          "ok": true,
        },
      }
    `)
  })

  test('host renders a browser error when authorization request omits message', async () => {
    const { authResponse, consumer, host } = pair({
      authorizationRequest(url) {
        url.searchParams.delete('message')
      },
    })
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      meta: { name: 'App' },
      transports: [consumer],
    })
    HostWata.create({ transports: [host] })

    await expect(
      wata.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Rpc.RpcError: User cancelled the mobile-web-auth session.]`,
    )
    expect(authResponse()).toMatchInlineSnapshot(`
      {
        "location": null,
        "status": 400,
      }
    `)
  })

  test('consumer rejects a callback whose state does not match the pending session', async () => {
    const { consumer, host } = pair({
      callbackResult(url) {
        url.searchParams.set('state', 'mismatched')
      },
    })
    const wata = Wata.create({
      baseUrl: consumerOrigin,
      meta: { name: 'App' },
      transports: [consumer],
    })
    const hostWata = HostWata.create({ transports: [host] })
    hostWata.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    await expect(
      wata.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: Mobile-web-auth state mismatch.]`)
  })

  test('consumer rejects duplicate callback protocol parameters', async () => {
    const results: string[] = []
    for (const key of ['message', 'pubkey', 'state', 'version'] as const) {
      const { consumer, host } = pair({
        callbackResult(url) {
          url.searchParams.append(key, url.searchParams.get(key) ?? 'duplicate')
        },
      })
      const wata = Wata.create({
        baseUrl: consumerOrigin,
        meta: { name: 'App' },
        transports: [consumer],
      })
      const hostWata = HostWata.create({ transports: [host] })
      hostWata.on('request', (event) => {
        if (event.method === 'ping') event.respond({ ok: true })
      })

      await wata.send({ method: 'ping', params: [] }).catch((cause) => {
        results.push(`${key}: ${String(cause)}`)
      })
    }

    expect(results).toMatchInlineSnapshot(`
      [
        "message: Rpc.RpcError: Mobile-web-auth callback missing fields.",
        "pubkey: Rpc.RpcError: Mobile-web-auth callback missing fields.",
        "state: Rpc.RpcError: Mobile-web-auth state mismatch.",
        "version: Rpc.RpcError: Unsupported mobile-web-auth version.",
      ]
    `)
  })

  test('consumer discovery accepts private-use callback URI allowlist entries', () => {
    const document = Discovery.parseConsumer(consumerDocument())
    expect(document.callback_urls).toMatchInlineSnapshot(`
      [
        "com.example.app:/auth",
      ]
    `)
  })

  test('consumer discovery rejects non-private callback URI schemes', () => {
    expect(() => Discovery.parseConsumer(consumerDocument(['javascript:alert(1)']))).toThrowError(
      Error,
    )
  })
})
