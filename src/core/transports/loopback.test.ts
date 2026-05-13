import { Aad, Aead, Envelope, Nonce, Transport } from 'handshakes'
import type { Hex } from 'ox'
import { describe, expect, test } from 'vp/test'
import { loopback } from './loopback.js'

const sessionKey: Hex.Hex = `0x${'11'.repeat(32)}`
const sessionId: Hex.Hex = `0x${'22'.repeat(16)}`

describe('loopback', () => {
  test('round trips a plain envelope from consumer to host', async () => {
    const { consumer, host } = loopback()
    await consumer.start()
    await host.start()

    const received: Envelope.Envelope[] = []
    host.onMessage((envelope) => received.push(envelope))

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
    const { consumer, host } = loopback()
    await consumer.start()
    await host.start()

    const received: Envelope.Envelope[] = []
    consumer.onMessage((envelope) => received.push(envelope))

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
    const { consumer, host } = loopback()
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
      host.onMessage((envelope) => resolve(envelope))
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

  test('buffers frames delivered before onMessage is attached', async () => {
    const { consumer, host } = loopback()
    await consumer.start()
    await host.start()

    await consumer.send(Envelope.plain('first'))
    await consumer.send(Envelope.plain('second'))

    const received: unknown[] = []
    host.onMessage((envelope) => {
      if (envelope.type === 'plain') received.push(envelope.payload)
    })

    expect(received).toMatchInlineSnapshot(`
      [
        "first",
        "second",
      ]
    `)
  })

  test('close cascades to the peer and fires onClose on both sides', async () => {
    const { consumer, host } = loopback()
    await consumer.start()
    await host.start()

    const consumerCloses: (Error | undefined)[] = []
    const hostCloses: (Error | undefined)[] = []
    consumer.onClose((cause) => consumerCloses.push(cause))
    host.onClose((cause) => hostCloses.push(cause))

    await consumer.close()

    expect(consumerCloses.length).toBe(1)
    expect(hostCloses.length).toBe(1)
  })

  test('send after close throws ClosedError', async () => {
    const { consumer, host } = loopback()
    await consumer.start()
    await host.start()
    await consumer.close()

    await expect(consumer.send(Envelope.plain('nope'))).rejects.toThrowError(Transport.ClosedError)
  })

  test('send before start throws ClosedError', async () => {
    const { consumer } = loopback()
    await expect(consumer.send(Envelope.plain('nope'))).rejects.toThrowError(Transport.ClosedError)
  })

  test('exposes role and exchange', () => {
    const { consumer, host } = loopback()
    expect(consumer.role).toBe('consumer')
    expect(host.role).toBe('host')
    expect(consumer.exchange).toBe('ongoing')
    expect(host.exchange).toBe('ongoing')
  })

  test('unsubscribe removes the listener', async () => {
    const { consumer, host } = loopback()
    await consumer.start()
    await host.start()

    const received: unknown[] = []
    const unsubscribe = host.onMessage((envelope) => {
      if (envelope.type === 'plain') received.push(envelope.payload)
    })
    await consumer.send(Envelope.plain('first'))
    unsubscribe()
    await consumer.send(Envelope.plain('second'))

    expect(received).toMatchInlineSnapshot(`
      [
        "first",
      ]
    `)
  })
})
