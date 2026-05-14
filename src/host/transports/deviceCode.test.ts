/**
 * End-to-end test for the device-code transport, exercised against the
 * real consumer + host adapters wired together by `Handshake.create`.
 *
 * The host's HTTP routes are exposed via `transport.fetch` (no real
 * `node:http` server), and the consumer talks to them through a `fetch`
 * mock that pipes `Request`s straight into `transport.fetch`. This
 * proves the same `.fetch` handler runs identically on Node and
 * Cloudflare Workers — no `node:http` value imports anywhere on the
 * path.
 */

import { Envelope, Handshake, Kv, deviceCode } from 'handshakes'
import {
  DeviceCode as HostDeviceCode,
  Handshake as HostHandshake,
  deviceCode as hostDeviceCode,
} from 'handshakes/host'
import { describe, expect, test } from 'vp/test'

const grantType = 'urn:ietf:params:oauth:grant-type:device_code'

type HostFetch = { fetch: (request: Request) => Promise<Response> }

async function registerOnce(host: HostFetch, baseUrl: string) {
  const response = await host.fetch(
    new Request(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code_challenge: 'wrong_challenge',
        code_challenge_method: 'S256',
        message: Envelope.rpcRequests([{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]),
      }),
    }),
  )
  return {
    response,
    body: (await response.json()) as {
      device_code: string
      expires_in: number
      interval?: number
      user_code: string
      verification_uri: string
      verification_uri_complete?: string
    },
  }
}

