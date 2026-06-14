import { describe, expect, test } from 'vp/test'
import { Crypto, MessageSig, Store } from 'wata'

import * as Relay from './Relay.js'

const channel = 'q'.repeat(43)

function relayUrl(channelId: string, peer: string): string {
  return `https://relay.test/${channelId}/${peer}`
}

/** Build an RFC 9421-signed relay request the way a conforming peer would. */
function signedRequest(options: {
  body?: string | undefined
  channelId?: string | undefined
  created?: number | undefined
  extraComponents?: readonly string[] | undefined
  includePublicKey?: boolean | undefined
  headers?: Record<string, string> | undefined
  keypair: Crypto.Keypair
  method: 'GET' | 'POST'
  nonce?: string | undefined
  url: string
}): Request {
  const {
    body,
    channelId = channel,
    created = Math.floor(Date.now() / 1000),
    extraComponents,
    includePublicKey = true,
    keypair,
    method,
    nonce = crypto.randomUUID(),
    url,
  } = options
  const headers: Record<string, string> = { ...options.headers }
  if (method === 'GET') headers['accept'] ??= 'text/event-stream'
  if (body !== undefined) {
    headers['content-digest'] ??= MessageSig.contentDigest(body)
    headers['content-type'] ??= 'application/json'
  }
  if (includePublicKey) headers['urpc-public-key'] = Crypto.encodePublicKey(keypair.publicKey)
  const components = ['@method', '@path', '@authority']
  if (body !== undefined) components.push('content-digest')
  if (includePublicKey) components.push('urpc-public-key')
  if (extraComponents) components.push(...extraComponents)
  const { signature, signatureInput } = MessageSig.sign({
    components,
    message: { headers, method, url },
    parameters: { alg: 'ed25519', created, keyid: channelId, nonce },
    privateKey: keypair.privateKey,
  })
  headers['signature'] = signature
  headers['signature-input'] = signatureInput
  return new Request(url, { ...(body === undefined ? {} : { body }), headers, method })
}

type SseEvent = { data: string; event: string }

/** Incremental SSE reader over a streaming `Response`. */
function sseReader(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  function parseBlock(block: string): SseEvent | undefined {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event: ')) event = line.slice(7)
      if (line.startsWith('data: ')) data.push(line.slice(6))
    }
    if (data.length === 0) return undefined
    return { data: data.join('\n'), event }
  }
  return {
    cancel: () => reader.cancel(),
    async next(): Promise<SseEvent | undefined> {
      while (true) {
        const index = buffer.indexOf('\n\n')
        if (index >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = parseBlock(block)
          if (event) return event
          continue
        }
        const { done, value } = await reader.read()
        if (done) return undefined
        buffer += decoder.decode(value, { stream: true })
      }
    },
  }
}

