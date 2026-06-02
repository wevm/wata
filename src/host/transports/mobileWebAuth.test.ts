import { Base64, Bytes } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Discovery, Wata, mobileWebAuth } from 'wata'
import { Wata as HostWata, mobileWebAuth as hostMobileWebAuth } from 'wata/host'

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

describe('mobileWebAuth', () => {
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