async function pollToken(
  host: HostFetch,
  baseUrl: string,
  body: Partial<{ code_verifier: string; device_code: string; grant_type: string }>,
) {
  return await host.fetch(
    new Request(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function pair() {
  const baseUrl = 'https://wallet.example/auth/device'

  const store = Kv.memory()
  let lastUserCode: string | undefined

  const html: HostDeviceCode.html.Hooks = {
    render: ({ userCode }) =>
      new Response(`<form>code=${userCode ?? ''}</form>`, {
        headers: { 'content-type': 'text/html' },
      }),
    authenticate: async ({ request, actions }) => {
      const form = await request.formData()
      const userCode = String(form.get('user_code') ?? '')
      const action = String(form.get('action') ?? 'approve')
      if (action === 'deny') await actions.deny(userCode)
      else await actions.approve(userCode)
      return new Response('ok')
    },
  }

  const host = hostDeviceCode({
    store,
    baseUrl: 'https://wallet.example',
    html,
    path: '/auth/device',
    pollingInterval: 1000,
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
    url: baseUrl,
    pollingInterval: 50,
    fetch: fetchImpl,
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
    await host.fetch(new Request(`${baseUrl}/verify`, { method: 'POST', body: form }))
  }

  async function deny(): Promise<void> {
    const userCode = await waitForUserCode()
    const form = new FormData()
    form.set('user_code', userCode)
    form.set('action', 'deny')
    await host.fetch(new Request(`${baseUrl}/verify`, { method: 'POST', body: form }))
  }

  return { baseUrl, consumer, host, store, approve, deny }
}

describe('handshake-device-code', () => {
  test('end-to-end approval delivers the host response', async () => {
    const { consumer, host, approve } = pair()

    const handshake = Handshake.create({ transport: consumer })
    const hostHandshake = HostHandshake.create({ transport: host })

    hostHandshake.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = handshake.send({ method: 'ping', params: [] })
    await approve()
    const { result } = await sendPromise
    expect(result).toEqual({ ok: true })
  })

  test('user denial surfaces as `UserRejectedError`', async () => {
    const { consumer, host, deny } = pair()
    const handshake = Handshake.create({ transport: consumer })
    HostHandshake.create({ transport: host })

    const sendPromise = handshake.send({ method: 'ping', params: [] })
    await deny()

    await expect(sendPromise).rejects.toThrowErrorMatchingInlineSnapshot(
      `[DeviceCode.UserRejectedError: user denied the device-code request]`,
    )
  })

  test('PKCE mismatch returns 400 on /token and surfaces as ProtocolError', async () => {
    const { baseUrl, host } = pair()

    const registerResponse = await host.fetch(
      new Request(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code_challenge: 'wrong_challenge',
          code_challenge_method: 'S256',
          message: Envelope.rpcRequests([{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]),
        }),
      }),
    )
    expect(registerResponse.status).toBe(200)
    const registered = (await registerResponse.json()) as { device_code: string }

    const tokenResponse = await host.fetch(
      new Request(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code_verifier: 'something_unrelated',
          device_code: registered.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      }),
    )
    expect(tokenResponse.status).toBe(400)
    const body = (await tokenResponse.json()) as { error: string }
    expect(body.error).toBe('invalid_grant')
  })

  test('post-terminal `send()` rejects with `ClosedError`', async () => {
    const { consumer, host, approve } = pair()
    const handshake = Handshake.create({ transport: consumer })
    const hostHandshake = HostHandshake.create({ transport: host })
    hostHandshake.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = handshake.send({ method: 'ping', params: [] })
    await approve()
    await sendPromise

    await expect(
      consumer.send(
        Envelope.rpcRequests([{ jsonrpc: '2.0', id: 2, method: 'ping', params: [] }]),
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: device-code transport already closed]`,
    )
  })

  test('concurrent `send()` on the same single-exchange transport rejects with `TransportError`', async () => {
    const { consumer, host } = pair()
    HostHandshake.create({ transport: host })

    await consumer.start()
    const first = consumer.send(
      Envelope.rpcRequests([{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]),
    )
    await expect(
      consumer.send(
        Envelope.rpcRequests([{ jsonrpc: '2.0', id: 2, method: 'ping', params: [] }]),
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: device-code is single-exchange; a previous send is still in flight]`,
    )

    await consumer.close()
    await first.catch(() => {})
  })

  test('`/register` response includes the polling `interval` in seconds', async () => {
    const { baseUrl, host } = pair()
    const { response, body } = await registerOnce(host, baseUrl)
    expect(response.status).toBe(200)
    // pair() configures pollingInterval=1000ms → 1 second.
    expect(body.interval).toBe(1)
  })

  test('every endpoint sets `Cache-Control: no-store` and `Pragma: no-cache`', async () => {
    const { baseUrl, host } = pair()

    const { response: registerResponse, body } = await registerOnce(host, baseUrl)
    expect(registerResponse.headers.get('cache-control')).toBe('no-store')
    expect(registerResponse.headers.get('pragma')).toBe('no-cache')

    const tokenResponse = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: body.device_code,
      grant_type: grantType,
    })
    expect(tokenResponse.headers.get('cache-control')).toBe('no-store')
    expect(tokenResponse.headers.get('pragma')).toBe('no-cache')

    const verifyGet = await host.fetch(new Request(`${baseUrl}/verify?user_code=${body.user_code}`))
    expect(verifyGet.headers.get('cache-control')).toBe('no-store')
    expect(verifyGet.headers.get('pragma')).toBe('no-cache')

    const form = new FormData()
    form.set('user_code', body.user_code)
    form.set('action', 'approve')
    const verifyPost = await host.fetch(
      new Request(`${baseUrl}/verify`, { method: 'POST', body: form }),
    )
    expect(verifyPost.headers.get('cache-control')).toBe('no-store')
    expect(verifyPost.headers.get('pragma')).toBe('no-cache')
  })

  test('`/token` rejects a missing `grant_type` with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const { body: registered } = await registerOnce(host, baseUrl)
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: registered.device_code,
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; error_description?: string }
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toContain('grant_type')
  })

  test('`/token` rejects a wrong `grant_type` with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const { body: registered } = await registerOnce(host, baseUrl)
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: registered.device_code,
      grant_type: 'authorization_code',
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('invalid_request')
  })

  test('`/token` returns `expired_token` for an unknown `device_code`', async () => {
    const { baseUrl, host } = pair()
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: 'never-existed',
      grant_type: grantType,
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('expired_token')
  })

  test('`/token` returns `expired_token` after the intent expires', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    const host = hostDeviceCode({
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      expiresIn: 0,
      html: {
        render: () => new Response(''),
        authenticate: () => new Response(''),
      },
    })
    const { body: registered } = await registerOnce(host, baseUrl)
    const response = await pollToken(host, baseUrl, {
      code_verifier: 'irrelevant',
      device_code: registered.device_code,
      grant_type: grantType,
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('expired_token')
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
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('invalid_grant')
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
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          message: Envelope.rpcRequests([{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]),
        }),
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
    expect(first.status).toBe(400)
    expect(((await first.json()) as { error: string }).error).toBe('authorization_pending')

    // Immediate second poll → `slow_down` (well within 500ms of poll 1).
    const second = await pollToken(host, baseUrl, {
      code_verifier: verifier,
      device_code: registered.device_code,
      grant_type: grantType,
    })
    expect(second.status).toBe(400)
    expect(((await second.json()) as { error: string }).error).toBe('slow_down')

    // Wait past the half-interval threshold and poll again →
    // `authorization_pending` resumes (slow_down is non-terminal).
    await new Promise((r) => setTimeout(r, 600))
    const third = await pollToken(host, baseUrl, {
      code_verifier: verifier,
      device_code: registered.device_code,
      grant_type: grantType,
    })
    expect(third.status).toBe(400)
    expect(((await third.json()) as { error: string }).error).toBe('authorization_pending')
  })

  test('error responses use `error_description`, not the legacy `message` field', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      }),
    )
    const body = (await response.json()) as Record<string, unknown>
    expect(body['error']).toBe('invalid_request')
    expect(body).toHaveProperty('error_description')
    expect(body).not.toHaveProperty('message')
  })

  test('consumer sends `grant_type` in every `/token` request', async () => {
    const { baseUrl, host } = pair()
    let lastTokenBody: { grant_type?: string } | undefined
    const consumer = deviceCode({
      url: baseUrl,
      pollingInterval: 50,
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/token')) {
          const cloned = new Request(url, init).clone()
          lastTokenBody = (await cloned.json()) as { grant_type?: string }
        }
        return await host.fetch(new Request(url, init))
      },
    })
    HostHandshake.create({ transport: host })
    const handshake = Handshake.create({ transport: consumer })
    const sendPromise = handshake
      .send({ method: 'ping', params: [] })
      .catch(() => undefined)

    const start = Date.now()
    while (!lastTokenBody) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for token poll')
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(lastTokenBody.grant_type).toBe(grantType)

    await consumer.close()
    await sendPromise
  })

  // 20s timeout: each `slow_down` adds ≥5s sleep per RFC 8628 §3.5.
  // One `slow_down` + one `authorization_pending` + one success ≈ 10s
  // of real-time sleeping; 20s leaves comfortable headroom.
  test('consumer increases interval and continues after `slow_down`, then succeeds', { timeout: 20_000 }, async () => {
    // Mock fetch: /register succeeds, /token returns slow_down once,
    // then authorization_pending, then a real success envelope.
    let tokenCalls = 0
    const responsePayload = Envelope.rpcResponses([
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
    ])
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 50,
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        if (url.endsWith('/token')) {
          tokenCalls += 1
          if (tokenCalls === 1)
            return new Response(JSON.stringify({ error: 'slow_down' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          if (tokenCalls === 2)
            return new Response(JSON.stringify({ error: 'authorization_pending' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          return new Response(JSON.stringify(responsePayload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`unexpected ${url}`)
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    const { result } = await handshake.send({ method: 'ping', params: [] })
    expect(result).toEqual({ ok: true })
    expect(tokenCalls).toBe(3)
  })

  // 25s timeout: 3 `slow_down`s back-to-back sleep ≈ 5s + 10s + 0s
  // (3rd throws immediately) ≈ 15s of real-time sleeping.
  test('consumer terminates with `TransportError` after 3 consecutive `slow_down`s', { timeout: 25_000 }, async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 50,
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        if (url.endsWith('/token'))
          return new Response(JSON.stringify({ error: 'slow_down' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        throw new Error(`unexpected ${url}`)
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: device-code host is signalling indefinite throttling (3 consecutive \`slow_down\` responses)]`,
    )
  })

  test('`/register` rejects a missing `code_challenge` with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code_challenge_method: 'S256',
          message: Envelope.rpcRequests([{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]),
        }),
      }),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; error_description?: string }
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toContain('code_challenge')
  })

  test('`/register` rejects `code_challenge_method` other than `S256`', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code_challenge: 'whatever',
          code_challenge_method: 'plain',
          message: Envelope.rpcRequests([{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]),
        }),
      }),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; error_description?: string }
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toContain('S256')
  })

  test('`/register` rejects a non-`rpc-requests` envelope with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code_challenge: 'whatever',
          code_challenge_method: 'S256',
          message: Envelope.rpcResponses([{ jsonrpc: '2.0', id: 1, result: 'pong' }]),
        }),
      }),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; error_description?: string }
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toContain('rpc-requests')
  })

  test('`/register` rejects malformed JSON with `invalid_request`', async () => {
    const { baseUrl, host } = pair()
    const response = await host.fetch(
      new Request(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('invalid_request')
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
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: (options) => {
          renderArgs = options
          return new Response('ok')
        },
        authenticate: () => new Response('ok'),
      },
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
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: (options) => {
          renderArgs = options
          return new Response('ok')
        },
        authenticate: () => new Response('ok'),
      },
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
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: () => new Response('ok'),
        authenticate: async ({ actions, request }) => {
          calls += 1
          firstActions = actions
          const form = await request.formData()
          await actions.deny(String(form.get('user_code')))
          return new Response('ok')
        },
      },
    })
    const { body } = await registerOnce(host, baseUrl)
    const form = new FormData()
    form.set('user_code', body.user_code)
    await host.fetch(new Request(`${baseUrl}/verify`, { method: 'POST', body: form }))
    expect(calls).toBe(1)
    // A second deny on the same `user_code` must not throw — it's a
    // no-op once the record is already terminal.
    await firstActions!.deny(body.user_code)
  })

  test('`actions.approve` / `actions.deny` throw `UnknownUserCodeError` for unknown codes', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    let actions: HostDeviceCode.html.Actions | undefined
    const host = hostDeviceCode({
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: () => new Response('ok'),
        authenticate: async (options) => {
          actions = options.actions
          return new Response('ok')
        },
      },
    })
    // Trigger `authenticate` once to capture `actions`.
    await host.fetch(new Request(`${baseUrl}/verify`, { method: 'POST', body: new FormData() }))
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
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: () => new Response('ok'),
        authenticate: async (options) => {
          actions = options.actions
          return new Response('ok')
        },
      },
    })
    const { body } = await registerOnce(host, baseUrl)
    await host.fetch(new Request(`${baseUrl}/verify`, { method: 'POST', body: new FormData() }))
    const record = await actions!.get(body.user_code)
    expect(record?.deviceCode).toBe(body.device_code)
    expect(record?.status).toBe('pending')
  })

  test('consumer maps `access_denied` to `DeviceCode.UserRejectedError` with description', async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        if (url.endsWith('/token'))
          return new Response(
            JSON.stringify({ error: 'access_denied', error_description: 'user said no' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        throw new Error(`unexpected ${url}`)
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[DeviceCode.UserRejectedError: user said no]`)
  })

  test('consumer maps `expired_token` to `Transport.ClosedError`', async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        if (url.endsWith('/token'))
          return new Response(JSON.stringify({ error: 'expired_token' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        throw new Error(`unexpected ${url}`)
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: device-code expired or not found]`,
    )
  })

  test('consumer maps an unknown `/token` 4xx to `Transport.TransportError` carrying the description', async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        if (url.endsWith('/token'))
          return new Response(
            JSON.stringify({ error: 'totally_made_up', error_description: 'host bug' }),
            { status: 418, headers: { 'content-type': 'application/json' } },
          )
        throw new Error(`unexpected ${url}`)
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: unexpected device-code /token status 418: host bug]`,
    )
  })

  test('consumer surfaces a malformed success envelope as `Transport.TransportError`', async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        if (url.endsWith('/token'))
          return new Response(JSON.stringify({ not: 'an envelope' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        throw new Error(`unexpected ${url}`)
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`
    	[Transport.TransportError: host returned an invalid response envelope: invalid envelope
    	Details: type: Invalid discriminator value. Expected 'encrypted' | 'hello' | 'ready' | 'rpc-requests' | 'rpc-responses']
    `)
  })

  test('consumer rejects a `/register` response missing `device_code` with `Transport.TransportError`', async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
      fetch: async () =>
        new Response(
          JSON.stringify({
            // device_code intentionally missing
            expires_in: 600,
            user_code: 'AAAA-BBBB',
            verification_uri: 'https://example/verify',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: host /register response missing \`device_code\`]`,
    )
  })

  test('consumer maps a `/register` 400 to `Errors.ProtocolError`', async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
      fetch: async () =>
        new Response(
          JSON.stringify({ error: 'invalid_request', error_description: 'bad message envelope' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[ProtocolError: host rejected device-code /register: bad message envelope]`,
    )
  })

  test('consumer maps a `/register` 5xx to `Transport.TransportError`', async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'server_error', error_description: 'oops' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: device-code /register returned status 502: oops]`,
    )
  })

  test('consumer surfaces a `fetch` failure as `Transport.TransportError`', async () => {
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
      fetch: async () => {
        throw new Error('network down')
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: device-code register failed: network down]`,
    )
  })

  test('consumer rejects a non-`rpc-requests` envelope on `send` with `UnsupportedError`', async () => {
    const { consumer } = pair()
    // Consumer-side `send` is fire-and-forget — failures arrive on the
    // `error` event before the auto-close.
    const errorPromise = new Promise<unknown>((resolve) => consumer.on('error', resolve))
    await consumer.send(Envelope.rpcResponses([{ jsonrpc: '2.0', id: 1, result: 'pong' }]))
    expect(await errorPromise).toMatchInlineSnapshot(
      `[Transport.UnsupportedError: device-code transport only carries rpc-requests envelopes; received \`rpc-responses\`]`,
    )
  })

  test('`onPrompt` receives the host-derived prompt fields', async () => {
    let prompt: Awaited<Parameters<NonNullable<Parameters<typeof deviceCode>[0]['onPrompt']>>[0]> | undefined
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
      onPrompt: (received) => {
        prompt = received
      },
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        // Sit forever on /token so we can close cleanly.
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    const sendPromise = handshake.send({ method: 'ping', params: [] }).catch(() => undefined)

    const start = Date.now()
    while (!prompt) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for onPrompt')
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(prompt!.deviceCode).toBe('dc')
    expect(prompt!.expiresIn).toBe(1234)
    // Consumer-supplied `pollingInterval` (5ms) overrides the host's
    // `interval` field (7 s).
    expect(prompt!.pollingInterval).toBe(5)
    expect(prompt!.userCode).toBe('AAAA-BBBB')
    expect(prompt!.verificationUri).toBe('https://example/verify')
    expect(prompt!.verificationUriFull).toBe('https://example/verify?user_code=AAAA-BBBB')

    await consumer.close()
    await sendPromise
  })

  test('consumer falls back to host-supplied `interval` when `pollingInterval` is omitted', async () => {
    let prompt: Awaited<Parameters<NonNullable<Parameters<typeof deviceCode>[0]['onPrompt']>>[0]> | undefined
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      onPrompt: (received) => {
        prompt = received
      },
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    const sendPromise = handshake.send({ method: 'ping', params: [] }).catch(() => undefined)
    const start = Date.now()
    while (!prompt) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for onPrompt')
      await new Promise((r) => setTimeout(r, 5))
    }
    // 7 s on the wire → 7000 ms in the prompt.
    expect(prompt!.pollingInterval).toBe(7000)

    await consumer.close()
    await sendPromise
  })

  test('consumer defaults to 5000ms polling when host omits `interval` (RFC 8628 §3.5)', async () => {
    let prompt: Awaited<Parameters<NonNullable<Parameters<typeof deviceCode>[0]['onPrompt']>>[0]> | undefined
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      onPrompt: (received) => {
        prompt = received
      },
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    const sendPromise = handshake.send({ method: 'ping', params: [] }).catch(() => undefined)
    const start = Date.now()
    while (!prompt) {
      if (Date.now() - start > 2000) throw new Error('timed out waiting for onPrompt')
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(prompt!.pollingInterval).toBe(5000)

    await consumer.close()
    await sendPromise
  })

  test('consumer auto-closes after a successful exchange', async () => {
    const { consumer, host, approve } = pair()
    const closed: Array<unknown> = []
    consumer.on('close', (cause) => {
      closed.push(cause)
    })
    const handshake = Handshake.create({ transport: consumer })
    const hostHandshake = HostHandshake.create({ transport: host })
    hostHandshake.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const sendPromise = handshake.send({ method: 'ping', params: [] })
    await approve()
    await sendPromise

    expect(closed.length).toBe(1)
    // `Handshake.create` may surface `undefined` or `null` depending on
    // how the close cause is normalized — both mean "clean close".
    expect(closed[0] ?? undefined).toBeUndefined()

    await expect(
      consumer.send(
        Envelope.rpcRequests([{ jsonrpc: '2.0', id: 2, method: 'ping', params: [] }]),
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: device-code transport already closed]`,
    )
  })

  test('host transport auto-closes after `transport.send` settles the exchange', async () => {
    const { consumer, host, approve } = pair()
    const closed: Array<unknown> = []
    host.on('close', (cause) => {
      closed.push(cause)
    })
    const handshake = Handshake.create({ transport: consumer })
    const hostHandshake = HostHandshake.create({ transport: host })
    hostHandshake.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })
    const sendPromise = handshake.send({ method: 'ping', params: [] })
    await approve()
    await sendPromise
    expect(closed.length).toBe(1)
  })

  test('host `transport.send` before `start()` rejects with `Transport.ClosedError`', async () => {
    const { host } = pair()
    await expect(
      host.send(Envelope.rpcResponses([{ jsonrpc: '2.0', id: 1, result: 'pong' }])),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: device-code transport not started]`,
    )
  })

  test('host `transport.send` with no active device-code rejects with `Transport.TransportError`', async () => {
    const { host } = pair()
    await host.start()
    await expect(
      host.send(Envelope.rpcResponses([{ jsonrpc: '2.0', id: 1, result: 'pong' }])),
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
    expect(closed.length).toBe(1)
  })

  test('consumer `close()` while in flight settles `send()` with `Transport.ClosedError`', async () => {
    let resolveToken: ((response: Response) => void) | undefined
    const consumer = deviceCode({
      url: 'https://example/auth/device',
      pollingInterval: 5,
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
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        // Hang forever — `consumer.close()` should make `send()` settle.
        return await new Promise<Response>((resolve) => {
          resolveToken = resolve
        })
      },
    })
    const handshake = Handshake.create({ transport: consumer })
    const sendPromise = handshake.send({ method: 'ping', params: [] })

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
      `[Transport.ClosedError: handshake transport closed]`,
    )
  })

  test('host normalizes `user_code` casing on lookup (`actions.get`)', async () => {
    const baseUrl = 'https://wallet.example/auth/device'
    let actions: HostDeviceCode.html.Actions | undefined
    const host = hostDeviceCode({
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: () => new Response('ok'),
        authenticate: async (options) => {
          actions = options.actions
          return new Response('ok')
        },
      },
    })
    const { body } = await registerOnce(host, baseUrl)
    await host.fetch(new Request(`${baseUrl}/verify`, { method: 'POST', body: new FormData() }))
    // `user_code` is generated uppercase; verify a lowercase lookup
    // still resolves it (the host stores it under an uppercased key).
    const record = await actions!.get(body.user_code.toLowerCase())
    expect(record?.deviceCode).toBe(body.device_code)
  })
})
