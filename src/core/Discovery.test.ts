import { Discovery, Errors } from 'wata'
import { describe, expect, test, vi } from 'vp/test'

const validHostJson = {
  version: '1.0' as const,
  origin: 'https://wallet.example',
  id: 'wallet.example',
  name: 'Example Wallet',
  identity_pubkey: '0x' + '11'.repeat(32),
  transports: {
    relay: { url: 'https://relay.example/v1' },
    window: { url: 'https://wallet.example/urpc/embed' },
  },
}

const validConsumerJson = {
  version: '1.0' as const,
  origin: 'https://app.example',
  id: 'app.example',
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
        "id": "wallet.example",
        "identity_pubkey": "0x1111111111111111111111111111111111111111111111111111111111111111",
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

  test('rejects a non-hex identity_pubkey', () => {
    expect(() =>
      Discovery.parseHost({ ...validHostJson, identity_pubkey: 'not-hex' }),
    ).toThrowError(Errors.ProtocolError)
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

  test('rejects identity_pubkey on consumer.json (host-only field)', () => {
    expect(
      Discovery.parseConsumer({
        ...validConsumerJson,
        identity_pubkey: '0x' + '22'.repeat(32),
      }),
    ).not.toHaveProperty('identity_pubkey')
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
