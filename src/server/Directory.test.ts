import { describe, expect, test } from 'vp/test'
import { Store } from 'wata'

import * as Directory from './Directory.js'

const publicKey = 'A'.repeat(43)

type HostOverrides = {
  capabilities?: readonly string[] | undefined
  icon?: string | undefined
  name?: string | undefined
  transports?: Record<string, unknown> | undefined
}

function hostDoc(origin: string, overrides: HostOverrides = {}) {
  const id = new URL(origin).hostname
  return {
    id,
    identity_pubkey: publicKey,
    name: overrides.name ?? id,
    origin,
    transports: overrides.transports ?? { relay: { url: 'https://relay.example/v1' } },
    version: '1.0' as const,
    ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
    ...(overrides.icon ? { icon: overrides.icon } : {}),
  }
}

/**
 * Build a `fetch` that serves each origin's `host.json`, or 404s for any
 * origin in `down`. Records the number of fetches made.
 */
function mockFetch(docs: Record<string, ReturnType<typeof hostDoc>>, down: readonly string[] = []) {
  let calls = 0
  const fetch = (async (input: string | URL | Request) => {
    calls++
    const url = String(input)
    for (const origin of down)
      if (url === `${origin}/.well-known/urpc/host.json`)
        return new Response('nope', { status: 404, statusText: 'Not Found' })
    for (const [origin, doc] of Object.entries(docs))
      if (url === `${origin}/.well-known/urpc/host.json`)
        return new Response(JSON.stringify(doc), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        })
    return new Response('nope', { status: 404, statusText: 'Not Found' })
  }) as unknown as typeof globalThis.fetch
  return {
    fetch,
    get calls() {
      return calls
    },
  }
}

async function queryItems(server: { fetch: (request: Request) => Promise<Response> }, search = '') {
  const response = await server.fetch(new Request(`https://directory.example/v1/hosts${search}`))
  return (await response.json()) as { cursor: string | null; items: { id: string }[] }
}

describe('schema.item', () => {
  test('parses a wire row and camelCases well_known_url', () => {
    expect(
      Directory.schema.item.parse({
        capabilities: ['deposits'],
        icon: 'https://wallet.example/icon.png',
        id: 'wallet.example',
        name: 'Example Wallet',
        origin: 'https://wallet.example',
        well_known_url: 'https://wallet.example/.well-known/urpc/host.json',
      }),
    ).toMatchInlineSnapshot(`
      {
        "capabilities": [
          "deposits",
        ],
        "icon": "https://wallet.example/icon.png",
        "id": "wallet.example",
        "name": "Example Wallet",
        "origin": "https://wallet.example",
        "wellKnownUrl": "https://wallet.example/.well-known/urpc/host.json",
      }
    `)
  })

  test('omits optional fields when absent', () => {
    expect(
      Directory.schema.item.parse({
        id: 'wallet.example',
        name: 'Example Wallet',
        origin: 'https://wallet.example',
        well_known_url: 'https://wallet.example/.well-known/urpc/host.json',
      }),
    ).toMatchInlineSnapshot(`
      {
        "id": "wallet.example",
        "name": "Example Wallet",
        "origin": "https://wallet.example",
        "wellKnownUrl": "https://wallet.example/.well-known/urpc/host.json",
      }
    `)
  })
})

describe('schema.response', () => {
  test('parses items and a null cursor', () => {
    const result = Directory.schema.response.parse({
      cursor: null,
      items: [
        {
          id: 'wallet.example',
          name: 'Example Wallet',
          origin: 'https://wallet.example',
          well_known_url: 'https://wallet.example/.well-known/urpc/host.json',
        },
      ],
    })
    expect(result.cursor).toBeNull()
    expect(result.items).toHaveLength(1)
  })
})

