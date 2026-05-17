import { describe, expect, test, vi } from 'vp/test'
import { Discovery, Errors } from 'wata'

// 43-char unpadded base64url Ed25519 pubkey per uRPC discovery.md §2.2.
const validIdentityPubkey = 'A'.repeat(43)

const validHostJson = {
  id: 'wallet.example',
  identity_pubkey: validIdentityPubkey,
  name: 'Example Wallet',
  origin: 'https://wallet.example',
  transports: {
    relay: { url: 'https://relay.example/v1' },
    window: { url: 'https://wallet.example/urpc/embed' },
  },
  version: '1.0' as const,
}

const validConsumerJson = {
  callback_urls: ['https://app.example/cb'],
  id: 'app.example',
  origin: 'https://app.example',
  version: '1.0' as const,
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
        "id": "wallet.example",
        "identity_pubkey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "name": "Example Wallet",
        "origin": "https://wallet.example",
        "transports": {
          "relay": {
            "url": "https://relay.example/v1",
          },
          "window": {
            "url": "https://wallet.example/urpc/embed",
          },
        },
        "version": "1.0",
      }
    `)
  })

  test('preserves unknown transport keys verbatim (forward compat)', () => {
    const parsed = Discovery.parseHost({
      ...validHostJson,
      transports: { relay: { url: 'https://relay.example' }, 'future-transport': { foo: 1 } },
    })
    expect(parsed.transports['future-transport']).toMatchInlineSnapshot(`
      {
        "foo": 1,
      }
    `)
  })

  test('drops malformed known transport bindings (graceful degradation)', () => {
    const parsed = Discovery.parseHost({
      ...validHostJson,
      transports: {
        relay: { url: 'https://relay.example' },
        'mobile-link': { scheme: 'examplewallet' /* missing universal_link */ },
      },
    })
    expect(parsed.transports['mobile-link']).toBeUndefined()
    expect(parsed.transports.relay).toMatchInlineSnapshot(`
      {
        "url": "https://relay.example",
      }
    `)
  })

  test('rejects an invalid version', () => {
    expect(() => Discovery.parseHost({ ...validHostJson, version: '2.0' })).toThrowError(
      Errors.ProtocolError,
    )
  })

  test('rejects a missing origin', () => {
    const { origin: _, ...rest } = validHostJson
    expect(() => Discovery.parseHost(rest)).toThrowError(Errors.ProtocolError)
  })

  test('rejects a missing id', () => {
    const { id: _, ...rest } = validHostJson
    expect(() => Discovery.parseHost(rest)).toThrowError(Errors.ProtocolError)
  })

  test('rejects a hex-formatted identity_pubkey (spec mandates unpadded base64url)', () => {
    expect(() =>
      Discovery.parseHost({ ...validHostJson, identity_pubkey: `0x${'11'.repeat(32)}` }),
    ).toThrowError(Errors.ProtocolError)
  })

  test('rejects an identity_pubkey of the wrong length', () => {
    expect(() =>
      Discovery.parseHost({ ...validHostJson, identity_pubkey: 'A'.repeat(42) }),
    ).toThrowError(Errors.ProtocolError)
  })

  test('rejects a missing identity_pubkey (required per spec §2.2)', () => {
    const { identity_pubkey: _, ...rest } = validHostJson
    expect(() => Discovery.parseHost(rest)).toThrowError(Errors.ProtocolError)
  })

  test('rejects an http:// relay url', () => {
    expect(() =>
      Discovery.parseHost({
        ...validHostJson,
        transports: { relay: { url: 'http://relay.example' } },
      }),
    ).toThrowError(Errors.ProtocolError)
  })

  test('rejects an empty transports map', () => {
    expect(() => Discovery.parseHost({ ...validHostJson, transports: {} })).toThrowError(
      Errors.ProtocolError,
    )
  })
})

describe('parseConsumer', () => {
  test('returns the parsed document', () => {
    expect(Discovery.parseConsumer(validConsumerJson)).toMatchInlineSnapshot(`
      {
        "callback_urls": [
          "https://app.example/cb",
        ],
        "id": "app.example",
        "origin": "https://app.example",
        "version": "1.0",
      }
    `)
  })

  test('rejects a non-https callback_urls entry', () => {
    expect(() =>
      Discovery.parseConsumer({ ...validConsumerJson, callback_urls: ['http://app.example/cb'] }),
    ).toThrowError(Errors.ProtocolError)
  })

  test('rejects a wildcard callback_urls entry', () => {
    expect(() =>
      Discovery.parseConsumer({
        ...validConsumerJson,
        callback_urls: ['https://*.app.example/cb'],
      }),
    ).toThrowError(Errors.ProtocolError)
  })

  test('rejects a path-wildcard callback_urls entry', () => {
    expect(() =>
      Discovery.parseConsumer({
        ...validConsumerJson,
        callback_urls: ['https://app.example/cb/*'],
      }),
    ).toThrowError(Errors.ProtocolError)
  })

  test('preserves identity_pubkey on consumer.json (required for webhook-callback per §5.8)', () => {
    const parsed = Discovery.parseConsumer({
      ...validConsumerJson,
      identity_pubkey: 'A'.repeat(43),
    })
    expect(parsed.identity_pubkey).toBe('A'.repeat(43))
  })

  test('rejects malformed identity_pubkey on consumer.json', () => {
    expect(() =>
      Discovery.parseConsumer({
        ...validConsumerJson,
        identity_pubkey: 'too-short',
      }),
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

  test('throws ProtocolError when the document origin does not match the fetch origin', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        ...validHostJson,
        origin: 'https://attacker.example',
      })) as typeof fetch
    await expect(
      Discovery.fetchHost('https://wallet.example', { fetch: fetchFn }),
    ).rejects.toThrowError(Errors.ProtocolError)
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
        headers: { 'content-type': 'application/json' },
        status: 200,
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
    expect(consumer.id).toBe(validConsumerJson.id)
  })

  test('throws ProtocolError when the document origin does not match the fetch origin', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        ...validConsumerJson,
        origin: 'https://attacker.example',
      })) as typeof fetch
    await expect(
      Discovery.fetchConsumer('https://app.example', { fetch: fetchFn }),
    ).rejects.toThrowError(Errors.ProtocolError)
  })
})

describe('response-size limit', () => {
  test('rejects when content-length exceeds 64 KiB', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify(validHostJson), {
        headers: {
          'content-length': String(64 * 1024 + 1),
          'content-type': 'application/json',
        },
        status: 200,
      })) as typeof fetch
    await expect(
      Discovery.fetchHost('https://wallet.example', { fetch: fetchFn }),
    ).rejects.toThrowError(Errors.ProtocolError)
  })

  test('rejects when streamed body exceeds 64 KiB (missing content-length)', async () => {
    // Stream a giant chunked body without a `content-length` header so
    // the size check happens during the streaming read, not upfront.
    const fetchFn = (async () => {
      const oversized = new Uint8Array(64 * 1024 + 16).fill(32) // 64 KiB + 16 bytes of spaces
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized)
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    }) as typeof fetch
    await expect(
      Discovery.fetchHost('https://wallet.example', { fetch: fetchFn }),
    ).rejects.toThrowError(Errors.ProtocolError)
  })
})

describe('redirect handling', () => {
  test('rejects any 3xx redirect (cross-origin forbidden per spec §2.5)', async () => {
    const fetchFn = (async () =>
      new Response(null, {
        headers: { location: 'https://attacker.example/host.json' },
        status: 302,
      })) as typeof fetch
    await expect(
      Discovery.fetchHost('https://wallet.example', { fetch: fetchFn }),
    ).rejects.toThrowError(Errors.ProtocolError)
  })
})

describe('etag revalidation', () => {
  test('sends If-None-Match on the second fetch and returns the cached body on 304', async () => {
    // Use a unique origin so other tests' cache entries don't bleed in.
    const origin = 'https://etag-host.example'
    const document = { ...validHostJson, id: 'etag-host.example', origin }
    const tag = '"etag-host-v1"'

    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined)
      if (headers.get('if-none-match') === tag)
        return new Response(null, { headers: { etag: tag }, status: 304 })
      return new Response(JSON.stringify(document), {
        headers: { 'content-type': 'application/json', etag: tag },
        status: 200,
      })
    }) as unknown as typeof fetch

    const first = await Discovery.fetchHost(origin, { fetch: fetchFn })
    const second = await Discovery.fetchHost(origin, { fetch: fetchFn })
    expect(first).toEqual(second)

    // Second call must have sent If-None-Match: <etag>.
    const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls.length).toMatchInlineSnapshot(`2`)
    expect(
      new Headers(calls[1]![1].headers as HeadersInit).get('if-none-match'),
    ).toMatchInlineSnapshot(`""etag-host-v1""`)
  })
})
