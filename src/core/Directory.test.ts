import { describe, expect, test } from 'vp/test'
import { Directory as DirectoryServer, Store } from 'wata/server'

import { serve } from '../../test/server.js'
import * as Directory from './Directory.js'

const projectId = 'ba7804e457fbb5f1375cbdc14e679617'
const identityPubkey = 'A'.repeat(43)

/** Build a `host.json` body for a host served at `origin`. */
function hostDoc(
  origin: string,
  spec: { capabilities?: readonly string[]; name: string; transports?: Record<string, unknown> },
) {
  return {
    id: spec.name,
    identity_pubkey: identityPubkey,
    name: spec.name,
    origin,
    transports: spec.transports ?? { relay: { url: 'https://relay.example/v1' } },
    version: '1.0',
    ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
  }
}

const metamask = {
  chains: ['eip155:1'],
  desktop: { native: '', universal: '' },
  homepage: 'https://metamask.io',
  id: 'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
  image_id: 'img-mm',
  mobile: { native: 'metamask://', universal: 'https://metamask.app.link' },
  name: 'MetaMask',
}

/** Replace ephemeral loopback origins (random ports) so snapshots stay stable. */
function redact(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://server'))
}

describe('Directory.urpc', () => {
  test('lists hosts indexed by a real Directory server', async () => {
    const store = Store.memory()
    const host = await serve((request) =>
      Response.json(
        hostDoc(new URL(request.url).origin, { capabilities: ['deposits'], name: 'Acme Wallet' }),
      ),
    )
    await DirectoryServer.crawl({ origins: [host.url], store })
    const directoryServer = DirectoryServer.create({ store })
    const directory = await serve((request) => directoryServer.fetch(request))

    const { items } = await Directory.urpc({ transport: 'relay', url: directory.url })()
    expect(redact(items)).toMatchInlineSnapshot(`
    	[
    	  {
    	    "capabilities": [
    	      "deposits",
    	    ],
    	    "id": "Acme Wallet",
    	    "name": "Acme Wallet",
    	    "origin": "http://server",
    	    "transports": {
    	      "relay": {},
    	    },
    	    "wellKnownUrl": "http://server/.well-known/urpc/host.json",
    	  },
    	]
    `)
  })

  test('forwards the transport filter to the server', async () => {
    const store = Store.memory()
    const origins: string[] = []
    for (const spec of [
      { name: 'Relay Host', transports: { relay: { url: 'https://relay.example/v1' } } },
      {
        name: 'Device Host',
        transports: {
          'device-code': { register_url: 'https://d.example/r', token_url: 'https://d.example/t' },
        },
      },
    ]) {
      const host = await serve((request) =>
        Response.json(hostDoc(new URL(request.url).origin, spec)),
      )
      origins.push(host.url)
    }
    await DirectoryServer.crawl({ origins, store })
    const directoryServer = DirectoryServer.create({ store })
    const directory = await serve((request) => directoryServer.fetch(request))

    const { items } = await Directory.urpc({ transport: 'relay', url: directory.url })()
    expect(items.map((item) => item.name)).toMatchInlineSnapshot(`
    	[
    	  "Relay Host",
    	]
    `)
  })

  test('forwards the capability filter to the server', async () => {
    const store = Store.memory()
    const origins: string[] = []
    for (const spec of [
      { capabilities: ['deposits', 'identity'], name: 'Full Host' },
      { capabilities: ['deposits'], name: 'Basic Host' },
    ]) {
      const host = await serve((request) =>
        Response.json(hostDoc(new URL(request.url).origin, spec)),
      )
      origins.push(host.url)
    }
    await DirectoryServer.crawl({ origins, store })
    const directoryServer = DirectoryServer.create({ store })
    const directory = await serve((request) => directoryServer.fetch(request))

    const { items } = await Directory.urpc({ capability: ['identity'], url: directory.url })()
    expect(items.map((item) => item.name)).toMatchInlineSnapshot(`
    	[
    	  "Full Host",
    	]
    `)
  })

  test('throws on a non-2xx response', async () => {
    const server = await serve(() => Response.json({}, { status: 503 }))
    await expect(Directory.urpc({ url: server.url })()).rejects.toThrowErrorMatchingInlineSnapshot(`
    	[BaseError: directory returned non-2xx
    	Details: /v1/hosts: 503 Service Unavailable]
    `)
  })

  test('throws on an invalid response shape', async () => {
    const server = await serve(() => Response.json({ items: [{ id: 'x' }] }))
    await expect(Directory.urpc({ url: server.url })()).rejects.toThrowErrorMatchingInlineSnapshot(`
    	[BaseError: invalid directory response
    	Details: Invalid input; expected an https:// URL; expected an https:// URL]
    `)
  })
})

