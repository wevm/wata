import { Discovery, Errors } from 'handshakes'
import { describe, expect, test, vi } from 'vp/test'

const validHostJson = {
  version: 1 as const,
  identity_pubkey: '0x' + '11'.repeat(32),
  relay_url: 'https://relay.example/v1',
}

const validConsumerJson = {
  version: 1 as const,
  identity_pubkey: '0x' + '22'.repeat(32),
  callback_urls: ['https://app.example/cb'],
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('hostUrl', () => {
  test('appends the well-known path', () => {
    expect(Discovery.hostUrl('https://wallet.example')).toMatchInlineSnapshot(
      '"https://wallet.example/.well-known/urpc/host.json"',
    )
  })

  test('strips trailing slashes from the origin', () => {
    expect(Discovery.hostUrl('https://wallet.example//')).toMatchInlineSnapshot(
      '"https://wallet.example/.well-known/urpc/host.json"',
    )
  })
})

describe('consumerUrl', () => {
  test('appends the well-known path', () => {
    expect(Discovery.consumerUrl('https://app.example')).toMatchInlineSnapshot(
      '"https://app.example/.well-known/urpc/consumer.json"',
    )
  })
})

describe('parseHost', () => {
  test('returns the parsed document', () => {
    expect(Discovery.parseHost(validHostJson)).toMatchInlineSnapshot(`
      {
        "identity_pubkey": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "relay_url": "https://relay.example/v1",
        "version": 1,
      }
    `)
  })

  test('rejects an invalid version', () => {
    expect(() => Discovery.parseHost({ ...validHostJson, version: 2 })).toThrowError(
      Errors.ProtocolError,
    )
  })

  test('rejects a non-hex identity_pubkey', () => {
    expect(() =>
      Discovery.parseHost({ ...validHostJson, identity_pubkey: 'not-hex' }),
    ).toThrowError(Errors.ProtocolError)
  })

  test('rejects an http:// relay_url', () => {
    expect(() =>
      Discovery.parseHost({ ...validHostJson, relay_url: 'http://relay.example' }),
    ).toThrowError(Errors.ProtocolError)
  })
})

describe('parseConsumer', () => {
  test('returns the parsed document', () => {
    expect(Discovery.parseConsumer(validConsumerJson)).toMatchInlineSnapshot(`
      {
        "callback_urls": [
          "https://app.example/cb",
        ],
        "identity_pubkey": "0x2222222222222222222222222222222222222222222222222222222222222222",
        "version": 1,
      }
    `)
  })

  test('rejects a non-https callback_urls entry', () => {
    expect(() =>
      Discovery.parseConsumer({ ...validConsumerJson, callback_urls: ['http://app.example/cb'] }),
    ).toThrowError(Errors.ProtocolError)
  })
})

describe('fetchHost', () => {
  test('fetches and parses host.json from the well-known path', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(validHostJson)) as unknown as typeof fetch
    const host = await Discovery.fetchHost('https://wallet.example', { fetch: fetchFn })
    expect(host.identity_pubkey).toBe(validHostJson.identity_pubkey)
    expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toBe(
      'https://wallet.example/.well-known/urpc/host.json',
    )
  })

  test('throws ProtocolError on non-2xx response', async () => {
    const fetchFn = (async () =>
      new Response('nope', { status: 404, statusText: 'Not Found' })) as typeof fetch
    await expect(
      Discovery.fetchHost('https://wallet.example', { fetch: fetchFn }),
    ).rejects.toThrowError(Errors.ProtocolError)
  })

  test('throws ProtocolError on invalid JSON', async () => {
    const fetchFn = (async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    await expect(
      Discovery.fetchHost('https://wallet.example', { fetch: fetchFn }),
    ).rejects.toThrowError(Errors.ProtocolError)
  })

  test('throws ProtocolError when the underlying fetch throws', async () => {
    const fetchFn = (async () => {
      throw new TypeError('connect ECONNREFUSED')
    }) as typeof fetch
    await expect(
      Discovery.fetchHost('https://wallet.example', { fetch: fetchFn }),
    ).rejects.toThrowError(Errors.ProtocolError)
  })
})

describe('fetchConsumer', () => {
  test('fetches and parses consumer.json from the well-known path', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(validConsumerJson)) as unknown as typeof fetch
    const consumer = await Discovery.fetchConsumer('https://app.example', { fetch: fetchFn })
    expect(consumer.identity_pubkey).toBe(validConsumerJson.identity_pubkey)
  })
})