describe('crawl', () => {
  test('indexes valid hosts and serves them from create', async () => {
    const store = Store.memory()
    const origins = ['https://wallet.example', 'https://other.example']
    const { fetch } = mockFetch({
      'https://other.example': hostDoc('https://other.example'),
      'https://wallet.example': hostDoc('https://wallet.example'),
    })

    const summary = await Directory.crawl({ fetch, origins, store })
    expect(summary).toMatchInlineSnapshot(`
      {
        "failed": 0,
        "indexed": 2,
        "removed": 0,
        "skipped": 0,
      }
    `)

    const { items } = await queryItems(Directory.create({ store }))
    expect(items).toMatchInlineSnapshot(`
      [
        {
          "id": "other.example",
          "name": "other.example",
          "origin": "https://other.example",
          "well_known_url": "https://other.example/.well-known/urpc/host.json",
        },
        {
          "id": "wallet.example",
          "name": "wallet.example",
          "origin": "https://wallet.example",
          "well_known_url": "https://wallet.example/.well-known/urpc/host.json",
        },
      ]
    `)
  })

  test('skips fresh entries within the refresh interval', async () => {
    const store = Store.memory()
    const origins = ['https://wallet.example']
    const mock = mockFetch({ 'https://wallet.example': hostDoc('https://wallet.example') })

    await Directory.crawl({ fetch: mock.fetch, now: () => 1_000, origins, store })
    const second = await Directory.crawl({
      fetch: mock.fetch,
      now: () => 1_000 + 60_000,
      origins,
      store,
    })

    expect(mock.calls).toBe(1)
    expect(second).toMatchObject({ indexed: 0, skipped: 1 })
  })

  test('keeps an entry on transient failure but evicts after the stale threshold', async () => {
    const store = Store.memory()
    const origins = ['https://wallet.example']
    const up = mockFetch({ 'https://wallet.example': hostDoc('https://wallet.example') })
    const down = mockFetch({}, ['https://wallet.example'])
    const staleThreshold = 7 * 24 * 60 * 60 * 1000

    // t0: index successfully.
    await Directory.crawl({ fetch: up.fetch, now: () => 0, origins, store })

    // t1 (1h later): host down, but within the stale window → kept.
    // `maxRefreshInterval: 0` forces a re-probe despite the fresh success.
    const transient = await Directory.crawl({
      fetch: down.fetch,
      maxRefreshInterval: 0,
      now: () => 60 * 60 * 1000,
      origins,
      staleThreshold,
      store,
    })
    expect(transient).toMatchObject({ failed: 1, removed: 0 })
    expect((await queryItems(Directory.create({ store }))).items).toHaveLength(1)

    // t2 (8 days later): still down, past the stale window → evicted.
    const stale = await Directory.crawl({
      fetch: down.fetch,
      maxRefreshInterval: 0,
      now: () => 8 * 24 * 60 * 60 * 1000,
      origins,
      staleThreshold,
      store,
    })
    expect(stale).toMatchObject({ failed: 1, removed: 1 })
    expect((await queryItems(Directory.create({ store }))).items).toHaveLength(0)
  })
})

describe('create', () => {
  async function seeded() {
    const store = Store.memory()
    const { fetch } = mockFetch({
      'https://bank.example': hostDoc('https://bank.example', {
        capabilities: ['deposits', 'identity'],
        transports: { 'mobile-link': { scheme: 'bank', universal_link: 'https://bank.example/l' } },
      }),
      'https://wallet.example': hostDoc('https://wallet.example', {
        capabilities: ['deposits'],
        transports: { relay: { url: 'https://relay.example/v1' } },
      }),
    })
    await Directory.crawl({
      fetch,
      origins: ['https://wallet.example', 'https://bank.example'],
      store,
    })
    return store
  }

  test('filters by transport', async () => {
    const server = Directory.create({ store: await seeded() })
    const { items } = await queryItems(server, '?transport=mobile-link')
    expect(items.map((item) => item.id)).toMatchInlineSnapshot(`
      [
        "bank.example",
      ]
    `)
  })

  test('filters by capability with AND semantics', async () => {
    const server = Directory.create({ store: await seeded() })
    const both = await queryItems(server, '?capability=deposits&capability=identity')
    expect(both.items.map((item) => item.id)).toMatchInlineSnapshot(`
      [
        "bank.example",
      ]
    `)
    const one = await queryItems(server, '?capability=deposits')
    expect(one.items.map((item) => item.id)).toMatchInlineSnapshot(`
      [
        "bank.example",
        "wallet.example",
      ]
    `)
  })

  test('filters by free-text q over id / name', async () => {
    const server = Directory.create({ store: await seeded() })
    const { items } = await queryItems(server, '?q=wallet')
    expect(items.map((item) => item.id)).toMatchInlineSnapshot(`
      [
        "wallet.example",
      ]
    `)
  })

  test('paginates with an opaque keyset cursor', async () => {
    const server = Directory.create({ pageSize: 1, store: await seeded() })

    const first = await queryItems(server)
    expect(first.items.map((item) => item.id)).toEqual(['bank.example'])
    expect(first.cursor).toBeTypeOf('string')

    const second = await queryItems(server, `?cursor=${encodeURIComponent(first.cursor ?? '')}`)
    expect(second.items.map((item) => item.id)).toEqual(['wallet.example'])
    expect(second.cursor).toBeNull()
  })
})
