import { Base64, Bytes } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Crypto, Envelope, Wata, relay } from 'wata'
import { Wata as HostWata, relay as hostRelay } from 'wata/host'
import { Relay } from 'wata/server'

import * as RelayProtocol from '../src/internal/Relay.js'

function deferred<value>() {
  let resolve!: (value: value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<value>((resolve_, reject_) => {
    resolve = resolve_
    reject = reject_
  })
  return { promise, reject, resolve }
}

/** Bridge a `{ fetch }` server handler into a `typeof fetch` override. */
function serverFetch(server: { fetch: (request: Request) => Promise<Response> }): typeof fetch {
  return (input, init) => server.fetch(new Request(input, init))
}

describe('relay', () => {
  test('establishes a session and messages back and forth end to end', async () => {
    const server = Relay.create({ keepaliveInterval: 50 })
    const prompt = deferred<string>()

    // Web app (consumer): kicking off a request lazily starts the
    // transport, locks the consumer slot, and surfaces the pairing link.
    const consumer = Wata.create({
      transports: [
        relay({
          fetch: serverFetch(server),
          url: 'https://relay.test',
        }),
      ],
    })
    consumer.on('prompt', ({ uri }) => prompt.resolve(uri))
    const pending = consumer.send({ method: 'ping', params: [] })
    const uri = await prompt.promise
    expect(uri).toMatch(/^urpc:\/\/\?consumer_pubkey=/)

    // Mobile app (host): constructed from the scanned pairing link.
    const host = HostWata.create({ transports: [hostRelay({ fetch: serverFetch(server), uri })] })
    host.on('request', async (event) => {
      if (event.method === 'ping') await event.respond('pong')
      if (event.method === 'add') {
        const [a, b] = event.params as [number, number]
        await event.respond(a + b)
      }
    })
    await host.start()

    // The pre-pairing request flushes once the session keys.
    const { result } = await pending
    expect(result).toBe('pong')

    // Steady state — more round trips on the same session.
    const second = await consumer.send({ method: 'add', params: [2, 3] })
    expect(second.result).toBe(5)

    // Host → consumer notification over the same encrypted channel.
    const notified = deferred<{ method: string; params: unknown }>()
    const subscription = consumer.on('notification', (event) =>
      notified.resolve({ method: event.method, params: event.params }),
    )
    await host.notify({ method: 'accountsChanged', params: [['0xabc']] })
    expect(await notified.promise).toEqual({ method: 'accountsChanged', params: [['0xabc']] })
    subscription.abort()

    await host.close()
    await consumer.close()
  })

  test('establishes a session over the short-poll receive transport', async () => {
    // Short polling relies on the relay's buffering to bridge the brief
    // gaps between polls, so enable it on the server.
    const server = Relay.create({ buffer: {}, keepaliveInterval: 50 })
    const prompt = deferred<string>()

    const consumer = Wata.create({
      transports: [
        relay({
          fetch: serverFetch(server),
          receive: 'poll',
          url: 'https://relay.test',
        }),
      ],
    })
    consumer.on('prompt', ({ uri }) => prompt.resolve(uri))
    const pending = consumer.send({ method: 'ping', params: [] })
    const uri = await prompt.promise

    const host = HostWata.create({
      transports: [hostRelay({ fetch: serverFetch(server), receive: 'poll', uri })],
    })
    host.on('request', async (event) => {
      if (event.method === 'ping') await event.respond('pong')
      if (event.method === 'add') {
        const [a, b] = event.params as [number, number]
        await event.respond(a + b)
      }
    })
    await host.start()

    const { result } = await pending
    expect(result).toBe('pong')

    const second = await consumer.send({ method: 'add', params: [2, 3] })
    expect(second.result).toBe(5)

    const notified = deferred<{ method: string; params: unknown }>()
    const subscription = consumer.on('notification', (event) =>
      notified.resolve({ method: event.method, params: event.params }),
    )
    await host.notify({ method: 'accountsChanged', params: [['0xabc']] })
    expect(await notified.promise).toEqual({ method: 'accountsChanged', params: [['0xabc']] })
    subscription.abort()

    await host.close()
    await consumer.close()
  })

  test('fails closed when the hello proof does not verify', async () => {
    const server = Relay.create({ keepaliveInterval: 50 })
    const prompt = deferred<string>()
    const consumer = Wata.create({
      transports: [
        relay({
          fetch: serverFetch(server),
          url: 'https://relay.test',
        }),
      ],
    })
    const closed = deferred<Error | undefined>()
    consumer.on('prompt', ({ uri }) => prompt.resolve(uri))
    consumer.on('close', (cause) => closed.resolve(cause))
    const pending = consumer.send({ method: 'ping', params: [] })
    pending.catch(() => undefined)
    const uri = await prompt.promise

    // A relay-resident MITM races the legitimate host: it knows the
    // channel id (routing metadata) but not `pairing_secret`, so its
    // forged proof cannot verify.
    const parsed = RelayProtocol.parseUri(uri)
    const attacker = Crypto.randomKeypair()
    const channel = RelayProtocol.createChannel({
      channelId: RelayProtocol.channelId({
        consumerPublicKey: parsed.consumerPublicKey,
        pairingSecret: parsed.pairingSecret,
      }),
      fetch: serverFetch(server),
      keypair: attacker,
      peer: 'host',
      url: parsed.relay,
    })
    const delivery = await channel.post(
      JSON.stringify(
        Envelope.hello({
          host_proof: Base64.fromBytes(Bytes.random(32), { pad: false, url: true }),
          host_pubkey: Crypto.encodePublicKey(attacker.x25519.publicKey),
        }),
      ),
    )
    expect(delivery).toBe('delivered')

    // The consumer fails closed: session torn down, pending rejected,
    // and nothing — not even an error — sent back through the relay.
    const cause = await closed.promise
    expect(cause?.name).toBe('Relay.PairingFailedError')
    await expect(pending).rejects.toMatchObject({ name: 'Relay.PairingFailedError' })
  })

  test('host start() rejects when the consumer has no active receiver', async () => {
    const server = Relay.create({ keepaliveInterval: 50 })
    // A syntactically valid pairing uri whose consumer never subscribed.
    const uri = RelayProtocol.buildUri({
      consumerPublicKey: Crypto.randomKeypair().x25519.publicKey,
      pairingSecret: Bytes.random(32),
      relay: 'https://relay.test',
    })
    const host = HostWata.create({ transports: [hostRelay({ fetch: serverFetch(server), uri })] })
    await expect(host.start()).rejects.toThrow(
      'consumer has no active relay receiver (message dropped)',
    )
  })

  test('host factory rejects a malformed pairing uri at construction', () => {
    expect(() => hostRelay({ uri: 'https://wallet.example/urpc' })).toThrow(
      'value is not a valid relay pairing uri',
    )
  })

  test('a hoisted host pairs repeatedly through wata.relay.start', async () => {
    const server = Relay.create({ keepaliveInterval: 50 })

    // Host is built once, listeners registered once — no uri yet.
    const host = HostWata.create({
      transports: [hostRelay({ fetch: serverFetch(server) })],
    })
    host.on('request', async (event) => {
      if (event.method === 'ping') return event.respond('pong')
      return event.respond(null)
    })

    async function pairOnce() {
      const prompt = deferred<string>()
      const consumer = Wata.create({
        transports: [relay({ fetch: serverFetch(server), url: 'https://relay.test' })],
      })
      consumer.on('prompt', ({ uri }) => prompt.resolve(uri))
      const pending = consumer.send({ method: 'ping', params: [] })
      // Supply the scanned link at start time — no external pairing source.
      await host.relay.start({ pairingUri: await prompt.promise })
      expect((await pending).result).toBe('pong')
      await consumer.close()
    }

    // Pair with a first consumer, tear the session down, then reuse the
    // same hoisted host to pair with a second.
    await pairOnce()
    await host.close()
    await pairOnce()
    await host.close()
  })

  test('closing a host before a uri arrives rejects the pending pair', async () => {
    const server = Relay.create({ keepaliveInterval: 50 })
    const host = HostWata.create({
      transports: [hostRelay({ fetch: serverFetch(server) })],
    })
    const started = host.relay.start() // waits for a pairing uri
    await host.close()
    await expect(started).rejects.toThrow()
  })
})

describe('relay receive modes', () => {
  // Every combination of consumer/host receive transport, including the
  // mixed pairings. Polling needs the relay's buffering (spec §5.4) to
  // bridge the gaps between short polls; a tiny `pollInterval` keeps the
  // round trips fast.
  const modes = [
    { consumer: 'sse', host: 'sse' },
    { consumer: 'poll', host: 'poll' },
    { consumer: 'poll', host: 'sse' },
    { consumer: 'sse', host: 'poll' },
  ] as const

  async function session(receive: { consumer: 'poll' | 'sse'; host: 'poll' | 'sse' }) {
    const server = Relay.create({ buffer: {}, keepaliveInterval: 50 })
    const prompt = deferred<string>()
    const consumer = Wata.create({
      transports: [
        relay({
          fetch: serverFetch(server),
          pollInterval: 10,
          receive: receive.consumer,
          url: 'https://relay.test',
        }),
      ],
    })
    consumer.on('prompt', ({ uri }) => prompt.resolve(uri))
    const pending = consumer.send({ method: 'ping', params: [] })
    const uri = await prompt.promise
    const host = HostWata.create({
      transports: [
        hostRelay({ fetch: serverFetch(server), pollInterval: 10, receive: receive.host, uri }),
      ],
    })
    host.on('request', async (event) => {
      if (event.method === 'ping') return event.respond('pong')
      if (event.method === 'add') {
        const [a, b] = event.params as [number, number]
        return event.respond(a + b)
      }
      return event.respond(null)
    })
    await host.start()
    expect((await pending).result).toBe('pong')
    return { consumer, host }
  }

  for (const receive of modes) {
    const label = `consumer:${receive.consumer} host:${receive.host}`

    test(`${label} — survives a sequential request burst`, async () => {
      const { consumer, host } = await session(receive)
      for (let i = 0; i < 6; i++) {
        const { result } = await consumer.send({ method: 'add', params: [i, i] })
        expect(result).toBe(i + i)
      }
      await host.close()
      await consumer.close()
    })

    test(`${label} — correlates concurrent in-flight requests`, async () => {
      const { consumer, host } = await session(receive)
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => consumer.send({ method: 'add', params: [i, 1] })),
      )
      expect(results.map((r) => r.result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      await host.close()
      await consumer.close()
    })

    test(`${label} — delivers a host notification burst in order`, async () => {
      const { consumer, host } = await session(receive)
      const received: number[] = []
      const done = deferred<void>()
      const subscription = consumer.on('notification', (event) => {
        received.push((event.params as [number])[0])
        if (received.length === 8) done.resolve()
      })
      for (let i = 0; i < 8; i++) await host.notify({ method: 'tick', params: [i] })
      await done.promise
      expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      subscription.abort()
      await host.close()
      await consumer.close()
    })
  }
})
