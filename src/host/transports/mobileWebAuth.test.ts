import { Base64, Bytes, Ed25519 } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Discovery, Envelope, Schema, Wata, mobileWebAuth } from 'wata'
import { Wata as HostWata, mobileWebAuth as hostMobileWebAuth } from 'wata/host'
import { z } from 'zod/mini'

const callbackUrl = 'com.example.app://callback'
const consumerId = 'https://app.example'
const hostUrl = 'https://wallet.example/auth/mobile'

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
  callbacks: string[]
  consumer: Omit<
    Wata.Consumer<typeof schema, readonly [ReturnType<typeof mobileWebAuth>]>,
    'fetch'
  > & { fetch: (request: Request) => Promise<Response> }
  fetches: string[]
  host: HostWata.Host<typeof schema, readonly [ReturnType<typeof hostMobileWebAuth>]>
  opened: string[]
}

function createPair(
  options: {
    onCallback?: ((url: string) => string | Promise<string>) | undefined
  } = {},
): Pair {
  const callbacks: string[] = []
  const fetches: string[] = []
  const privateKey = Ed25519.createKeyPair().privateKey
  const opened: string[] = []
  let consumer!: Pair['consumer']
  let host!: Pair['host']

  const open = async (url: string) => {
    opened.push(url)
    const get = await host.fetch(new Request(url))
    const state = await get.text()
    const form = new FormData()
    form.set('state', state)
    const post = await host.fetch(new Request(hostUrl, { body: form, method: 'POST' }))
    const location = post.headers.get('location')
    if (location) {
      callbacks.push(location)
      const callback = options.onCallback ? await options.onCallback(location) : location
      await consumer.mobileWebAuth.handle(callback)
    }
  }

  consumer = Wata.create({
    baseUrl: consumerId,
    meta: { name: 'Example App' },
    schema,
    transports: [
      mobileWebAuth({
        callbackUrl,
        fetch: async (input): Promise<Response> => {
          fetches.push(String(input))
          return await host.fetch(new Request(String(input)))
        },
        host: 'https://wallet.example',
        open,
      }),
    ],
  }) as unknown as Pair['consumer']
  host = HostWata.create({
    baseUrl: 'https://wallet.example',
    meta: { name: 'Example Wallet' },
    privateKey,
    schema,
    transports: [
      hostMobileWebAuth({
        fetch: async (input): Promise<Response> => {
          return await consumer.fetch(new Request(String(input)))
        },
        html: {
          authenticate: async ({ actions, request }) => {
            const form = await request.formData()
            return Response.redirect(await actions.approve(String(form.get('state'))), 302)
          },
          render: ({ record }) => new Response(record?.state),
        },
        path: '/auth/mobile',
      }),
    ],
  })

  host.on('request', (event) => {
    if (event.method === 'ping') return { ok: true, transport: event.transport }
    return undefined
  })

  return { callbacks, consumer, fetches, host, opened }
}

describe('mobileWebAuth', () => {
  test('round-trips a typed request through browser auth and callback URLs', async () => {
    const { consumer, host, opened } = createPair()

    const response = await consumer.mobileWebAuth.send({ method: 'ping', params: [] })

    expect({
      opened: opened.map((url) => new URL(url).origin + new URL(url).pathname),
      response,
    }).toMatchInlineSnapshot(`
      {
        "opened": [
          "https://wallet.example/auth/mobile",
        ],
        "response": {
          "id": 1,
          "result": {
            "ok": true,
            "transport": "mobileWebAuth",
          },
        },
      }
    `)

    await consumer.close()
    await host.close()
  })

  test('fetches host discovery and keeps the callback frame encrypted', async () => {
    const { callbacks, consumer, fetches, host } = createPair()

    await consumer.mobileWebAuth.send({ method: 'ping', params: [] })

    expect({
      callbackContainsMethod: callbacks[0]?.includes('ping'),
      callbackOrigin: callbacks[0] ? new URL(callbacks[0]).origin : undefined,
      fetched: fetches.map((url) => new URL(url).href),
    }).toMatchInlineSnapshot(`
      {
        "callbackContainsMethod": false,
        "callbackOrigin": "null",
        "fetched": [
          "https://wallet.example/.well-known/urpc/host.json",
        ],
      }
    `)

    await consumer.close()
    await host.close()
  })

  test('rejects tampered encrypted callback frames', async () => {
    const { consumer, host } = createPair({
      onCallback: (location) => {
        const url = new URL(location)
        const message = url.searchParams.get('message') ?? ''
        const envelope = Envelope.parse(
          JSON.parse(new TextDecoder().decode(Base64.toBytes(message))),
        )
        if (envelope.type !== 'encrypted') return location
        envelope.payload.ct = `${envelope.payload.ct.slice(0, -1)}${
          envelope.payload.ct.endsWith('A') ? 'B' : 'A'
        }`
        url.searchParams.set(
          'message',
          Base64.fromBytes(Bytes.fromString(JSON.stringify(envelope)), {
            pad: false,
            url: true,
          }),
        )
        return url.toString()
      },
    })

    await expect(
      consumer.mobileWebAuth.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Aead.OpenError: AEAD authentication failed]`)

    await consumer.close()
    await host.close()
  })

  test('host discovery publishes the mobile-web-auth binding', async () => {
    const keypair = Ed25519.createKeyPair()
    const host = HostWata.create({
      baseUrl: 'https://wallet.example',
      meta: { name: 'Example Wallet' },
      privateKey: keypair.privateKey,
      transports: [
        hostMobileWebAuth({
          html: {
            authenticate: () => new Response(null),
            render: () => new Response(null),
          },
          path: '/auth/mobile',
        }),
      ],
    })

    const response = await host.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )

    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "id": "wallet.example",
        "identity_pubkey": "${identityPublicKey(keypair.privateKey)}",
        "name": "Example Wallet",
        "origin": "https://wallet.example",
        "transports": {
          "mobile-web-auth": {
            "auth_url": "https://wallet.example/auth/mobile",
          },
        },
        "version": "1.0",
      }
    `)

    await host.close()
  })

  test('host rejects callbacks not published in consumer discovery', async () => {
    const keypair = Ed25519.createKeyPair()
    const host = HostWata.create({
      privateKey: keypair.privateKey,
      transports: [
        hostMobileWebAuth({
          fetch: async () =>
            new Response(
              JSON.stringify({
                callback_urls: ['com.example.app://other'],
                id: 'app.example',
                origin: consumerId,
                version: '1.0',
              } satisfies Discovery.ConsumerDocument),
              { headers: { 'content-type': 'application/json' } },
            ),
          html: {
            authenticate: () => new Response(null),
            render: () => new Response(null),
          },
          path: '/auth/mobile',
        }),
      ],
    })
    const url = new URL(hostUrl)
    url.searchParams.set('callback', callbackUrl)
    url.searchParams.set('id', consumerId)
    url.searchParams.set('pubkey', Base64.fromBytes(Bytes.random(32), { pad: false, url: true }))
    url.searchParams.set('state', Base64.fromBytes(Bytes.random(16), { pad: false, url: true }))
    url.searchParams.set('version', '1')

    const response = await host.fetch(new Request(url))

    expect({
      body: await response.text(),
      location: response.headers.get('location'),
      status: response.status,
    }).toMatchInlineSnapshot(`
      {
        "body": "consumer verification failed",
        "location": null,
        "status": 403,
      }
    `)

    await host.close()
  })
})

function identityPublicKey(privateKey: `0x${string}`): string {
  return Base64.fromBytes(Bytes.from(Ed25519.getPublicKey({ privateKey })), {
    pad: false,
    url: true,
  })
}
