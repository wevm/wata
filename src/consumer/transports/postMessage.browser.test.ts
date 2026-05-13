import {
  Envelope,
  Handshake,
  PostMessage,
  Schema,
  postMessage as postMessage_consumer,
} from 'handshakes'
import {
  Handshake as HostHandshake,
  postMessage as postMessage_host,
} from 'handshakes/host'
import { describe, expect, test } from 'vp/test'
import { z } from 'zod'

import * as protocol from './internal/protocol.js'

/**
 * Browser unit tests for the consumer-side `postMessage` transport.
 *
 * These exercise the wire mechanics — ready handshake, origin pinning,
 * buffering, listener cleanup, error mapping — directly against real
 * `MessageChannel` / `postMessage` semantics in Chromium. The end-to-end
 * `Handshake` flow is covered separately in `test/handshake-postMessage.browser.test.ts`.
 */
describe('postMessage (consumer)', () => {
  test('round-trips a plain envelope through a MessagePort peer', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ open: () => port1 })

    // Stand in for the host: handshake reply (`hostReady`) plus inbound frame.
    port2.addEventListener('message', (event) => {
      if (event.data?.type === protocol.consumerHello.type)
        port2.postMessage(protocol.hostReady)
    })
    port2.start()

    await transport.start()

    const received = new Promise<Envelope.Envelope>((resolve) => {
      transport.onMessage(resolve)
    })

    port2.postMessage(Envelope.plain({ method: 'ping', params: [] }))

    expect(await received).toMatchInlineSnapshot(`
      {
        "payload": {
          "method": "ping",
          "params": [],
        },
        "type": "plain",
      }
    `)

    await transport.close()
  })

  test('buffers outbound frames sent before the peer signals ready', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ open: () => port1 })

    const received: unknown[] = []
    port2.addEventListener('message', (event) => {
      received.push(event.data)
    })
    port2.start()

    await transport.start()
    // Wait for the consumer's hello to land at the peer before clearing.
    await new Promise((resolve) => setTimeout(resolve, 10))

    // The consumer's hello has been emitted, but no `hostReady` yet —
    // outbound frames should be buffered locally.
    await transport.send(Envelope.plain({ method: 'one' }))
    await transport.send(Envelope.plain({ method: 'two' }))

    // Drop the hello so the snapshot only shows the user frames.
    received.length = 0

    // Now signal readiness — the buffered frames flush in order.
    port2.postMessage(protocol.hostReady)

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(received).toMatchInlineSnapshot(`
      [
        {
          "payload": {
            "method": "one",
          },
          "type": "plain",
        },
        {
          "payload": {
            "method": "two",
          },
          "type": "plain",
        },
      ]
    `)

    await transport.close()
  })

  test('rejects messages whose origin does not match `targetOrigin`', async () => {
    const source = new EventTarget() as unknown as Window & EventTarget
    const handle = {
      postMessage: () => {},
      addEventListener: source.addEventListener.bind(source),
      removeEventListener: source.removeEventListener.bind(source),
    } as unknown as Window

    const transport = postMessage_consumer({
      open: () => handle,
      targetOrigin: 'https://wallet.example',
      source,
    })
    await transport.start()

    const seen: unknown[] = []
    transport.onMessage((envelope) => seen.push(envelope))

    // Wrong origin — should be ignored.
    source.dispatchEvent(
      new MessageEvent('message', {
        data: Envelope.plain({ method: 'noisy' }),
        origin: 'https://attacker.example',
      }),
    )
    // Right origin — should be delivered.
    source.dispatchEvent(
      new MessageEvent('message', {
        data: Envelope.plain({ method: 'trusted' }),
        origin: 'https://wallet.example',
      }),
    )

    expect(seen).toMatchInlineSnapshot(`
      [
        {
          "payload": {
            "method": "trusted",
          },
          "type": "plain",
        },
      ]
    `)

    await transport.close()
  })

  test('emits `error` when an inbound payload fails to parse as an envelope', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ open: () => port1 })

    const errors: Error[] = []
    transport.onError((error) => errors.push(error))

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    port2.postMessage({ shape: 'not an envelope' })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(errors[0]?.message).toMatchInlineSnapshot(`
      "invalid envelope
      Details: Invalid discriminator value. Expected 'plain' | 'encrypted'"
    `)

    await transport.close()
  })

  test('throws `PopupBlockedError` when `open` returns null', async () => {
    const transport = postMessage_consumer({
      open: () => null as unknown as Window,
      targetOrigin: 'https://wallet.example',
    })
    await expect(transport.start()).rejects.toBeInstanceOf(PostMessage.PopupBlockedError)
  })

  test('throws `InvalidTargetError` when `open` returns a non-Window-non-Port handle', async () => {
    const transport = postMessage_consumer({
      open: () => 'nope' as unknown as MessagePort,
    })
    await expect(transport.start()).rejects.toBeInstanceOf(PostMessage.InvalidTargetError)
  })

  test('throws `ClosedError` on `send` after `close`', async () => {
    const { port1 } = new MessageChannel()
    const transport = postMessage_consumer({ open: () => port1 })
    await transport.start()
    await transport.close()
    await expect(transport.send(Envelope.plain('nope'))).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: postMessage transport already closed]`,
    )
  })

  test('throws `ClosedError` on `send` before `start`', async () => {
    const { port1 } = new MessageChannel()
    const transport = postMessage_consumer({ open: () => port1 })
    await expect(transport.send(Envelope.plain('nope'))).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.ClosedError: postMessage transport not started]`,
    )
  })

  test('calls user-supplied `close` handler on close', async () => {
    const { port1 } = new MessageChannel()
    let closed = 0
    const transport = postMessage_consumer({
      open: () => port1,
      close: () => {
        closed += 1
      },
    })
    await transport.start()
    await transport.close()
    expect(closed).toBe(1)
  })

  test('unsubscribe removes the message listener', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ open: () => port1 })

    port2.addEventListener('message', (event) => {
      if (event.data?.type === protocol.consumerHello.type)
        port2.postMessage(protocol.hostReady)
    })
    port2.start()

    await transport.start()

    const seen: unknown[] = []
    const unsubscribe = transport.onMessage((envelope) => seen.push(envelope))

    port2.postMessage(Envelope.plain('first'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    unsubscribe()
    port2.postMessage(Envelope.plain('second'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(seen).toMatchInlineSnapshot(`
      [
        {
          "payload": "first",
          "type": "plain",
        },
      ]
    `)

    await transport.close()
  })

  test('sends the consumer-hello frame on start', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ open: () => port1 })

    const seen: unknown[] = []
    port2.addEventListener('message', (event) => {
      seen.push(event.data)
    })
    port2.start()

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(seen).toMatchInlineSnapshot(`
      [
        {
          "type": "tempocp.hello",
        },
      ]
    `)

    await transport.close()
  })
})

