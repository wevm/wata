import type { Hex } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Aad, Aead, Envelope, Wata, Nonce, Rpc, Schema, Transport } from 'wata'
import { Wata as HostWata } from 'wata/host'
import { z } from 'zod/mini'

import * as Loopback from './loopback.js'

const sessionKey: Hex.Hex = `0x${'11'.repeat(32)}`
const publicKey: Hex.Hex = `0x${'22'.repeat(32)}`

describe('loopback', () => {
  test('round trips an `rpc-requests` envelope from consumer to host', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    const received: Envelope.Envelope[] = []
    host.on('message', (envelope) => received.push(envelope))

    await consumer.send(Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]))

    expect(received).toMatchInlineSnapshot(`
      [
        {
          "payload": [
            {
              "id": 1,
              "jsonrpc": "2.0",
              "method": "ping",
              "params": [],
            },
          ],
          "type": "rpc-requests",
        },
      ]
    `)
  })

  test('round trips an `rpc-responses` envelope from host to consumer', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    const received: Envelope.Envelope[] = []
    consumer.on('message', (envelope) => received.push(envelope))

    await host.send(Envelope.rpcResponses([Rpc.success({ id: 1, result: 'hello' })]))

    expect(received).toMatchInlineSnapshot(`
      [
        {
          "payload": [
            {
              "id": 1,
              "jsonrpc": "2.0",
              "result": "hello",
            },
          ],
          "type": "rpc-responses",
        },
      ]
    `)
  })

  test('survives a synthetic Aead.seal/open round trip end-to-end', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    const counter = 1n
    const aad = Aad.encode({ publicKey, role: Aad.role.consumer })
    const nonce = Nonce.fromCounter(counter)
    const ciphertext = Aead.seal({
      key: sessionKey,
      nonce,
      aad,
      plaintext: '0xdeadbeef',
    })

    const inbound = new Promise<Envelope.Envelope>((resolve) => {
      host.on('message', (envelope) => resolve(envelope))
    })

    await consumer.send(Envelope.encrypted({ from: Envelope.from.consumer, nonce, ciphertext }))

    const envelope = await inbound
    if (envelope.type !== 'encrypted') throw new Error('expected encrypted envelope')

    const decoded = Envelope.toEncrypted(envelope)
    const plaintext = Aead.open({
      key: sessionKey,
      nonce: decoded.nonce,
      aad,
      ciphertext: decoded.ciphertext,
    })

    expect(plaintext).toMatchInlineSnapshot('"0xdeadbeef"')
  })

  test('buffers frames delivered before a `message` listener is attached', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    await consumer.send(Envelope.rpcRequests([Rpc.notification({ method: 'first', params: [] })]))
    await consumer.send(Envelope.rpcRequests([Rpc.notification({ method: 'second', params: [] })]))

    const received: unknown[] = []
    host.on('message', (envelope) => {
      if (envelope.type === 'rpc-requests') received.push(envelope.payload[0]!.method)
    })

    expect(received).toMatchInlineSnapshot(`
      [
        "first",
        "second",
      ]
    `)
  })

  test('close cascades to the peer and fires `close` on both sides', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    const consumerCloses: (Error | undefined)[] = []
    const hostCloses: (Error | undefined)[] = []
    consumer.on('close', (cause) => consumerCloses.push(cause))
    host.on('close', (cause) => hostCloses.push(cause))

    await consumer.close()

    expect(consumerCloses.length).toMatchInlineSnapshot(`1`)
    expect(hostCloses.length).toMatchInlineSnapshot(`1`)
  })

  test('send after close throws ClosedError', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()
    await consumer.close()

    await expect(
      consumer.send(Envelope.rpcRequests([Rpc.notification({ method: 'nope', params: [] })])),
    ).rejects.toThrowError(Transport.ClosedError)
  })

  test('send before start throws ClosedError', async () => {
    const { consumer } = Loopback.loopback()
    await expect(
      consumer.send(Envelope.rpcRequests([Rpc.notification({ method: 'nope', params: [] })])),
    ).rejects.toThrowError(Transport.ClosedError)
  })

  test('exposes role and exchange', () => {
    const { consumer, host } = Loopback.loopback()
    expect({
      consumerRole: consumer.role,
      hostRole: host.role,
      consumerExchange: consumer.exchange,
      hostExchange: host.exchange,
    }).toMatchInlineSnapshot(`
      {
        "consumerExchange": "ongoing",
        "consumerRole": "consumer",
        "hostExchange": "ongoing",
        "hostRole": "host",
      }
    `)
  })

  test('unsubscribe removes the listener', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    const received: unknown[] = []
    const controller = new AbortController()
    host.on(
      'message',
      (envelope) => {
        if (envelope.type === 'rpc-requests') received.push(envelope.payload[0]!.method)
      },
      { signal: controller.signal },
    )
    await consumer.send(Envelope.rpcRequests([Rpc.notification({ method: 'first', params: [] })]))
    controller.abort()
    await consumer.send(Envelope.rpcRequests([Rpc.notification({ method: 'second', params: [] })]))

    expect(received).toMatchInlineSnapshot(`
      [
        "first",
      ]
    `)
  })
})

