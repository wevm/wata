import type { Hex } from 'ox'
import { Base64, Bytes, Ed25519 } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Aead, Discovery, Schema, Wata, mobileLink } from 'wata'
import { Wata as HostWata, mobileLink as hostMobileLink } from 'wata/host'
import { z } from 'zod/mini'

import type * as MobileLink from '../../core/internal/mobileLink.js'

const callbackUrl = 'exampleapp://callback'
const hostUrl = 'https://wallet.example/auth/mobile-link'

const schema = Schema.create({
  methods: {
    ping: Schema.method({
      params: z.tuple([]),
      result: z.object({
        ok: z.literal(true),
        transport: z.string(),
      }),
    }),
  },
})

type Pair = {
  consumer: Wata.Consumer<typeof schema, readonly [ReturnType<typeof mobileLink>]>
  consumerTransport: ReturnType<typeof mobileLink>
  host: HostWata.Host<typeof schema, readonly [ReturnType<typeof hostMobileLink>]>
  hostTransport: ReturnType<typeof hostMobileLink>
  opened: string[]
}

function createPair(options: createPair.Options = {}): Pair {
  const keypair = Ed25519.createKeyPair()
  const publicKey = identityPublicKey(keypair.privateKey)
  const opened: string[] = []
  let consumerTransport!: ReturnType<typeof mobileLink>
  let hostTransport!: ReturnType<typeof hostMobileLink>

  const open = async (url: string) => {
    const next = options.tamper?.(url) ?? url
    opened.push(next)
    if (next.startsWith(hostUrl)) await hostTransport.handle(next)
    else await consumerTransport.handle(next)
  }

  consumerTransport = mobileLink({
    callbackUrl,
    identity: { deepLinkUrl: hostUrl, publicKey },
    open,
  })
  hostTransport = hostMobileLink({
    open,
    responseTimeout: 50,
    scheme: 'examplewallet',
    universalLink: hostUrl,
  })

  const consumer = Wata.create({ schema, transports: [consumerTransport] })
  const host = HostWata.create({
    privateKey: keypair.privateKey,
    schema,
    transports: [hostTransport],
  })

  host.on('request', (event) => {
    if (event.method === 'ping') return { ok: true, transport: event.transport }
    return undefined
  })

  return { consumer, consumerTransport, host, hostTransport, opened }
}

declare namespace createPair {
  type Options = {
    tamper?: ((url: string) => string) | undefined
  }
}