const integrationSchema = Schema.create({
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

/**
 * High-level browser integration tests — exercises the full
 * `Handshake` ↔ `postMessage` ↔ `Handshake` pipeline through a real
 * `MessageChannel` in Chromium. `MessageChannel` exercises the `MessagePort`
 * code path; cross-`Window` `postMessage` (popup / iframe) is covered by the
 * playground rather than the test suite (popups can't be opened outside a
 * user gesture in headless browsers).
 */
describe('handshake + postMessage (MessageChannel) integration', () => {
  test('round-trips a typed request through real postMessage', async () => {
    const { port1, port2 } = new MessageChannel()

    const consumer = Handshake.create({
      transport: postMessage_consumer({ open: () => port1 }),
      schema: integrationSchema,
    })
    const host = HostHandshake.create({
      transport: postMessage_host({ open: () => port2 }),
      schema: integrationSchema,
    })

    host.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
      if (event.method === 'add') {
        const [a, b] = event.params
        event.respond(a + b)
      }
    })

    // Bootstrap consumer + connect host concurrently — readiness handshake
    // races between both sides, so neither order matters.
    await Promise.all([consumer.bootstrap(), host.connect()])

    const ping = await consumer.send({ method: 'ping', params: [] })
    expect(ping).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "ok": true,
        },
      }
    `)

    const sum = await consumer.send({ method: 'add', params: [2, 3] })
    expect(sum.result).toMatchInlineSnapshot(`5`)

    await consumer.close()
  })

  test('buffers outbound frames sent before the peer is ready', async () => {
    const { port1, port2 } = new MessageChannel()

    const consumer = Handshake.create({
      transport: postMessage_consumer({ open: () => port1 }),
      schema: integrationSchema,
    })
    const host = HostHandshake.create({
      transport: postMessage_host({ open: () => port2 }),
      schema: integrationSchema,
    })

    host.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    // Start the consumer first; host is still un-connected. The transport
    // should buffer the request until the host sends `tempocp.ready`.
    await consumer.bootstrap()
    const inflight = consumer.send({ method: 'ping', params: [] })

    // Now bring the host up.
    await host.connect()

    const out = await inflight
    expect(out.result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)

    await consumer.close()
  })

  test('emits `close` on both sides when consumer closes', async () => {
    const { port1, port2 } = new MessageChannel()

    const consumer = Handshake.create({
      transport: postMessage_consumer({ open: () => port1 }),
      schema: integrationSchema,
    })
    const host = HostHandshake.create({
      transport: postMessage_host({ open: () => port2 }),
      schema: integrationSchema,
    })

    let consumerClosed = false
    let hostClosed = false
    consumer.on('close', () => (consumerClosed = true))
    host.on('close', () => (hostClosed = true))

    await Promise.all([consumer.bootstrap(), host.connect()])
    await consumer.close()

    expect(consumerClosed).toMatchInlineSnapshot(`true`)
    // Host side gets `close` on the next tick once its own port loses its
    // peer; we explicitly close it to make this deterministic.
    await host.close()
    expect(hostClosed).toMatchInlineSnapshot(`true`)
  })

  test('rejects open() returning null with PopupBlockedError', async () => {
    const consumer = Handshake.create({
      transport: postMessage_consumer({
        open: () => null as unknown as Window,
        targetOrigin: 'https://wallet.example',
      }),
    })

    await expect(consumer.bootstrap()).rejects.toThrowErrorMatchingInlineSnapshot(
      `[PostMessage.PopupBlockedError: \`open\` returned null — popup blocked or window unavailable]`,
    )
  })
})
