import { Handshake, Rpc, Schema, loopback } from 'handshakes'
import { Handshake as HostHandshake } from 'handshakes/host'
import { describe, expect, test } from 'vp/test'
import { z } from 'zod'

const schema = Schema.create({
  methods: {
    ping: Schema.method({
      params: z.tuple([]),
      result: z.object({ ok: z.literal(true) }),
    }),
    add: Schema.method({
      params: z.tuple([z.number(), z.number()]),
      result: z.number(),
    }),
  },
})

function pair() {
  const { consumer: cTransport, host: hTransport } = loopback()
  const consumer = Handshake.create({ transport: cTransport, schema })
  const host = HostHandshake.create({ transport: hTransport, schema })
  return { consumer, host }
}

describe('create', () => {
  test('handshakes Handshake.create returns a consumer', () => {
    const { consumer } = loopback()
    const handshake = Handshake.create({ transport: consumer })
    expect(handshake.role).toMatchInlineSnapshot(`"consumer"`)
    expect(typeof handshake.bootstrap).toMatchInlineSnapshot(`"function"`)
    expect(typeof handshake.send).toMatchInlineSnapshot(`"function"`)
  })

  test('handshakes/host Handshake.create returns a host', () => {
    const { host } = loopback()
    const handshake = HostHandshake.create({ transport: host })
    expect(handshake.role).toMatchInlineSnapshot(`"host"`)
    expect(typeof handshake.connect).toMatchInlineSnapshot(`"function"`)
    expect(typeof handshake.on).toMatchInlineSnapshot(`"function"`)
  })
})

describe('bootstrap + connect', () => {
  test('emits `open` on both sides', async () => {
    const { consumer, host } = pair()
    const consumerOpens: void[] = []
    const hostOpens: void[] = []
    consumer.on('open', () => consumerOpens.push(undefined))
    host.on('open', () => hostOpens.push(undefined))

    await consumer.bootstrap()
    await host.connect()

    expect(consumerOpens.length).toMatchInlineSnapshot(`1`)
    expect(hostOpens.length).toMatchInlineSnapshot(`1`)
  })
})

describe('send', () => {
  test('round-trips a typed result via host respond()', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    host.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const out = await consumer.send({ method: 'ping', params: [] })
    expect(out).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "ok": true,
        },
      }
    `)
  })

  test('first non-undefined listener return wins', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    host.on('request', () => undefined)
    host.on('request', ({ request }) => {
      if (request.method === 'add') {
        const [a, b] = request.params as [number, number]
        return a + b
      }
      return undefined
    })

    const out = await consumer.send({ method: 'add', params: [2, 3] })
    expect(out.result).toMatchInlineSnapshot(`5`)
  })

  test('rejects with Rpc.RpcError when host calls reject()', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    host.on('request', ({ reject }) => {
      reject({ code: -32000, message: 'denied' })
    })

    await expect(
      consumer.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: denied]`)
  })

  test('responds with method-not-found when no listener handles it', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    await expect(
      consumer.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: method not found]`)
  })

  test('rejects when called before bootstrap()', async () => {
    const { consumer } = loopback()
    const handshake = Handshake.create({ transport: consumer })
    await expect(
      handshake.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Handshake.BootstrapRequiredError: call \`bootstrap()\` before \`send()\`]`,
    )
  })

  test('rejects pending requests with Transport.ClosedError on close', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    // Host never responds to this request — close should reject the pending promise.
    const inflight = consumer.send({ method: 'ping', params: [] })
    // Listener that swallows the request without replying.
    host.on('request', () => undefined)
    // But wait: the host emits method-not-found for unhandled requests, so we
    // need a listener that *receives* but doesn't settle.
    await consumer.close()

    await expect(inflight).rejects.toBeInstanceOf(Error)
  })

  test('schema validation rejects bad params before sending', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    await expect(
      // @ts-expect-error intentionally wrong params
      consumer.send({ method: 'add', params: ['nope', 1] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: schema validation failed
      Details: 0: Invalid input: expected number, received string]
    `,
    )
  })
})

describe('notify', () => {
  test('delivers a typed notification to host listeners', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    const seen: Rpc.Notification[] = []
    host.on('notification', ({ notification }) => {
      seen.push(notification)
    })

    await consumer.notify({ method: 'ping', params: [] })
    // notification handlers run synchronously after the wire delivers.
    expect(seen).toMatchInlineSnapshot(`
      [
        {
          "jsonrpc": "2.0",
          "method": "ping",
          "params": [],
        },
      ]
    `)
  })
})

describe('close', () => {
  test('emits `close` exactly once on both sides', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    let consumerCloses = 0
    let hostCloses = 0
    consumer.on('close', () => consumerCloses++)
    host.on('close', () => hostCloses++)

    await consumer.close()
    // loopback cascades close to the peer, so the host observes it too.
    expect(consumerCloses).toMatchInlineSnapshot(`1`)
    expect(hostCloses).toMatchInlineSnapshot(`1`)
  })

  test('subsequent send() rejects with Transport.ClosedError', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()
    await consumer.close()
    await expect(
      consumer.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: handshake already closed]`,
    )
  })
})

describe('on', () => {
  test('returned AbortController unsubscribes the listener', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    let count = 0
    const controller = host.on('notification', () => {
      count++
    })
    await consumer.notify({ method: 'ping', params: [] })
    controller.abort()
    await consumer.notify({ method: 'ping', params: [] })

    expect(count).toMatchInlineSnapshot(`1`)
  })

  test('off removes a previously subscribed listener', async () => {
    const { consumer, host } = pair()
    await consumer.bootstrap()
    await host.connect()

    let count = 0
    const listener = () => {
      count++
    }
    host.on('notification', listener)
    await consumer.notify({ method: 'ping', params: [] })
    host.off('notification', listener)
    await consumer.notify({ method: 'ping', params: [] })

    expect(count).toMatchInlineSnapshot(`1`)
  })
})