describe('create', () => {
  test('rejects a malformed channel id', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        channelId: 'nope',
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: relayUrl('nope', 'consumer'),
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "error": "invalid_request",
        "error_description": "malformed channel id or peer slot",
      }
    `)
  })

  test('rejects an unknown peer slot', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: relayUrl(channel, 'observer'),
      }),
    )
    expect(response.status).toBe(400)
  })

  test('rejects a subscription with a missing or unsupported `Accept`', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        headers: { accept: '*/*' },
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error_description: string }).error_description).toBe(
      '`Accept` must be `text/event-stream` or `application/json`',
    )
  })

  test('rejects a subscription with an ambiguous `Accept`', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        headers: { accept: 'text/event-stream, application/json' },
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error_description: string }).error_description).toBe(
      '`Accept` must not request both `text/event-stream` and `application/json`',
    )
  })

  test('rejects an unsigned request', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      new Request(relayUrl(channel, 'consumer'), { headers: { accept: 'text/event-stream' } }),
    )
    expect(response.status).toBe(401)
  })

  test('rejects a first request without `uRPC-Public-Key`', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        includePublicKey: false,
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error_description: string }).error_description).toBe(
      'first request must carry `uRPC-Public-Key`',
    )
  })

  test('rejects a `keyid` that does not match the channel id', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        channelId: 'r'.repeat(43),
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error_description: string }).error_description).toBe(
      'signature keyid must equal the channel id',
    )
  })

  test('rejects a `created` outside the acceptance window', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        created: Math.floor(Date.now() / 1000) - 3_600,
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error_description: string }).error_description).toBe(
      'signature created outside acceptance window',
    )
  })

  test('opens an authenticated SSE stream with `opened`', async () => {
    const relay = Relay.create({ keepaliveInterval: 50 })
    const response = await relay.fetch(
      signedRequest({
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache, no-store')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    const reader = sseReader(response)
    expect(await reader.next()).toMatchInlineSnapshot(`
      {
        "data": "{}",
        "event": "opened",
      }
    `)
    await reader.cancel()
  })

  test('buffers a POST when the target peer has no active receiver (202)', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        body: '{"type":"hello","payload":{}}',
        keypair: Crypto.randomKeypair(),
        method: 'POST',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(202)
  })

  test('delivers a POST body to the active receiver and returns 202', async () => {
    const relay = Relay.create({ keepaliveInterval: 50 })
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()
    const subscription = await relay.fetch(
      signedRequest({ keypair: consumer, method: 'GET', url: relayUrl(channel, 'consumer') }),
    )
    const reader = sseReader(subscription)
    expect((await reader.next())?.event).toBe('opened')
    const body = '{"type":"hello","payload":{"host_pubkey":"x","host_proof":"y"}}'
    // POSTs to the consumer slot are signed by the *host* (the sender).
    const delivery = relay.fetch(
      signedRequest({ body, keypair: host, method: 'POST', url: relayUrl(channel, 'consumer') }),
    )
    expect(await reader.next()).toEqual({ data: body, event: 'message' })
    expect((await delivery).status).toBe(202)
    await reader.cancel()
  })

  test('rejects a replayed signature nonce', async () => {
    const relay = Relay.create()
    const keypair = Crypto.randomKeypair()
    const nonce = crypto.randomUUID()
    const first = await relay.fetch(
      signedRequest({
        body: '{}',
        keypair,
        method: 'POST',
        nonce,
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(first.status).toBe(202)
    const second = await relay.fetch(
      signedRequest({
        body: '{}',
        keypair,
        method: 'POST',
        nonce,
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(second.status).toBe(401)
    expect(((await second.json()) as { error_description: string }).error_description).toBe(
      'signature nonce replayed',
    )
  })

  test('serializes concurrent same-nonce requests so only one is accepted', async () => {
    const relay = Relay.create()
    const keypair = Crypto.randomKeypair()
    const nonce = crypto.randomUUID()
    const send = () =>
      relay.fetch(
        signedRequest({
          body: '{}',
          keypair,
          method: 'POST',
          nonce,
          url: relayUrl(channel, 'consumer'),
        }),
      )
    const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort()
    expect(statuses).toEqual([202, 401])
  })

  test('serializes concurrent first registrations so one key wins', async () => {
    const relay = Relay.create()
    const a = Crypto.randomKeypair()
    const b = Crypto.randomKeypair()
    const send = (keypair: Crypto.Keypair) =>
      relay.fetch(
        signedRequest({ body: '{}', keypair, method: 'POST', url: relayUrl(channel, 'host') }),
      )
    const statuses = (await Promise.all([send(a), send(b)])).map((r) => r.status).sort()
    // One registers and buffers (202, no receiver), the other diverges
    // from the now registered key and is rejected (401).
    expect(statuses).toEqual([202, 401])
  })

  test('enforces first-write-wins on the peer-slot key', async () => {
    const relay = Relay.create({ keepaliveInterval: 50 })
    const original = Crypto.randomKeypair()
    const attacker = Crypto.randomKeypair()
    const subscription = await relay.fetch(
      signedRequest({ keypair: original, method: 'GET', url: relayUrl(channel, 'consumer') }),
    )
    const reader = sseReader(subscription)
    expect((await reader.next())?.event).toBe('opened')

    // A different declared key on a registered slot is rejected outright.
    const declared = await relay.fetch(
      signedRequest({ keypair: attacker, method: 'GET', url: relayUrl(channel, 'consumer') }),
    )
    expect(declared.status).toBe(401)
    expect(((await declared.json()) as { error_description: string }).error_description).toBe(
      'peer slot is registered to a different key',
    )

    // Omitting the header just fails verification under the registered key.
    const undeclared = await relay.fetch(
      signedRequest({
        includePublicKey: false,
        keypair: attacker,
        method: 'GET',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(undeclared.status).toBe(401)
    expect(((await undeclared.json()) as { error_description: string }).error_description).toBe(
      'signature verification failed',
    )
    await reader.cancel()
  })

  test('rejects a `Content-Digest` that does not match the body', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        body: '{"actual":"body"}',
        headers: { 'content-digest': MessageSig.contentDigest('{"signed":"other"}') },
        keypair: Crypto.randomKeypair(),
        method: 'POST',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error_description: string }).error_description).toBe(
      '`Content-Digest` does not match the request body',
    )
  })

  test('rejects an oversized body', async () => {
    const relay = Relay.create({ maxBodySize: 16 })
    const response = await relay.fetch(
      signedRequest({
        body: JSON.stringify({ payload: 'x'.repeat(64) }),
        keypair: Crypto.randomKeypair(),
        method: 'POST',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(response.status).toBe(413)
  })

  test('rejects a POST without `Content-Type: application/json`', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      new Request(relayUrl(channel, 'consumer'), {
        body: '{}',
        headers: { 'content-type': 'text/plain' },
        method: 'POST',
      }),
    )
    expect(response.status).toBe(400)
  })

  test('supersedes an existing stream and rate-limits further supersession', async () => {
    const relay = Relay.create({ keepaliveInterval: 50 })
    const keypair = Crypto.randomKeypair()
    const first = await relay.fetch(
      signedRequest({ keypair, method: 'GET', url: relayUrl(channel, 'consumer') }),
    )
    const reader_first = sseReader(first)
    expect((await reader_first.next())?.event).toBe('opened')

    const second = await relay.fetch(
      signedRequest({ keypair, method: 'GET', url: relayUrl(channel, 'consumer') }),
    )
    expect(second.status).toBe(200)
    const reader_second = sseReader(second)
    expect((await reader_first.next())?.event).toBe('closed')
    expect((await reader_second.next())?.event).toBe('opened')

    // A third subscription within the supersession window is rejected.
    const third = await relay.fetch(
      signedRequest({ keypair, method: 'GET', url: relayUrl(channel, 'consumer') }),
    )
    expect(third.status).toBe(429)
    await reader_second.cancel()
  })

  test('buffers a POST for an absent receiver and drains it FIFO on subscribe', async () => {
    const relay = Relay.create({ keepaliveInterval: 50 })
    const host = Crypto.randomKeypair()
    const consumer = Crypto.randomKeypair()
    const first = await relay.fetch(
      signedRequest({
        body: 'A',
        keypair: host,
        method: 'POST',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    const second = await relay.fetch(
      signedRequest({
        body: 'B',
        keypair: host,
        method: 'POST',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    // With buffering enabled the relay accepts bodies for an absent
    // receiver (spec §6.3 / §5.4).
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    const subscription = await relay.fetch(
      signedRequest({ keypair: consumer, method: 'GET', url: relayUrl(channel, 'consumer') }),
    )
    const reader = sseReader(subscription)
    // `opened` precedes the drained backlog, delivered in arrival order.
    expect((await reader.next())?.event).toBe('opened')
    expect(await reader.next()).toEqual({ data: 'A', event: 'message' })
    expect(await reader.next()).toEqual({ data: 'B', event: 'message' })
    await reader.cancel()
  })

  test('persists the buffer in the store, not the relay instance', async () => {
    // Two relay instances sharing one store stand in for the same channel
    // handled across a restart / different isolate: the body buffered via
    // the first is drained by the second because the queue lives in the
    // store, not in either instance's memory.
    const store = Store.memory()
    const host = Crypto.randomKeypair()
    const consumer = Crypto.randomKeypair()
    const buffered = await Relay.create({ store }).fetch(
      signedRequest({
        body: 'A',
        keypair: host,
        method: 'POST',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    expect(buffered.status).toBe(202)
    const subscription = await Relay.create({ keepaliveInterval: 50, store }).fetch(
      signedRequest({ keypair: consumer, method: 'GET', url: relayUrl(channel, 'consumer') }),
    )
    const reader = sseReader(subscription)
    expect((await reader.next())?.event).toBe('opened')
    expect(await reader.next()).toEqual({ data: 'A', event: 'message' })
    await reader.cancel()
  })

  test('tail-drops a buffered POST when the buffer is full (204)', async () => {
    const relay = Relay.create()
    const host = Crypto.randomKeypair()
    const post = (body: string) =>
      relay.fetch(
        signedRequest({ body, keypair: host, method: 'POST', url: relayUrl(channel, 'consumer') }),
      )
    // The default per-slot bound is 16 messages; the first 16 are held.
    for (let index = 0; index < 16; index += 1) expect((await post(`m${index}`)).status).toBe(202)
    // Buffer is full — the newest body is dropped, not an older one.
    expect((await post('overflow')).status).toBe(204)
  })

  test('long-polls and delivers an arriving POST as a 200 body', async () => {
    const relay = Relay.create()
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()
    const poll = relay.fetch(
      signedRequest({
        headers: { accept: 'application/json' },
        keypair: consumer,
        method: 'GET',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    // Give the poll a moment to park as the slot's receiver.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const body = '{"type":"hello","payload":{}}'
    const delivery = await relay.fetch(
      signedRequest({ body, keypair: host, method: 'POST', url: relayUrl(channel, 'consumer') }),
    )
    expect(delivery.status).toBe(202)
    const response = await poll
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(body)
  })

  test('long-poll returns 204 when `wait` elapses with no message', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        extraComponents: ['@query-param;name="wait"'],
        headers: { accept: 'application/json' },
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: `${relayUrl(channel, 'consumer')}?wait=0`,
      }),
    )
    expect(response.status).toBe(204)
  })

  test('rejects a long-poll `wait` that is not covered by the signature', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        headers: { accept: 'application/json' },
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: `${relayUrl(channel, 'consumer')}?wait=1`,
      }),
    )
    expect(response.status).toBe(401)
  })

  test('rejects a long-poll `wait` above the cap (400)', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      signedRequest({
        extraComponents: ['@query-param;name="wait"'],
        headers: { accept: 'application/json' },
        keypair: Crypto.randomKeypair(),
        method: 'GET',
        url: `${relayUrl(channel, 'consumer')}?wait=120`,
      }),
    )
    expect(response.status).toBe(400)
  })

  test('long-poll drains the single oldest buffered body, leaving the rest', async () => {
    const relay = Relay.create()
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()
    await relay.fetch(
      signedRequest({
        body: 'X',
        keypair: host,
        method: 'POST',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    await relay.fetch(
      signedRequest({
        body: 'Y',
        keypair: host,
        method: 'POST',
        url: relayUrl(channel, 'consumer'),
      }),
    )
    const poll = (nonce: string) =>
      relay.fetch(
        signedRequest({
          extraComponents: ['@query-param;name="wait"'],
          headers: { accept: 'application/json' },
          keypair: consumer,
          method: 'GET',
          nonce,
          url: `${relayUrl(channel, 'consumer')}?wait=0`,
        }),
      )
    const first = await poll(crypto.randomUUID())
    expect(first.status).toBe(200)
    expect(await first.text()).toBe('X')
    const second = await poll(crypto.randomUUID())
    expect(second.status).toBe(200)
    expect(await second.text()).toBe('Y')
  })

  test('answers CORS preflight for browser peers', async () => {
    const relay = Relay.create()
    const response = await relay.fetch(
      new Request(relayUrl(channel, 'consumer'), {
        headers: {
          'access-control-request-headers': 'content-type,content-digest,signature,signature-input',
          'access-control-request-method': 'POST',
          origin: 'https://app.example',
        },
        method: 'OPTIONS',
      }),
    )
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-headers')).toContain('Content-Digest')
  })

  test('mounts under a custom `path`', async () => {
    const relay = Relay.create({ path: '/relay' })
    const response = await relay.fetch(
      signedRequest({
        body: '{}',
        keypair: Crypto.randomKeypair(),
        method: 'POST',
        url: `https://relay.test/relay/${channel}/consumer`,
      }),
    )
    expect(response.status).toBe(202)
  })
})
