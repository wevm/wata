import { Aad, Aead, Envelope, Handshake, Nonce, Schema, Transport } from 'handshakes'
import { Handshake as HostHandshake } from 'handshakes/host'
import type { Hex } from 'ox'
import { describe, expect, test } from 'vp/test'
import { z } from 'zod'

import * as Loopback from './loopback.js'

const sessionKey: Hex.Hex = `0x${'11'.repeat(32)}`
const sessionId: Hex.Hex = `0x${'22'.repeat(16)}`

describe('loopback', () => {
  test('round trips a plain envelope from consumer to host', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    const received: Envelope.Envelope[] = []
    host.on('message', (envelope) => received.push(envelope))

    await consumer.send(Envelope.plain({ method: 'ping', params: [] }))

    expect(received).toMatchInlineSnapshot(`
      [
        {
          "payload": {
            "method": "ping",
            "params": [],
          },
          "type": "plain",
        },
      ]
    `)
  })

  test('round trips a plain envelope from host to consumer', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    const received: Envelope.Envelope[] = []
    consumer.on('message', (envelope) => received.push(envelope))

    await host.send(Envelope.plain('hello'))

    expect(received).toMatchInlineSnapshot(`
      [
        {
          "payload": "hello",
          "type": "plain",
        },
      ]
    `)
  })

  test('survives a synthetic Aead.seal/open round trip end-to-end', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    const counter = 0n
    const aad = Aad.encode({
      sessionId,
      direction: Aad.direction.c2h,
      counter,
    })
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

    await consumer.send(Envelope.encrypted({ counter, ciphertext }))

    const envelope = await inbound
    if (envelope.type !== 'encrypted') throw new Error('expected encrypted envelope')

    const plaintext = Aead.open({
      key: sessionKey,
      nonce: Nonce.fromCounter(Envelope.counterOf(envelope)),
      aad,
      ciphertext: envelope.ciphertext,
    })

    expect(plaintext).toMatchInlineSnapshot('"0xdeadbeef"')
  })

  test('buffers frames delivered before a `message` listener is attached', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()

    await consumer.send(Envelope.plain('first'))
    await consumer.send(Envelope.plain('second'))

    const received: unknown[] = []
    host.on('message', (envelope) => {
      if (envelope.type === 'plain') received.push(envelope.payload)
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

    expect(consumerCloses.length).toBe(1)
    expect(hostCloses.length).toBe(1)
  })

  test('send after close throws ClosedError', async () => {
    const { consumer, host } = Loopback.loopback()
    await consumer.start()
    await host.start()
    await consumer.close()

    await expect(consumer.send(Envelope.plain('nope'))).rejects.toThrowError(Transport.ClosedError)
  })

  test('send before start throws ClosedError', async () => {
    const { consumer } = Loopback.loopback()
    await expect(consumer.send(Envelope.plain('nope'))).rejects.toThrowError(Transport.ClosedError)
  })

  test('exposes role and exchange', () => {
    const { consumer, host } = Loopback.loopback()
    expect(consumer.role).toBe('consumer')
    expect(host.role).toBe('host')
    expect(consumer.exchange).toBe('ongoing')
    expect(host.exchange).toBe('ongoing')
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
        if (envelope.type === 'plain') received.push(envelope.payload)
      },
      { signal: controller.signal },
    )
    await consumer.send(Envelope.plain('first'))
    controller.abort()
    await consumer.send(Envelope.plain('second'))

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
 * `Handshake.create` ↔ `loopback` ↔ `Handshake.create` pipeline so the
 * outermost contract (typed `send` / `'request'` flow with a real schema)
 * is locked down on top of the loopback transport.
 */
describe('handshake + loopback integration', () => {
  test('round-trips a single typed request', async () => {
    const { consumer: cT, host: hT } = Loopback.loopback()
    const consumer = Handshake.create({ transport: cT, schema: integrationSchema })
    const host = HostHandshake.create({ transport: hT, schema: integrationSchema })

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
    const consumer = Handshake.create({ transport: cT, schema: integrationSchema })
    const host = HostHandshake.create({ transport: hT, schema: integrationSchema })

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
    const consumer = Handshake.create({ transport: cT, schema: integrationSchema })
    const host = HostHandshake.create({ transport: hT, schema: integrationSchema })

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
    const consumer = Handshake.create({ transport: cT, schema: integrationSchema })
    const host = HostHandshake.create({ transport: hT, schema: integrationSchema })

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
    expect(consumerClosed).toBe(true)
    expect(hostClosed).toBe(true)
  })
})