describe('Directory.walletConnectSource', () => {
  test('lists wallets advertising a walletConnect transport', async () => {
    const server = await serve(() =>
      Response.json({ count: 1, listings: { [metamask.id]: metamask }, total: 567 }),
    )
    const { items } = await Directory.walletConnectSource({ apiUrl: server.url, projectId })()
    expect(redact(items)).toMatchInlineSnapshot(`
    	[
    	  {
    	    "icon": "http://server/v3/logo/md/img-mm?projectId=ba7804e457fbb5f1375cbdc14e679617",
    	    "id": "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96",
    	    "name": "MetaMask",
    	    "transports": {
    	      "walletConnect": {
    	        "chains": [
    	          "eip155:1",
    	        ],
    	        "desktop": {
    	          "native": "",
    	          "universal": "",
    	        },
    	        "mobile": {
    	          "native": "metamask://",
    	          "universal": "https://metamask.app.link",
    	        },
    	      },
    	    },
    	  },
    	]
    `)
    expect(redact(server.requests[0]!.href)).toMatchInlineSnapshot(
      `"http://server/v3/wallets?projectId=ba7804e457fbb5f1375cbdc14e679617"`,
    )
  })

  test('forwards filters as query params', async () => {
    const server = await serve(() => Response.json({ listings: {} }))
    await Directory.walletConnectSource({
      apiUrl: server.url,
      chains: ['eip155:1', 'eip155:10'],
      entries: 5,
      page: 2,
      platforms: ['ios', 'android'],
      projectId,
      search: 'rainbow',
    })()
    expect(redact(server.requests[0]!.href)).toMatchInlineSnapshot(
      `"http://server/v3/wallets?projectId=ba7804e457fbb5f1375cbdc14e679617&entries=5&page=2&search=rainbow&chains=eip155%3A1%2Ceip155%3A10&platforms=ios%2Candroid"`,
    )
  })

  test('skips malformed listings and defaults missing platforms', async () => {
    const server = await serve(() =>
      Response.json({ listings: { bad: { name: 123 }, good: { id: 'a', name: 'A' } } }),
    )
    const { items } = await Directory.walletConnectSource({ apiUrl: server.url, projectId })()
    expect(redact(items)).toMatchInlineSnapshot(`
    	[
    	  {
    	    "id": "a",
    	    "name": "A",
    	    "transports": {
    	      "walletConnect": {
    	        "desktop": {},
    	        "mobile": {},
    	      },
    	    },
    	  },
    	]
    `)
  })

  test('throws on a non-2xx response', async () => {
    const server = await serve(() => Response.json({}, { status: 500 }))
    await expect(Directory.walletConnectSource({ apiUrl: server.url, projectId })()).rejects
      .toThrowErrorMatchingInlineSnapshot(`
    	[BaseError: WalletConnect directory returned non-2xx
    	Details: /v3/wallets: 500 Internal Server Error]
    `)
  })
})

describe('Directory.query', () => {
  test('merges items from multiple sources, preserving order', async () => {
    const a: Directory.Source = async () => ({
      items: [
        {
          id: 'a',
          name: 'A',
          origin: 'https://a.example',
          transports: { relay: {} },
          wellKnownUrl: 'https://a.example/.well-known/urpc/host.json',
        },
      ],
    })
    const b: Directory.Source = async () => ({
      items: [
        { id: 'b', name: 'B', transports: { walletConnect: { mobile: { native: 'b://' } } } },
      ],
    })
    const { items } = await Directory.query({ sources: [a, b] })
    expect(redact(items)).toMatchInlineSnapshot(`
    	[
    	  {
    	    "id": "a",
    	    "name": "A",
    	    "origin": "https://a.example",
    	    "transports": {
    	      "relay": {},
    	    },
    	    "wellKnownUrl": "https://a.example/.well-known/urpc/host.json",
    	  },
    	  {
    	    "id": "b",
    	    "name": "B",
    	    "transports": {
    	      "walletConnect": {
    	        "mobile": {
    	          "native": "b://",
    	        },
    	      },
    	    },
    	  },
    	]
    `)
  })

  test('resolves both walletConnect wallets and uRPC hosts', async () => {
    const store = Store.memory()
    const host = await serve((request) =>
      Response.json(
        hostDoc(new URL(request.url).origin, { capabilities: ['deposits'], name: 'Acme Wallet' }),
      ),
    )
    await DirectoryServer.crawl({ origins: [host.url], store })
    const directoryServer = DirectoryServer.create({ store })
    const directory = await serve((request) => directoryServer.fetch(request))

    const registry = await serve(() => Response.json({ listings: { [metamask.id]: metamask } }))

    const { items } = await Directory.query({
      transports: ['relay', 'walletConnect'],
      url: directory.url,
      walletConnect: { apiUrl: registry.url, projectId },
    })
    expect(redact(items)).toMatchInlineSnapshot(`
    	[
    	  {
    	    "capabilities": [
    	      "deposits",
    	    ],
    	    "id": "Acme Wallet",
    	    "name": "Acme Wallet",
    	    "origin": "http://server",
    	    "transports": {
    	      "relay": {},
    	    },
    	    "wellKnownUrl": "http://server/.well-known/urpc/host.json",
    	  },
    	  {
    	    "icon": "http://server/v3/logo/md/img-mm?projectId=ba7804e457fbb5f1375cbdc14e679617",
    	    "id": "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96",
    	    "name": "MetaMask",
    	    "transports": {
    	      "walletConnect": {
    	        "chains": [
    	          "eip155:1",
    	        ],
    	        "desktop": {
    	          "native": "",
    	          "universal": "",
    	        },
    	        "mobile": {
    	          "native": "metamask://",
    	          "universal": "https://metamask.app.link",
    	        },
    	      },
    	    },
    	  },
    	]
    `)
  })

  test('throws when a uRPC transport is listed without a url', async () => {
    await expect(Directory.query({ transports: ['relay'] })).rejects
      .toThrowErrorMatchingInlineSnapshot(`
    	[BaseError: \`url\` is required to list the 'relay' directory
    	Details: pass the uRPC directory server \`url\`]
    `)
  })

  test('throws when walletConnect is listed without config', async () => {
    await expect(Directory.query({ transports: ['walletConnect'] })).rejects
      .toThrowErrorMatchingInlineSnapshot(`
    	[BaseError: \`walletConnect\` config is required to list the 'walletConnect' directory
    	Details: pass \`walletConnect: { projectId }\`]
    `)
  })

  test('rejects if any source rejects', async () => {
    const ok: Directory.Source = async () => ({ items: [] })
    const bad: Directory.Source = async () => {
      throw new Error('boom')
    }
    await expect(
      Directory.query({ sources: [ok, bad] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: boom]`)
  })
})
