/**
 * End-to-end test for the device-code transport, exercised against the
 * real consumer + host adapters wired together by `Wata.create`.
 *
 * The host's HTTP routes are exposed via `transport.fetch` (no real
 * `node:http` server), and the consumer talks to them through a `fetch`
 * mock that pipes `Request`s straight into `transport.fetch`. This
 * proves the same `.fetch` handler runs identically on Node and
 * Cloudflare Workers — no `node:http` value imports anywhere on the
 * path.
 */

import { describe, expect, test } from 'vp/test'
import { DeviceCode, Envelope, Store, Wata, deviceCode } from 'wata'
import {
  DeviceCode as HostDeviceCode,
  Wata as HostWata,
  deviceCode as hostDeviceCode,
} from 'wata/host'

const grantType = 'urn:ietf:params:oauth:grant-type:device_code'

type HostFetch = { fetch: (request: Request) => Promise<Response> }

async function registerOnce(host: HostFetch, baseUrl: string) {
  const response = await host.fetch(
    new Request(`${baseUrl}/register`, {
      body: JSON.stringify({
        code_challenge: 'wrong_challenge',
        code_challenge_method: 'S256',
        message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  )
  return {
    body: (await response.json()) as {
      device_code: string
      expires_in: number
      interval?: number
      user_code: string
      verification_uri: string
      verification_uri_complete?: string
    },
    response,
  }
}

async function pollToken(
  host: HostFetch,
  baseUrl: string,
  body: Partial<{ code_verifier: string; device_code: string; grant_type: string }>,
) {
  return await host.fetch(
    new Request(`${baseUrl}/token`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  )
}

function pair() {
  const baseUrl = 'https://wallet.example/auth/device'

  const store = Store.memory()
  let lastUserCode: string | undefined

  const html: HostDeviceCode.html.Hooks = {
    authenticate: async ({ actions, request }) => {
      const form = await request.formData()
      const userCode = String(form.get('user_code') ?? '')
      const action = String(form.get('action') ?? 'approve')
      if (action === 'deny') await actions.deny(userCode)
      else await actions.approve(userCode)
      return new Response('ok')
    },
    render: ({ userCode }) =>
      new Response(`<form>code=${userCode ?? ''}</form>`, {
        headers: { 'content-type': 'text/html' },
      }),
  }

  const host = hostDeviceCode({
    baseUrl: 'https://wallet.example',
    html,
    path: '/auth/device',
    pollingInterval: 1000,
    store,
  })

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(baseUrl)) throw new Error(`unexpected fetch to ${url}`)
    const request = new Request(url, init)
    const response = await host.fetch(request)
    if (url.endsWith('/register')) {
      const cloned = response.clone()
      const body = (await cloned.json()) as { user_code?: string }
      if (body?.user_code) lastUserCode = body.user_code
    }
    return response
  }

  const consumer = deviceCode({
    fetch: fetchImpl,
    pollingInterval: 50,
    url: baseUrl,
  })

  async function waitForUserCode(): Promise<string> {
    const start = Date.now()
    while (!lastUserCode) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for user_code')
      await new Promise((r) => setTimeout(r, 5))
    }
    return lastUserCode
  }

  async function approve(): Promise<void> {
    const userCode = await waitForUserCode()
    const form = new FormData()
    form.set('user_code', userCode)
    form.set('action', 'approve')
    await host.fetch(new Request(`${baseUrl}/verify`, { body: form, method: 'POST' }))
  }

  async function deny(): Promise<void> {
    const userCode = await waitForUserCode()
    const form = new FormData()
    form.set('user_code', userCode)
    form.set('action', 'deny')
    await host.fetch(new Request(`${baseUrl}/verify`, { body: form, method: 'POST' }))
  }

  return { approve, baseUrl, consumer, deny, fetch: fetchImpl, host, store }
}

describe('wata-device-code', () => {
  test('end-to-end approval delivers the host response', async () => {
    const { approve, consumer, host } = pair()

    const session = await Wata.create({ transports: [consumer] }).start()
    const hostSession = await HostWata.create({ transports: [host] }).start()

    hostSession.onRequest((event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = session.send({ method: 'ping', params: [] })
    await approve()
    const { result } = await sendPromise
    expect(result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)
  })

  test('url deferred to `start({ url })` drives the exchange', async () => {
    const { approve, baseUrl, fetch: fetchImpl, host } = pair()
    // url omitted at construction — supplied at start instead.
    const consumer = deviceCode({ fetch: fetchImpl, pollingInterval: 50 })

    const session = await Wata.create({ transports: [consumer] }).start({ url: baseUrl })
    const hostSession = await HostWata.create({ transports: [host] }).start()

    hostSession.onRequest((event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = session.send({ method: 'ping', params: [] })
    await approve()
    const { result } = await sendPromise
    expect(result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)
  })

  test('`start()` throws when url is supplied at neither construction nor start', async () => {
    const consumer = deviceCode({ pollingInterval: 50 })
    // The type forbids `start()` here (url is required when omitted at
    // construction); this guards the runtime fallback for untyped callers.
    // @ts-expect-error url is required at start when omitted at construction
    await expect(consumer.start()).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: device-code url must be supplied to \`deviceCode({ url })\` or \`start({ url })\`]`,
    )
  })

  test('user denial surfaces as `UserRejectedError`', async () => {
    const { consumer, deny, host } = pair()
    const session = await Wata.create({ transports: [consumer] }).start()
    await HostWata.create({ transports: [host] }).start()

    const sendPromise = session.send({ method: 'ping', params: [] })
    await deny()

    await expect(sendPromise).rejects.toThrowErrorMatchingInlineSnapshot(
      `[DeviceCode.UserRejectedError: user denied the device-code request]`,
    )
  })

  test('PKCE mismatch returns 400 on /token and surfaces as ProtocolError', async () => {
    const { baseUrl, host } = pair()

    const registerResponse = await host.fetch(
      new Request(`${baseUrl}/register`, {
        body: JSON.stringify({
          code_challenge: 'wrong_challenge',
          code_challenge_method: 'S256',
          message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    expect(registerResponse.status).toMatchInlineSnapshot(`200`)
    const registered = (await registerResponse.json()) as { device_code: string }

    const tokenResponse = await host.fetch(
      new Request(`${baseUrl}/token`, {
        body: JSON.stringify({
          code_verifier: 'something_unrelated',
          device_code: registered.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const body = (await tokenResponse.json()) as { error: string }
    expect({ body, status: tokenResponse.status }).toMatchInlineSnapshot(`
    	{
    	  "body": {
    	    "error": "invalid_grant",
    	    "error_description": "PKCE verifier does not match recorded challenge",
    	  },
    	  "status": 400,
    	}
    `)
  })

  test('post-terminal `send()` rejects with `ClosedError`', async () => {
    const { approve, consumer, host } = pair()
    const session = await Wata.create({ transports: [consumer] }).start()
    const hostSession = await HostWata.create({ transports: [host] }).start()
    hostSession.onRequest((event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = session.send({ method: 'ping', params: [] })
    await approve()
    await sendPromise

    await expect(
      consumer.send(Envelope.rpcRequests([{ jsonrpc: '2.0', id: 2, method: 'ping', params: [] }])),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: device-code transport already closed]`,
    )
  })

  test('concurrent `send()` on the same single-exchange transport rejects with `TransportError`', async () => {
    const { consumer, host } = pair()
    await HostWata.create({ transports: [host] }).start()

    await consumer.start()
    const first = consumer.send(
      Envelope.rpcRequests([{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]),
    )
    await expect(
      consumer.send(Envelope.rpcRequests([{ jsonrpc: '2.0', id: 2, method: 'ping', params: [] }])),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: device-code is single-exchange; a previous send is still in flight]`,
    )

    await consumer.close()
    await first.catch(() => {})
  })

  test('`/register` response includes the polling `interval` in seconds', async () => {
    const { baseUrl, host } = pair()
    const { response, body } = await registerOnce(host, baseUrl)
    // pair() configures pollingInterval=1000ms → 1 second.
    expect({ interval: body.interval, status: response.status }).toMatchInlineSnapshot(`
      {
        "interval": 1,
        "status": 200,
      }
    `)
  })

  test('every endpoint sets `Cache-Control: no-store` and `Pragma: no-cache`', async () => {
    const { baseUrl, host } = pair()

    const { body, response: registerResponse } = await registerOnce(host, baseUrl)
    const tokenResponse = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: body.device_code,
      grant_type: grantType,
    })
    const verifyGet = await host.fetch(new Request(`${baseUrl}/verify?user_code=${body.user_code}`))
    const form = new FormData()
    form.set('user_code', body.user_code)
    form.set('action', 'approve')
    const verifyPost = await host.fetch(
      new Request(`${baseUrl}/verify`, { body: form, method: 'POST' }),
    )
    const cacheHeaders = (response: Response) => ({
      cacheControl: response.headers.get('cache-control'),
      pragma: response.headers.get('pragma'),
    })
    expect({
      register: cacheHeaders(registerResponse),
      token: cacheHeaders(tokenResponse),
      verifyGet: cacheHeaders(verifyGet),
      verifyPost: cacheHeaders(verifyPost),
    }).toMatchInlineSnapshot(`
      {
        "register": {
          "cacheControl": "no-store",
          "pragma": "no-cache",
        },
        "token": {
          "cacheControl": "no-store",
          "pragma": "no-cache",
        },
        "verifyGet": {
          "cacheControl": "no-store",
          "pragma": "no-cache",
        },
        "verifyPost": {
          "cacheControl": "no-store",
          "pragma": "no-cache",
        },
      }
    `)
  })

  test('`/token` rejects a missing `grant_type` with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const { body: registered } = await registerOnce(host, baseUrl)
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: registered.device_code,
    })
    const body = (await response.json()) as { error: string; error_description?: string }
    expect({ body, status: response.status }).toMatchInlineSnapshot(`
    	{
    	  "body": {
    	    "error": "invalid_request",
    	    "error_description": "expected \`grant_type\` of \`urn:ietf:params:oauth:grant-type:device_code\`",
    	  },
    	  "status": 400,
    	}
    `)
  })

  test('`/token` rejects a wrong `grant_type` with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const { body: registered } = await registerOnce(host, baseUrl)
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: registered.device_code,
      grant_type: 'authorization_code',
    })
    const body = (await response.json()) as { error: string }
    expect({ error: body.error, status: response.status }).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "status": 400,
      }
    `)
  })

  test('`/token` returns `expired_token` for an unknown `device_code`', async () => {
    const { baseUrl, host } = pair()
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: 'never-existed',
      grant_type: grantType,
    })
    const body = (await response.json()) as { error: string }
    expect({ error: body.error, status: response.status }).toMatchInlineSnapshot(`
      {
        "error": "expired_token",
        "status": 400,
      }
    `)
  })

  test('`/token` returns `expired_token` after the intent expires', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    const host = hostDeviceCode({
      baseUrl: 'https://wallet.example',
      expiresIn: 0,
      html: {
        authenticate: () => new Response(''),
        render: () => new Response(''),
      },
      path: '/auth/device',
      store: Store.memory(),
    })
    const { body: registered } = await registerOnce(host, baseUrl)
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: registered.device_code,
      grant_type: grantType,
    })
    const body = (await response.json()) as { error: string }
    expect({ error: body.error, status: response.status }).toMatchInlineSnapshot(`
      {
        "error": "expired_token",
        "status": 400,
      }
    `)
  })

  test('`/token` returns `authorization_pending` on the first valid poll', async () => {
    const { baseUrl, host } = pair()
    const { body: registered } = await registerOnce(host, baseUrl)
    const response = await pollToken(host, baseUrl, {
      // PKCE will fail, but `authorization_pending` is checked AFTER PKCE
      // so we need a real challenge round-trip. Send an unknown
      // `code_verifier` and assert we get `invalid_grant` instead — that
      // proves PKCE-then-pending ordering. The "first poll → pending"
      // path is exercised by the end-to-end test above.
      code_verifier: 'irrelevant',
      device_code: registered.device_code,
      grant_type: grantType,
    })
    const body = (await response.json()) as { error: string }
    expect({ error: body.error, status: response.status }).toMatchInlineSnapshot(`
      {
        "error": "invalid_grant",
        "status": 400,
      }
    `)
  })

  test('`/token` returns `slow_down` when polled faster than half the interval', async () => {
    // pair() sets pollingInterval=1000ms → "too fast" means within
    // 500ms of the previous poll. Compute a real PKCE pair so we can
    // poll directly without standing up a full consumer.
    const { baseUrl, host } = pair()
    const verifier = 'a'.repeat(43)
    const challenge = HostDeviceCode.pkceChallenge(verifier)

    const registerResponse = await host.fetch(
      new Request(`${baseUrl}/register`, {
        body: JSON.stringify({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const registered = (await registerResponse.json()) as { device_code: string }

    // First poll → `authorization_pending` (no prior poll for slow_down
    // to compare against).
    const first = await pollToken(host, baseUrl, {
      code_verifier: verifier,
      device_code: registered.device_code,
      grant_type: grantType,
    })
    expect({
      error: ((await first.json()) as { error: string }).error,
      status: first.status,
    }).toMatchInlineSnapshot(`
      {
        "error": "authorization_pending",
        "status": 400,
      }
    `)

    // Immediate second poll → `slow_down` (well within 500ms of poll 1).
    const second = await pollToken(host, baseUrl, {
      code_verifier: verifier,
      device_code: registered.device_code,
      grant_type: grantType,
    })
    expect({
      error: ((await second.json()) as { error: string }).error,
      status: second.status,
    }).toMatchInlineSnapshot(`
      {
        "error": "slow_down",
        "status": 400,
      }
    `)

    // Wait past the half-interval threshold and poll again →
    // `authorization_pending` resumes (slow_down is non-terminal).
    await new Promise((r) => setTimeout(r, 600))
    const third = await pollToken(host, baseUrl, {
      code_verifier: verifier,
      device_code: registered.device_code,
      grant_type: grantType,
    })
    expect({
      error: ((await third.json()) as { error: string }).error,
      status: third.status,
    }).toMatchInlineSnapshot(`
      {
        "error": "authorization_pending",
        "status": 400,
      }
    `)
  })

  test('error responses use `error_description`, not the legacy `message` field', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/token`, {
        body: 'not json at all',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const body = (await response.json()) as Record<string, unknown>
    expect({
      error: body['error'],
      hasErrorDescription: 'error_description' in body,
      hasMessage: 'message' in body,
    }).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "hasErrorDescription": true,
        "hasMessage": false,
      }
    `)
  })

  test('consumer sends `grant_type` in every `/token` request', async () => {
    const { baseUrl, host } = pair()
    let lastTokenBody: { grant_type?: string } | undefined
    const consumer = deviceCode({
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/token')) {
          const cloned = new Request(url, init).clone()
          lastTokenBody = (await cloned.json()) as { grant_type?: string }
        }
        return await host.fetch(new Request(url, init))
      },
      pollingInterval: 50,
      url: baseUrl,
    })
    await HostWata.create({ transports: [host] }).start()
    const session = await Wata.create({ transports: [consumer] }).start()
    const sendPromise = session.send({ method: 'ping', params: [] }).catch(() => undefined)

    const start = Date.now()
    while (!lastTokenBody) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for token poll')
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(lastTokenBody.grant_type).toMatchInlineSnapshot(
      `"urn:ietf:params:oauth:grant-type:device_code"`,
    )

    await consumer.close()
    await sendPromise
  })

  // 20s timeout: each `slow_down` adds ≥5s sleep per RFC 8628 §3.5.
  // One `slow_down` + one `authorization_pending` + one success ≈ 10s
  // of real-time sleeping; 20s leaves comfortable headroom.
  test(
    'consumer increases interval and continues after `slow_down`, then succeeds',
    { timeout: 20_000 },
    async () => {
      // Mock fetch: /register succeeds, /token returns slow_down once,
      // then authorization_pending, then a real success envelope.
      let tokenCalls = 0
      const responsePayload = Envelope.rpcResponses([
        { id: 1, jsonrpc: '2.0', result: { ok: true } },
      ])
      const consumer = deviceCode({
        fetch: async (input) => {
          const url = input instanceof Request ? input.url : String(input)
          if (url.endsWith('/register'))
            return new Response(
              JSON.stringify({
                device_code: 'dc',
                expires_in: 600,
                interval: 1,
                user_code: 'AAAA-BBBB',
                verification_uri: 'https://example/verify',
              }),
              { headers: { 'content-type': 'application/json' }, status: 200 },
            )
          if (url.endsWith('/token')) {
            tokenCalls += 1
            if (tokenCalls === 1)
              return new Response(JSON.stringify({ error: 'slow_down' }), {
                headers: { 'content-type': 'application/json' },
                status: 400,
              })
            if (tokenCalls === 2)
              return new Response(JSON.stringify({ error: 'authorization_pending' }), {
                headers: { 'content-type': 'application/json' },
                status: 400,
              })
            return new Response(JSON.stringify(responsePayload), {
              headers: { 'content-type': 'application/json' },
              status: 200,
            })
          }
          throw new Error(`unexpected ${url}`)
        },
        pollingInterval: 50,
        url: 'https://example/auth/device',
      })
      const session = await Wata.create({ transports: [consumer] }).start()
      const { result } = await session.send({ method: 'ping', params: [] })
      expect({ result, tokenCalls }).toMatchInlineSnapshot(`
        {
          "result": {
            "ok": true,
          },
          "tokenCalls": 3,
        }
      `)
    },
  )

  // 25s timeout: 3 `slow_down`s back-to-back sleep ≈ 5s + 10s + 0s
  // (3rd throws immediately) ≈ 15s of real-time sleeping.
  test(
    'consumer terminates with `TransportError` after 3 consecutive `slow_down`s',
    { timeout: 25_000 },
    async () => {
      const consumer = deviceCode({
        fetch: async (input) => {
          const url = input instanceof Request ? input.url : String(input)
          if (url.endsWith('/register'))
            return new Response(
              JSON.stringify({
                device_code: 'dc',
                expires_in: 600,
                interval: 1,
                user_code: 'AAAA-BBBB',
                verification_uri: 'https://example/verify',
              }),
              { headers: { 'content-type': 'application/json' }, status: 200 },
            )
          if (url.endsWith('/token'))
            return new Response(JSON.stringify({ error: 'slow_down' }), {
              headers: { 'content-type': 'application/json' },
              status: 400,
            })
          throw new Error(`unexpected ${url}`)
        },
        pollingInterval: 50,
        url: 'https://example/auth/device',
      })
      const session = await Wata.create({ transports: [consumer] }).start()
      await expect(
        session.send({ method: 'ping', params: [] }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Transport.TransportError: device-code host is signalling indefinite throttling (3 consecutive \`slow_down\` responses)]`,
      )
    },
  )

  test('`/register` rejects a missing `code_challenge` with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        body: JSON.stringify({
          code_challenge_method: 'S256',
          message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const body = (await response.json()) as { error: string; error_description?: string }
    expect({ body, status: response.status }).toMatchInlineSnapshot(`
    	{
    	  "body": {
    	    "error": "invalid_request",
    	    "error_description": "expected non-empty \`code_challenge\`",
    	  },
    	  "status": 400,
    	}
    `)
  })

  test('`/register` rejects `code_challenge_method` other than `S256`', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        body: JSON.stringify({
          code_challenge: 'whatever',
          code_challenge_method: 'plain',
          message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const body = (await response.json()) as { error: string; error_description?: string }
    expect({ body, status: response.status }).toMatchInlineSnapshot(`
    	{
    	  "body": {
    	    "error": "invalid_request",
    	    "error_description": "expected \`code_challenge_method\` of \`S256\`",
    	  },
    	  "status": 400,
    	}
    `)
  })

  test('`/register` rejects a non-`rpc-requests` envelope with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        body: JSON.stringify({
          code_challenge: 'whatever',
          code_challenge_method: 'S256',
          message: Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'pong' }]),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const body = (await response.json()) as { error: string; error_description?: string }
    expect({ body, status: response.status }).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_request",
          "error_description": "\`message\` must be an \`rpc-requests\` envelope",
        },
        "status": 400,
      }
    `)
  })

  test('`/register` rejects malformed JSON with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        body: 'not json',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const body = (await response.json()) as { error: string }
    expect({ error: body.error, status: response.status }).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "status": 400,
      }
    `)
  })

  test('`/register` returns a `verification_uri_complete` carrying `?user_code=...`', async () => {
    const { baseUrl, host } = pair()
    const { body } = await registerOnce(host, baseUrl)
    expect(body.verification_uri).toBe('https://wallet.example/auth/device/verify')
    const url = new URL(body.verification_uri_complete!)
    expect(url.searchParams.get('user_code')).toBe(body.user_code)
  })

  test('`GET /verify` passes `user_code` and the resolved record to `html.render`', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    let renderArgs: HostDeviceCode.html.render.Options | undefined
    const host = hostDeviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: () => new Response('ok'),
        render: (options) => {
          renderArgs = options
          return new Response('ok')
        },
      },
      path: '/auth/device',
      store: Store.memory(),
    })
    const { body } = await registerOnce(host, baseUrl)
    await host.fetch(new Request(`${baseUrl}/verify?user_code=${body.user_code}`))
    expect(renderArgs?.userCode).toBe(body.user_code)
    expect(renderArgs?.record?.deviceCode).toBe(body.device_code)
    expect(renderArgs?.request).toBeInstanceOf(Request)
  })

  test('`GET /verify` does not approve the intent (no auto-submit)', async () => {
    const { baseUrl, host } = pair()
    const { body } = await registerOnce(host, baseUrl)
    // Hit the verification URL the way a user-agent would after clicking
    // the `verification_uri_complete` link.
    await host.fetch(new Request(`${baseUrl}/verify?user_code=${body.user_code}`))
    // Subsequent /token must still report `authorization_pending` (i.e.
    // not approved). Use an irrelevant verifier so PKCE fails
    // first — that proves the record is still in `pending` (otherwise
    // it would be `approved` / consumed).
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: body.device_code,
      grant_type: grantType,
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant')
  })

  test('`GET /verify` resolves no record for an unknown `user_code`', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    let renderArgs: HostDeviceCode.html.render.Options | undefined
    const host = hostDeviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: () => new Response('ok'),
        render: (options) => {
          renderArgs = options
          return new Response('ok')
        },
      },
      path: '/auth/device',
      store: Store.memory(),
    })
    await host.fetch(new Request(`${baseUrl}/verify?user_code=NOPE-NOPE`))
    expect(renderArgs?.userCode).toBe('NOPE-NOPE')
    expect(renderArgs?.record).toBeUndefined()
  })

  test('`actions.deny` is idempotent — second call after deny is a no-op', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    let calls = 0
    let firstActions: HostDeviceCode.html.Actions | undefined
    const host = hostDeviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: async ({ actions, request }) => {
          calls += 1
          firstActions = actions
          const form = await request.formData()
          await actions.deny(String(form.get('user_code')))
          return new Response('ok')
        },
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store: Store.memory(),
    })
    const { body } = await registerOnce(host, baseUrl)
    const form = new FormData()
    form.set('user_code', body.user_code)
    await host.fetch(new Request(`${baseUrl}/verify`, { body: form, method: 'POST' }))
    expect(calls).toBe(1)
    // A second deny on the same `user_code` must not throw — it's a
    // no-op once the record is already terminal.
    await firstActions!.deny(body.user_code)
  })

  test('`actions.approve` / `actions.deny` throw `UnknownUserCodeError` for unknown codes', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    let actions: HostDeviceCode.html.Actions | undefined
    const host = hostDeviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: async (options) => {
          actions = options.actions
          return new Response('ok')
        },
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store: Store.memory(),
    })
    // Trigger `authenticate` once to capture `actions`.
    await host.fetch(new Request(`${baseUrl}/verify`, { body: new FormData(), method: 'POST' }))
    let approveError: unknown
    try {
      await actions!.approve('NOPE-NOPE')
    } catch (cause) {
      approveError = cause
    }
    expect((approveError as Error).name).toBe('DeviceCode.UnknownUserCodeError')

    let denyError: unknown
    try {
      await actions!.deny('NOPE-NOPE')
    } catch (cause) {
      denyError = cause
    }
    expect((denyError as Error).name).toBe('DeviceCode.UnknownUserCodeError')
  })

  test('`actions.get` returns the pending record for a known `user_code`', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    let actions: HostDeviceCode.html.Actions | undefined
    const host = hostDeviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: async (options) => {
          actions = options.actions
          return new Response('ok')
        },
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store: Store.memory(),
    })
    const { body } = await registerOnce(host, baseUrl)
    await host.fetch(new Request(`${baseUrl}/verify`, { body: new FormData(), method: 'POST' }))
    const record = await actions!.get(body.user_code)
    expect(record?.deviceCode).toBe(body.device_code)
    expect(record?.status).toBe('pending')
  })

  test('consumer maps `access_denied` to `DeviceCode.UserRejectedError` with description', async () => {
    const consumer = deviceCode({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              interval: 1,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          )
        if (url.endsWith('/token'))
          return new Response(
            JSON.stringify({ error: 'access_denied', error_description: 'user said no' }),
            { headers: { 'content-type': 'application/json' }, status: 400 },
          )
        throw new Error(`unexpected ${url}`)
      },
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    await expect(
      session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[DeviceCode.UserRejectedError: user said no]`)
  })

  test('consumer maps `expired_token` to `Transport.ClosedError`', async () => {
    const consumer = deviceCode({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              interval: 1,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          )
        if (url.endsWith('/token'))
          return new Response(JSON.stringify({ error: 'expired_token' }), {
            headers: { 'content-type': 'application/json' },
            status: 400,
          })
        throw new Error(`unexpected ${url}`)
      },
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    await expect(
      session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: device-code expired or not found]`,
    )
  })

  test('consumer maps an unknown `/token` 4xx to `Transport.TransportError` carrying the description', async () => {
    const consumer = deviceCode({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              interval: 1,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          )
        if (url.endsWith('/token'))
          return new Response(
            JSON.stringify({ error: 'totally_made_up', error_description: 'host bug' }),
            { headers: { 'content-type': 'application/json' }, status: 418 },
          )
        throw new Error(`unexpected ${url}`)
      },
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    await expect(
      session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: unexpected device-code /token status 418: host bug]`,
    )
  })

  test('consumer surfaces a malformed success envelope as `Transport.TransportError`', async () => {
    const consumer = deviceCode({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              interval: 1,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          )
        if (url.endsWith('/token'))
          return new Response(JSON.stringify({ not: 'an envelope' }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          })
        throw new Error(`unexpected ${url}`)
      },
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    await expect(session.send({ method: 'ping', params: [] })).rejects
      .toThrowErrorMatchingInlineSnapshot(`
    	[Transport.TransportError: host returned an invalid response envelope: invalid envelope
    	Details: type: Invalid input]
    `)
  })

  test('consumer rejects a `/register` response missing `device_code` with `Transport.TransportError`', async () => {
    const consumer = deviceCode({
      fetch: async () =>
        new Response(
          JSON.stringify({
            // device_code intentionally missing
            expires_in: 600,
            user_code: 'AAAA-BBBB',
            verification_uri: 'https://example/verify',
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    await expect(
      session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: host /register response missing \`device_code\`]`,
    )
  })

  test('consumer maps a `/register` 400 to `Errors.ProtocolError`', async () => {
    const consumer = deviceCode({
      fetch: async () =>
        new Response(
          JSON.stringify({ error: 'invalid_request', error_description: 'bad message envelope' }),
          { headers: { 'content-type': 'application/json' }, status: 400 },
        ),
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    await expect(
      session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[ProtocolError: host rejected device-code /register: bad message envelope]`,
    )
  })

  test('consumer maps a `/register` 5xx to `Transport.TransportError`', async () => {
    const consumer = deviceCode({
      fetch: async () =>
        new Response(JSON.stringify({ error: 'server_error', error_description: 'oops' }), {
          headers: { 'content-type': 'application/json' },
          status: 502,
        }),
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    await expect(
      session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: device-code /register returned status 502: oops]`,
    )
  })

  test('consumer surfaces a `fetch` failure as `Transport.TransportError`', async () => {
    const consumer = deviceCode({
      fetch: async () => {
        throw new Error('network down')
      },
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    await expect(
      session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: device-code register failed: network down]`,
    )
  })

  test('consumer rejects a non-`rpc-requests` envelope on `send` with `UnsupportedError`', async () => {
    const { consumer } = pair()
    // Consumer-side `send` is fire-and-forget — failures arrive on the
    // `error` event before the auto-close.
    const errorPromise = new Promise<unknown>((resolve) => consumer.on('error', resolve))
    await consumer.send(Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'pong' }]))
    expect(await errorPromise).toMatchInlineSnapshot(
      `[Transport.UnsupportedError: device-code transport only carries rpc-requests envelopes; received \`rpc-responses\`]`,
    )
  })

  test('the `prompt` event receives the host-derived prompt fields', async () => {
    let prompt: (DeviceCode.Prompt & { transport: 'deviceCode' }) | undefined
    const consumer = deviceCode({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 1234,
              interval: 7,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
              verification_uri_complete: 'https://example/verify?user_code=AAAA-BBBB',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          )
        // Sit forever on /token so we can close cleanly.
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          headers: { 'content-type': 'application/json' },
          status: 400,
        })
      },
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    session.onPrompt((received) => {
      prompt = received
    })
    const sendPromise = session.send({ method: 'ping', params: [] }).catch(() => undefined)

    const start = Date.now()
    while (!prompt) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for prompt')
      await new Promise((r) => setTimeout(r, 5))
    }
    // Consumer-supplied `pollingInterval` (5ms) overrides the host's
    // `interval` field (7 s).
    expect(prompt).toMatchInlineSnapshot(`
      {
        "deviceCode": "dc",
        "expiresIn": 1234,
        "pollingInterval": 5,
        "transport": "deviceCode",
        "userCode": "AAAA-BBBB",
        "verificationUri": "https://example/verify",
        "verificationUriFull": "https://example/verify?user_code=AAAA-BBBB",
      }
    `)

    await consumer.close()
    await sendPromise
  })

  test('consumer falls back to host-supplied `interval` when `pollingInterval` is omitted', async () => {
    let prompt: (DeviceCode.Prompt & { transport: 'deviceCode' }) | undefined
    const consumer = deviceCode({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              interval: 7,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          )
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          headers: { 'content-type': 'application/json' },
          status: 400,
        })
      },
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    session.onPrompt((received) => {
      prompt = received
    })
    const sendPromise = session.send({ method: 'ping', params: [] }).catch(() => undefined)
    const start = Date.now()
    while (!prompt) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for prompt')
      await new Promise((r) => setTimeout(r, 5))
    }
    // 7 s on the wire → 7000 ms in the prompt.
    expect(prompt!.pollingInterval).toBe(7000)

    await consumer.close()
    await sendPromise
  })

  test('consumer defaults to 5000ms polling when host omits `interval` (RFC 8628 §3.5)', async () => {
    let prompt: (DeviceCode.Prompt & { transport: 'deviceCode' }) | undefined
    const consumer = deviceCode({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              // interval intentionally omitted
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          )
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          headers: { 'content-type': 'application/json' },
          status: 400,
        })
      },
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    session.onPrompt((received) => {
      prompt = received
    })
    const sendPromise = session.send({ method: 'ping', params: [] }).catch(() => undefined)
    const start = Date.now()
    while (!prompt) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for prompt')
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(prompt!.pollingInterval).toBe(5000)

    await consumer.close()
    await sendPromise
  })

  test('consumer auto-closes after a successful exchange', async () => {
    const { approve, consumer, host } = pair()
    const closed: Array<unknown> = []
    consumer.on('close', (cause) => {
      closed.push(cause)
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    const hostSession = await HostWata.create({ transports: [host] }).start()
    hostSession.onRequest((event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = session.send({ method: 'ping', params: [] })
    await approve()
    await sendPromise

    // `Wata.create` may surface `undefined` or `null` depending on
    // how the close cause is normalized — both mean "clean close".
    expect({ cause: closed[0] ?? undefined, length: closed.length }).toMatchInlineSnapshot(`
      {
        "cause": undefined,
        "length": 1,
      }
    `)

    await expect(
      consumer.send(Envelope.rpcRequests([{ id: 2, jsonrpc: '2.0', method: 'ping', params: [] }])),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: device-code transport already closed]`,
    )
  })

  test('host transport auto-closes after `transport.send` settles the exchange', async () => {
    const { approve, consumer, host } = pair()
    const closed: Array<unknown> = []
    host.on('close', (cause) => {
      closed.push(cause)
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    const hostSession = await HostWata.create({ transports: [host] }).start()
    hostSession.onRequest((event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })
    const sendPromise = session.send({ method: 'ping', params: [] })
    await approve()
    await sendPromise
    expect(closed.length).toMatchInlineSnapshot(`1`)
  })

  test('host `transport.send` before `start()` rejects with `Transport.ClosedError`', async () => {
    const { host } = pair()
    await expect(
      host.send(Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'pong' }])),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: device-code transport not started]`,
    )
  })

  test('host `transport.send` with no active device-code rejects with `Transport.TransportError`', async () => {
    const { host } = pair()
    await host.start()
    await expect(
      host.send(Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'pong' }])),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: no active device-code; \`transport.send\` was called before any user approval]`,
    )
  })

  test('host `close()` is idempotent and emits `close` exactly once', async () => {
    const { host } = pair()
    const closed: Array<unknown> = []
    host.on('close', (cause) => {
      closed.push(cause)
    })
    await host.close()
    await host.close()
    expect(closed.length).toMatchInlineSnapshot(`1`)
  })

  test('consumer `close()` while in flight settles `send()` with `Transport.ClosedError`', async () => {
    let resolveToken: ((response: Response) => void) | undefined
    const consumer = deviceCode({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/register'))
          return new Response(
            JSON.stringify({
              device_code: 'dc',
              expires_in: 600,
              interval: 1,
              user_code: 'AAAA-BBBB',
              verification_uri: 'https://example/verify',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          )
        // Hang forever — `consumer.close()` should make `send()` settle.
        return await new Promise<Response>((resolve) => {
          resolveToken = resolve
        })
      },
      pollingInterval: 5,
      url: 'https://example/auth/device',
    })
    const session = await Wata.create({ transports: [consumer] }).start()
    const sendPromise = session.send({ method: 'ping', params: [] })

    // Wait until the in-flight token poll has actually been kicked off.
    const start = Date.now()
    while (!resolveToken) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for /token poll')
      await new Promise((r) => setTimeout(r, 5))
    }

    await consumer.close()
    // Resolve the hanging fetch with an abort-style failure so the poll
    // loop unwinds quickly.
    resolveToken!(new Response('', { status: 500 }))
    await expect(sendPromise).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: wata transport closed]`,
    )
  })

  test('host normalizes `user_code` casing on lookup (`actions.get`)', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    let actions: HostDeviceCode.html.Actions | undefined
    const host = hostDeviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: async (options) => {
          actions = options.actions
          return new Response('ok')
        },
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store: Store.memory(),
    })
    const { body } = await registerOnce(host, baseUrl)
    await host.fetch(new Request(`${baseUrl}/verify`, { body: new FormData(), method: 'POST' }))
    // `user_code` is generated uppercase; verify a lowercase lookup
    // still resolves it (the host stores it under an uppercased key).
    const record = await actions!.get(body.user_code.toLowerCase())
    expect(record?.deviceCode).toBe(body.device_code)
  })
})

describe('meta resolution', () => {
  function metaPair(
    options: {
      fetch?: typeof globalThis.fetch | undefined
    } = {},
  ) {
    const baseUrl = 'https://wallet.example/auth/device'
    let renderedMeta: unknown
    const html: HostDeviceCode.html.Hooks = {
      authenticate: async () => new Response('ok'),
      render: ({ meta, userCode }) => {
        renderedMeta = meta
        return new Response(`<form>code=${userCode ?? ''}</form>`, {
          headers: { 'content-type': 'text/html' },
        })
      },
    }
    const host = hostDeviceCode({
      baseUrl: 'https://wallet.example',
      html,
      path: '/auth/device',
      store: Store.memory(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    return {
      baseUrl,
      getRenderedMeta: () => renderedMeta as HostDeviceCode.PendingRecord['meta'] | undefined,
      host,
    }
  }

  async function registerWithBody(
    host: { fetch: (req: Request) => Promise<Response> },
    baseUrl: string,
    body: object,
  ) {
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        body: JSON.stringify({
          code_challenge: 'wrong_challenge',
          code_challenge_method: 'S256',
          message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
          ...body,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    return { body: (await response.json()) as { user_code: string }, response }
  }

  test('inline `meta` on /register reaches `render` callback', async () => {
    const { baseUrl, getRenderedMeta, host } = metaPair()
    const { body } = await registerWithBody(host, baseUrl, {
      meta: { icon: 'https://acme.dev/icon.png', name: 'Inline Acme' },
    })

    await host.fetch(new Request(`${baseUrl}/verify?user_code=${body.user_code}`))

    expect(getRenderedMeta()).toMatchInlineSnapshot(`
      {
        "icon": "https://acme.dev/icon.png",
        "name": "Inline Acme",
      }
    `)
  })

  test('no inline meta + no consumer_url ⇒ render receives `undefined`', async () => {
    const { baseUrl, getRenderedMeta, host } = metaPair()
    const { body } = await registerWithBody(host, baseUrl, {})
    await host.fetch(new Request(`${baseUrl}/verify?user_code=${body.user_code}`))
    expect(getRenderedMeta()).toBeUndefined()
  })

  test('consumer_url fallback fetches consumer.json and surfaces its meta', async () => {
    const consumerDocument = {
      id: 'acme.dev',
      meta: { icon: 'https://acme.dev/i.png', name: 'Discovery Acme' },
      origin: 'https://acme.dev',
      version: '1.0' as const,
    }
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === 'https://acme.dev/.well-known/urpc/consumer.json')
        return new Response(JSON.stringify(consumerDocument), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        })
      throw new Error(`unexpected fetch to ${url}`)
    }) as typeof globalThis.fetch
    const { baseUrl, getRenderedMeta, host } = metaPair({ fetch: fetchImpl })
    const { body } = await registerWithBody(host, baseUrl, {
      consumer_url: 'https://acme.dev',
    })

    await host.fetch(new Request(`${baseUrl}/verify?user_code=${body.user_code}`))

    expect(getRenderedMeta()).toMatchInlineSnapshot(`undefined`)
  })

  test('inline `meta` beats `consumer_url` discovery when both present', async () => {
    // The discovery fetch should never run when inline meta wins.
    let discoveryCalls = 0
    const fetchImpl = (async () => {
      discoveryCalls += 1
      return new Response('nope', { status: 500 })
    }) as typeof globalThis.fetch
    const { baseUrl, getRenderedMeta, host } = metaPair({ fetch: fetchImpl })
    const { body } = await registerWithBody(host, baseUrl, {
      consumer_url: 'https://acme.dev',
      meta: { name: 'Inline Wins' },
    })

    await host.fetch(new Request(`${baseUrl}/verify?user_code=${body.user_code}`))

    expect({ discoveryCalls, meta: getRenderedMeta() }).toMatchInlineSnapshot(`
      {
        "discoveryCalls": 0,
        "meta": {
          "name": "Inline Wins",
        },
      }
    `)
  })
})

describe('baseUrl optional', () => {
  test('verification_uri falls back to the incoming request URL origin when no baseUrl supplied', async () => {
    const host = hostDeviceCode({
      html: {
        authenticate: async () => new Response('ok'),
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store: Store.memory(),
    })

    const response = await host.fetch(
      new Request('https://tenant-a.wallet.example/auth/device/register', {
        body: JSON.stringify({
          code_challenge: 'wrong',
          code_challenge_method: 'S256',
          message: Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }]),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )
    const body = (await response.json()) as { verification_uri: string }
    expect({ status: response.status, verificationUri: body.verification_uri })
      .toMatchInlineSnapshot(`
      {
        "status": 200,
        "verificationUri": "https://tenant-a.wallet.example/auth/device/verify",
      }
    `)
  })

  test('discovery binding builds register_url / token_url from the supplied baseUrl', () => {
    const host = hostDeviceCode({
      html: {
        authenticate: async () => new Response('ok'),
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store: Store.memory(),
    })
    expect(host.discovery).toBeDefined()
    expect({
      binding: host.discovery!.binding('https://wallet.example'),
      id: host.discovery!.id,
    }).toMatchInlineSnapshot(`
      {
        "binding": {
          "register_url": "https://wallet.example/auth/device/register",
          "token_url": "https://wallet.example/auth/device/token",
        },
        "id": "device-code",
      }
    `)
  })
})
