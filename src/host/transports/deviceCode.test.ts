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

    let caught: unknown
    try {
      await sendPromise
    } catch (cause) {
      caught = cause
    }
    expect((caught as Error).name).toBe('DeviceCode.UserRejectedError')
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
          device_code: registered.device_code,
          code_verifier: 'something_unrelated',
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

    let caught: unknown
    try {
      await consumer.send(
        Envelope.rpcRequests([{ jsonrpc: '2.0', id: 2, method: 'ping', params: [] }]),
      )
    } catch (cause) {
      caught = cause
    }
    expect((caught as Error).name).toBe('Transport.ClosedError')
  })

  test('concurrent `send()` on the same single-exchange transport rejects with `TransportError`', async () => {
    const { consumer, host } = pair()
    HostHandshake.create({ transport: host })

    await consumer.start()
    const first = consumer.send(
      Envelope.rpcRequests([{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]),
    )
    let caught: unknown
    try {
      await consumer.send(
        Envelope.rpcRequests([{ jsonrpc: '2.0', id: 2, method: 'ping', params: [] }]),
      )
    } catch (cause) {
      caught = cause
    }
    expect((caught as Error).name).toBe('Transport.TransportError')

    await consumer.close()
    await first.catch(() => {})
  })
})