const integrationSchema = Schema.create({
  methods: {
    eth_blockNumber: Schema.method({
      params: z.tuple([]),
      result: z.string(),
    }),
    eth_chainId: Schema.method({
      params: z.tuple([]),
      result: z.string(),
    }),
  },
})

/**
 * High-level integration tests — exercises the full
 * `Wata.create` ↔ `loopback` ↔ `Wata.create` pipeline so the
 * outermost contract (typed `send` / `'request'` flow with a real schema)
 * is locked down on top of the loopback transport.
 */
describe('wata + loopback integration', () => {
  test('round-trips a single typed request', async () => {
    const { consumer: cT, host: hT } = Loopback.loopback()
    const consumer = Wata.create({ transport: cT, schema: integrationSchema })
    const host = HostWata.create({ transport: hT, schema: integrationSchema })

    await consumer.start()
    await host.start()

    host.on('request', (event) => {
      if (event.method === 'eth_blockNumber') event.respond('0x1')
    })

    const out = await consumer.send({ method: 'eth_blockNumber', params: [] })
    expect(out).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": "0x1",
      }
    `)
  })

  test('correlates concurrent requests by id', async () => {
    const { consumer: cT, host: hT } = Loopback.loopback()
    const consumer = Wata.create({ transport: cT, schema: integrationSchema })
    const host = HostWata.create({ transport: hT, schema: integrationSchema })

    await consumer.start()
    await host.start()

    host.on('request', async (event) => {
      // Reverse-order responses to verify id correlation rather than
      // sequential dispatch.
      if (event.method === 'eth_blockNumber') {
        await new Promise((r) => setTimeout(r, 20))
        event.respond('0xa')
      }
      if (event.method === 'eth_chainId') {
        event.respond('0x1')
      }
    })

    const [a, b] = await Promise.all([
      consumer.send({ method: 'eth_blockNumber', params: [] }),
      consumer.send({ method: 'eth_chainId', params: [] }),
    ])

    expect({ a: a.result, b: b.result }).toMatchInlineSnapshot(`
      {
        "a": "0xa",
        "b": "0x1",
      }
    `)
  })

  test('host listener throwing surfaces as Rpc.RpcError on consumer', async () => {
    const { consumer: cT, host: hT } = Loopback.loopback()
    const consumer = Wata.create({ transport: cT, schema: integrationSchema })
    const host = HostWata.create({ transport: hT, schema: integrationSchema })

    await consumer.start()
    await host.start()

    host.on('request', () => {
      throw new Error('kaboom')
    })

    await expect(
      consumer.send({ method: 'eth_blockNumber', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: internal error]`)
  })

  test('cascading close rejects in-flight requests on both sides', async () => {
    const { consumer: cT, host: hT } = Loopback.loopback()
    const consumer = Wata.create({ transport: cT, schema: integrationSchema })
    const host = HostWata.create({ transport: hT, schema: integrationSchema })

    await consumer.start()
    await host.start()

    let consumerClosed = false
    let hostClosed = false
    consumer.on('close', () => (consumerClosed = true))
    host.on('close', () => (hostClosed = true))

    // Host receives the request but never settles it.
    host.on('request', () => undefined)
    const inflight = consumer.send({ method: 'eth_blockNumber', params: [] })

    await consumer.close()
    await expect(inflight).rejects.toBeInstanceOf(Error)
    expect({ consumerClosed, hostClosed }).toMatchInlineSnapshot(`
      {
        "consumerClosed": true,
        "hostClosed": true,
      }
    `)
  })
})