describe('mobileLink', () => {
  test('round-trips a typed request through direct URL handlers', async () => {
    const { consumer, host } = createPair()

    const response = await consumer.send({ method: 'ping', params: [] })

    expect(response).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "ok": true,
          "transport": "mobileLink",
        },
      }
    `)

    await consumer.close()
    await host.close()
  })

  test('discovery mode auto-fetches the host document', async () => {
    const keypair = Ed25519.createKeyPair()
    const publicKey = identityPublicKey(keypair.privateKey)
    const document: Discovery.HostDocument = {
      id: 'wallet.example',
      identity_pubkey: publicKey,
      name: 'Example Wallet',
      origin: 'https://wallet.example',
      transports: {
        'mobile-link': {
          scheme: 'examplewallet',
          universal_link: hostUrl,
        },
      },
      version: '1.0',
    }
    const fetched: string[] = []
    let consumerTransport!: ReturnType<typeof mobileLink>
    let hostTransport!: ReturnType<typeof hostMobileLink>
    const open = async (url: string) => {
      if (url.startsWith(hostUrl)) await hostTransport.handle(url)
      else await consumerTransport.handle(url)
    }
    consumerTransport = mobileLink({
      callbackUrl,
      fetch: async (input) => {
        fetched.push(String(input))
        return new Response(JSON.stringify(document), {
          headers: { 'content-type': 'application/json' },
        })
      },
      host: 'https://wallet.example',
      open,
    })
    hostTransport = hostMobileLink({
      open,
      responseTimeout: 50,
      scheme: 'examplewallet',
      universalLink: hostUrl,
    })
    const consumer = Wata.create({ schema, transports: [consumerTransport] })
    const host = HostWata.create({
      privateKey: keypair.privateKey,
      schema,
      transports: [hostTransport],
    })
    host.on('request', (event) => {
      if (event.method === 'ping') return { ok: true, transport: event.transport }
      return undefined
    })

    const response = await consumer.send({ method: 'ping', params: [] })

    expect({ fetched, response }).toMatchInlineSnapshot(`
      {
        "fetched": [
          "https://wallet.example/.well-known/urpc/host.json",
        ],
        "response": {
          "id": 1,
          "result": {
            "ok": true,
            "transport": "mobileLink",
          },
        },
      }
    `)

    await consumer.close()
    await host.close()
  })

  test('pinned mode performs no discovery fetch', async () => {
    const { consumer, host } = createPair()

    const response = await consumer.send({ method: 'ping', params: [] })

    expect(response.result).toMatchInlineSnapshot(`
      {
        "ok": true,
        "transport": "mobileLink",
      }
    `)

    await consumer.close()
    await host.close()
  })

  test('host discovery publishes the mobile-link binding', async () => {
    const privateKey = `0x${'11'.repeat(32)}` as Hex.Hex
    const host = HostWata.create({
      baseUrl: 'https://wallet.example',
      meta: { name: 'Example Wallet' },
      privateKey,
      transports: [
        hostMobileLink({
          path: '/auth/mobile-link',
          scheme: 'examplewallet',
        }),
      ],
    })

    const response = await host.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )

    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "id": "wallet.example",
        "identity_pubkey": "0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc",
        "name": "Example Wallet",
        "origin": "https://wallet.example",
        "transports": {
          "mobile-link": {
            "scheme": "examplewallet",
            "universal_link": "https://wallet.example/auth/mobile-link",
          },
        },
        "version": "1.0",
      }
    `)
  })

  test('invalid identity signatures reject the session', async () => {
    const { consumer } = createPair({
      tamper(url) {
        return updateFrame(url, (frame) => {
          if (frame.type !== 'ready') return frame
          return { ...frame, identity_sig: 'AQID' }
        })
      },
    })

    await expect(
      consumer.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[ProtocolError: invalid mobileLink identity signature]`,
    )
  })

  test('tampered encrypted messages surface Aead.OpenError', async () => {
    const { consumer, host } = createPair({
      tamper(url) {
        return updateFrame(url, (frame) => {
          if (frame.type !== 'message' || !url.startsWith(callbackUrl)) return frame
          return {
            ...frame,
            message: {
              ...frame.message,
              payload: {
                ...frame.message.payload,
                ct: `A${frame.message.payload.ct.slice(1)}`,
              },
            },
          }
        })
      },
    })
    const errors: Error[] = []
    consumer.on('error', (error) => errors.push(error))

    const pending = consumer.send({ method: 'ping', params: [] }).catch((error: Error) => error)
    await waitFor(() => errors.length > 0)
    await consumer.close()
    await host.close()
    await pending

    expect(errors[0]).toBeInstanceOf(Aead.OpenError)
  })

  test('host `.fetch` returns redirects carrying callback frames', async () => {
    const keypair = Ed25519.createKeyPair()
    const publicKey = identityPublicKey(keypair.privateKey)
    const redirects: unknown[] = []
    let consumerTransport!: ReturnType<typeof mobileLink>
    const hostTransport = hostMobileLink({
      responseTimeout: 50,
      scheme: 'examplewallet',
      universalLink: hostUrl,
    })
    consumerTransport = mobileLink({
      callbackUrl,
      identity: { deepLinkUrl: hostUrl, publicKey },
      open: async (url) => {
        const response = await hostTransport.fetch(new Request(url))
        const location = response.headers.get('location')
        redirects.push({
          location: location ? new URL(location).protocol : null,
          status: response.status,
        })
        if (location) await consumerTransport.handle(location)
      },
    })
    const consumer = Wata.create({ schema, transports: [consumerTransport] })
    const host = HostWata.create({
      privateKey: keypair.privateKey,
      schema,
      transports: [hostTransport],
    })
    host.on('request', (event) => {
      if (event.method === 'ping') return { ok: true, transport: event.transport }
      return undefined
    })

    const response = await consumer.send({ method: 'ping', params: [] })

    expect({ redirects, response }).toMatchInlineSnapshot(`
      {
        "redirects": [
          {
            "location": "exampleapp:",
            "status": 302,
          },
          {
            "location": "exampleapp:",
            "status": 302,
          },
        ],
        "response": {
          "id": 1,
          "result": {
            "ok": true,
            "transport": "mobileLink",
          },
        },
      }
    `)
  })

  test('post-ready URL frames do not expose plaintext RPC method names', async () => {
    const { consumer, host, opened } = createPair()

    await consumer.send({ method: 'ping', params: [] })

    expect(
      opened.slice(1).some((url) => decodeURIComponent(url).includes('ping')),
    ).toMatchInlineSnapshot(`false`)

    await consumer.close()
    await host.close()
  })
})

function identityPublicKey(privateKey: Hex.Hex): string {
  return Base64.fromBytes(Bytes.from(Ed25519.getPublicKey({ privateKey })), {
    pad: false,
    url: true,
  })
}

function updateFrame(url: string, update: (frame: MobileLink.Frame) => MobileLink.Frame): string {
  const next = new URL(url)
  const value = next.searchParams.get('urpc')
  if (!value) return url
  next.searchParams.set(
    'urpc',
    Base64.fromBytes(
      new TextEncoder().encode(
        JSON.stringify(
          update(JSON.parse(new TextDecoder().decode(Base64.toBytes(value))) as MobileLink.Frame),
        ),
      ),
      { pad: false, url: true },
    ),
  )
  return next.toString()
}

async function waitFor(predicate: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
