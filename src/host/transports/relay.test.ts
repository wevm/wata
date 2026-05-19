import type { Hex } from 'ox'
import { Base64, Bytes, Ed25519 } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Aead, Discovery, Schema, Wata, relay } from 'wata'
import { Wata as HostWata, relay as hostRelay } from 'wata/host'
import { relayServer } from 'wata/server'
import { z } from 'zod/mini'

const privateKey = `0x${'11'.repeat(32)}` as Hex.Hex
const relayUrl = 'https://relay.example/r'

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

let nextSession = 0

function createPair(options: createPair.Options = {}) {
  const server = relayServer({ responseTimeout: 25 })
  const bodies: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.method === 'POST') bodies.push(await request.clone().text())
    const response = await server.fetch(request)
    return options.tamper ? await options.tamper(response, request) : response
  }
  const sessionId = `session-${++nextSession}`
  const consumer = Wata.create({
    schema,
    transports: [
      relay({
        fetch,
        pairingSecret: options.consumerSecret ?? 'secret',
        sessionId,
        url: relayUrl,
      }),
    ],
  })
  const host = HostWata.create({
    schema,
    transports: [
      hostRelay({
        fetch,
        pairingSecret: options.hostSecret ?? 'secret',
        sessionId,
        url: relayUrl,
      }),
    ],
  })

  host.on('request', (event) => {
    if (event.method === 'ping') return { ok: true, transport: event.transport }
    return undefined
  })

  return { bodies, consumer, host }
}

declare namespace createPair {
  type Options = {
    consumerSecret?: string | undefined
    hostSecret?: string | undefined
    tamper?: ((response: Response, request: Request) => Promise<Response> | Response) | undefined
  }
}

describe('relay', () => {
  test('round-trips a typed request through the relay server', async () => {
    const { consumer, host } = createPair()

    const response = await consumer.send({ method: 'ping', params: [] })

    expect(response).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "ok": true,
          "transport": "relay",
        },
      }
    `)

    await consumer.close()
    await host.close()
  })

  test('discovery mode auto-fetches the host document', async () => {
    const server = relayServer({ responseTimeout: 25 })
    const fetched: string[] = []
    const sessionId = `session-${++nextSession}`
    const host = HostWata.create({
      baseUrl: 'https://wallet.example',
      meta: { name: 'Example Wallet' },
      privateKey,
      schema,
      transports: [
        hostRelay({
          fetch: (input, init) => server.fetch(new Request(input, init)),
          pairingSecret: 'secret',
          sessionId,
          url: relayUrl,
        }),
      ],
    })
    const hostFetch = host.fetch as unknown as (request: Request) => Promise<Response> | Response
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      fetched.push(request.url)
      if (request.url === Discovery.hostUrl('https://wallet.example'))
        return await hostFetch(request)
      return await server.fetch(request)
    }
    const consumer = Wata.create({
      schema,
      transports: [
        relay({
          fetch,
          host: 'https://wallet.example',
          pairingSecret: 'secret',
          sessionId,
        }),
      ],
    })
    host.on('request', (event) => {
      if (event.method === 'ping') return { ok: true, transport: event.transport }
      return undefined
    })

    const response = await consumer.send({ method: 'ping', params: [] })

    expect({ fetched: fetched[0], response }).toMatchInlineSnapshot(`
      {
        "fetched": "https://wallet.example/.well-known/urpc/host.json",
        "response": {
          "id": 1,
          "result": {
            "ok": true,
            "transport": "relay",
          },
        },
      }
    `)

    await consumer.close()
    await host.close()
  })

  test('direct mode performs no discovery fetch', async () => {
    const fetched: string[] = []
    const transport = relay({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        fetched.push(request.url)
        return await relayServer({ responseTimeout: 1 }).fetch(request)
      },
      pairingSecret: 'secret',
      sessionId: 'unused',
      url: relayUrl,
    })

    expect(transport.name).toMatchInlineSnapshot(`"relay"`)
    expect(fetched).toMatchInlineSnapshot(`[]`)

    await transport.close()
  })

  test('host discovery publishes a relay binding', async () => {
    const host = HostWata.create({
      baseUrl: 'https://wallet.example',
      meta: { name: 'Example Wallet' },
      privateKey,
      transports: [
        hostRelay({
          pairingSecret: 'secret',
          sessionId: 'session',
          url: relayUrl,
        }),
      ],
    })

    const hostFetch = host.fetch as unknown as (request: Request) => Promise<Response> | Response
    const response = await hostFetch(new Request(Discovery.hostUrl('https://wallet.example')))
    const body = await response.json()

    expect(body).toEqual({
      id: 'wallet.example',
      identity_pubkey: identityPublicKey(privateKey),
      name: 'Example Wallet',
      origin: 'https://wallet.example',
      transports: {
        relay: {
          url: 'https://relay.example/r',
        },
      },
      version: '1.0',
    })

    await host.close()
  })

  test('invalid pairing secrets surface Aead.OpenError', async () => {
    const errors: Error[] = []
    const { consumer, host } = createPair({ consumerSecret: 'one', hostSecret: 'two' })
    host.on('error', (error) => errors.push(error))

    const pending = consumer.send({ method: 'ping', params: [] })
    await waitFor(() => errors.length > 0)
    await consumer.close()
    await host.close()

    expect(errors[0]).toBeInstanceOf(Aead.OpenError)
    await expect(pending).rejects.toThrowError()
  })

  test('tampered encrypted messages surface Aead.OpenError', async () => {
    let tampered = false
    const errors: Error[] = []
    const { consumer, host } = createPair({
      tamper: async (response, request) => {
        if (tampered) return response
        if (request.method !== 'GET') return response
        const body = await response.clone().text()
        if (!body.includes('"type":"message"')) return response
        const json = JSON.parse(body) as { messages: { message?: { payload: { ct: string } } }[] }
        const message = json.messages.find((value) => value.message)
        if (!message) return response
        const ct = message.message!.payload.ct
        message.message!.payload.ct = `${ct.slice(0, -1)}${ct.endsWith('A') ? 'B' : 'A'}`
        tampered = true
        return new Response(JSON.stringify(json), {
          headers: response.headers,
          status: response.status,
        })
      },
    })
    consumer.on('error', (error) => errors.push(error))
    host.on('error', (error) => errors.push(error))

    const pending = consumer.send({ method: 'ping', params: [] })
    await waitFor(() => errors.length > 0)
    await consumer.close()
    await host.close()

    expect(errors[0]).toBeInstanceOf(Aead.OpenError)
    await expect(pending).rejects.toThrowError()
  })

  test('relay server rejects unsigned posts', async () => {
    const server = relayServer()

    const response = await server.fetch(
      new Request('https://relay.example/r/messages', {
        body: '{}',
        method: 'POST',
      }),
    )

    expect({ body: await response.text(), status: response.status }).toMatchInlineSnapshot(`
      {
        "body": "missing \`urpc-public-key\` header",
        "status": 401,
      }
    `)
  })

  test('post-ready relay frames do not expose plaintext RPC method names', async () => {
    const { bodies, consumer, host } = createPair()

    await consumer.send({ method: 'ping', params: [] })
    const encryptedBodies = bodies.filter((body) => body.includes('"type":"message"'))

    expect(encryptedBodies.length).toMatchInlineSnapshot(`2`)
    expect(encryptedBodies.some((body) => body.includes('ping'))).toMatchInlineSnapshot(`false`)

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

async function waitFor(predicate: () => boolean, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
