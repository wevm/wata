import { describe, expect, test } from 'vp/test'
import { Envelope, Wata, PostMessage, Rpc, Schema, postMessage as postMessage_consumer } from 'wata'
import { Wata as HostWata, postMessage as postMessage_host } from 'wata/host'
import { z } from 'zod/mini'

import * as protocol from './internal/protocol.js'

/**
 * Browser unit tests for the consumer-side `postMessage` transport.
 *
 * These exercise the wire mechanics — readiness handshake, origin pinning,
 * buffering, listener cleanup, error mapping — directly against real
 * `MessageChannel` / `postMessage` semantics in Chromium. The end-to-end
 * `Wata` flow is covered separately in `test/wata-postMessage.browser.test.ts`.
 */
describe('postMessage (consumer)', () => {
  test('round-trips a plain envelope through a MessagePort peer', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    // Stand in for the host: wata reply (`hostReady`) plus inbound frame.
    // Both sides must wrap outbound frames with a v4 UUID `id` per the
    // window transport spec, and validate `id` on inbound frames.
    port2.addEventListener('message', (event) => {
      const inbound = protocol.readFrame(event.data)
      if (inbound && (inbound.frame as { type?: string }).type === protocol.consumerHello.type)
        port2.postMessage(protocol.withId(protocol.hostReady))
    })
    port2.start()

    await transport.start()

    const received = new Promise<Envelope.Envelope>((resolve) => {
      transport.on('message', (envelope) => resolve(envelope))
    })

    port2.postMessage(
      protocol.withId(Envelope.rpcRequests([Rpc.notification({ method: 'ping', params: [] })])),
    )

    expect(await received).toMatchInlineSnapshot(`
    	{
    	  "payload": [
    	    {
    	      "jsonrpc": "2.0",
    	      "method": "ping",
    	      "params": [],
    	    },
    	  ],
    	  "type": "rpc-requests",
    	}
    `)

    await transport.close()
  })

  test('buffers outbound frames sent before the peer signals ready', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    // Strip the wire `id` so snapshots stay stable across runs.
    const received: unknown[] = []
    port2.addEventListener('message', (event) => {
      received.push(protocol.readFrame(event.data)?.frame ?? event.data)
    })
    port2.start()

    await transport.start()
    // Wait for the consumer's hello to land at the peer before clearing.
    await new Promise((resolve) => setTimeout(resolve, 10))

    // The consumer's hello has been emitted, but no `hostReady` yet —
    // outbound frames should be buffered locally.
    await transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'one', params: [] })]))
    await transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'two', params: [] })]))

    // Drop the hello so the snapshot only shows the user frames.
    received.length = 0

    // Now signal readiness — the buffered frames flush in order.
    port2.postMessage(protocol.withId(protocol.hostReady))

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(received).toMatchInlineSnapshot(`
    	[
    	  {
    	    "payload": [
    	      {
    	        "jsonrpc": "2.0",
    	        "method": "one",
    	        "params": [],
    	      },
    	    ],
    	    "type": "rpc-requests",
    	  },
    	  {
    	    "payload": [
    	      {
    	        "jsonrpc": "2.0",
    	        "method": "two",
    	        "params": [],
    	      },
    	    ],
    	    "type": "rpc-requests",
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
      target: () => handle,
      host: 'https://wallet.example',
      source,
    })
    await transport.start()

    const seen: unknown[] = []
    transport.on('message', (envelope) => seen.push(envelope))

    // Wrong origin — should be ignored.
    source.dispatchEvent(
      new MessageEvent('message', {
        data: protocol.withId(
          Envelope.rpcRequests([Rpc.notification({ method: 'noisy', params: [] })]),
        ),
        origin: 'https://attacker.example',
      }),
    )
    // Right origin — should be delivered.
    source.dispatchEvent(
      new MessageEvent('message', {
        data: protocol.withId(
          Envelope.rpcRequests([Rpc.notification({ method: 'trusted', params: [] })]),
        ),
        origin: 'https://wallet.example',
      }),
    )

    expect(seen).toMatchInlineSnapshot(`
    	[
    	  {
    	    "payload": [
    	      {
    	        "jsonrpc": "2.0",
    	        "method": "trusted",
    	        "params": [],
    	      },
    	    ],
    	    "type": "rpc-requests",
    	  },
    	]
    `)

    await transport.close()
  })

  test('emits `error` when an inbound payload fails to parse as an envelope', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    const errors: Error[] = []
    transport.on('error', (error) => errors.push(error))

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    port2.postMessage(protocol.withId({ shape: 'not an envelope' }))

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(errors[0]?.message).toMatchInlineSnapshot(`
    	"invalid envelope
    	Details: type: Invalid input"
    `)

    await transport.close()
  })

  test('emits `error` when an inbound frame is missing the v4 UUID `id`', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    const errors: Error[] = []
    transport.on('error', (error) => errors.push(error))

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Bare envelope shape without the spec-mandated top-level `id`.
    port2.postMessage(Envelope.rpcRequests([Rpc.notification({ method: 'naked', params: [] })]))

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(errors[0]).toBeInstanceOf(PostMessage.InvalidFrameError)

    await transport.close()
  })

  test('emits `error` when an inbound frame carries a malformed `id`', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    const errors: Error[] = []
    transport.on('error', (error) => errors.push(error))

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    port2.postMessage({
      ...Envelope.rpcRequests([Rpc.notification({ method: 'bad-id', params: [] })]),
      id: 'not-a-uuid',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(errors[0]).toBeInstanceOf(PostMessage.InvalidFrameError)

    await transport.close()
  })

  test('throws `PopupBlockedError` when `target` returns null', async () => {
    const transport = postMessage_consumer({
      target: () => null as unknown as Window,
      host: 'https://wallet.example',
    })
    await expect(transport.start()).rejects.toBeInstanceOf(PostMessage.PopupBlockedError)
  })

  test('throws `InvalidTargetError` when `target` returns a non-Window-non-Port handle', async () => {
    const transport = postMessage_consumer({
      target: () => 'nope' as unknown as MessagePort,
    })
    await expect(transport.start()).rejects.toBeInstanceOf(PostMessage.InvalidTargetError)
  })

  test('`send` lazily calls `start` (no manual start required)', async () => {
    const { port1 } = new MessageChannel()
    let acquireCount = 0
    const transport = postMessage_consumer({
      target: () => {
        acquireCount += 1
        return port1
      },
    })
    // No explicit `start()` — `send()` should drive `target()` lazily.
    await transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'nope', params: [] })]))
    expect(acquireCount).toMatchInlineSnapshot(`1`)
  })

  test('`send` after `close` lazily re-acquires the target', async () => {
    const { port1 } = new MessageChannel()
    let acquireCount = 0
    const transport = postMessage_consumer({
      target: () => {
        acquireCount += 1
        return port1
      },
    })
    await transport.start()
    await transport.close()
    // `close` is non-terminal — the next `send` should call `target()` again.
    await transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'nope', params: [] })]))
    expect(acquireCount).toMatchInlineSnapshot(`2`)
  })

  test('calls user-supplied `close` handler on close', async () => {
    const { port1 } = new MessageChannel()
    let closed = 0
    const transport = postMessage_consumer({
      target: () => port1,
      close: () => {
        closed += 1
      },
    })
    await transport.start()
    await transport.close()
    expect(closed).toMatchInlineSnapshot(`1`)
  })

  test('unsubscribe removes the message listener', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    port2.addEventListener('message', (event) => {
      const inbound = protocol.readFrame(event.data)
      if (inbound && (inbound.frame as { type?: string }).type === protocol.consumerHello.type)
        port2.postMessage(protocol.withId(protocol.hostReady))
    })
    port2.start()

    await transport.start()

    const seen: unknown[] = []
    const controller = new AbortController()
    transport.on('message', (envelope) => seen.push(envelope), {
      signal: controller.signal,
    })

    port2.postMessage(
      protocol.withId(Envelope.rpcRequests([Rpc.notification({ method: 'first', params: [] })])),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    port2.postMessage(
      protocol.withId(Envelope.rpcRequests([Rpc.notification({ method: 'second', params: [] })])),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(seen).toMatchInlineSnapshot(`
    	[
    	  {
    	    "payload": [
    	      {
    	        "jsonrpc": "2.0",
    	        "method": "first",
    	        "params": [],
    	      },
    	    ],
    	    "type": "rpc-requests",
    	  },
    	]
    `)

    await transport.close()
  })

  test('sends the consumer-hello frame on start', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    const seen: unknown[] = []
    port2.addEventListener('message', (event) => {
      seen.push(event.data)
    })
    port2.start()

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const hello = seen[0] as { type: string; id: string }
    expect({
      count: seen.length,
      type: hello.type,
      idIsUuidV4: protocol.isUuidV4(hello.id),
    }).toMatchInlineSnapshot(`
      {
        "count": 1,
        "idIsUuidV4": true,
        "type": "urpc.hello",
      }
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
 * `Wata` ↔ `postMessage` ↔ `Wata` pipeline through a real
 * `MessageChannel` in Chromium. `MessageChannel` exercises the `MessagePort`
 * code path; cross-`Window` `postMessage` (popup / iframe) is covered by the
 * playground rather than the test suite (popups can't be opened outside a
 * user gesture in headless browsers).
 */
describe('wata + postMessage (MessageChannel) integration', () => {
  test('round-trips a typed request through real postMessage', async () => {
    const { port1, port2 } = new MessageChannel()

    const consumer = Wata.create({
      transport: postMessage_consumer({ target: () => port1 }),
      schema: integrationSchema,
    })
    const host = HostWata.create({
      transport: postMessage_host({ target: () => port2 }),
      schema: integrationSchema,
    })

    host.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
      if (event.method === 'add') {
        const [a, b] = event.params
        event.respond(a + b)
      }
    })

    // Bootstrap consumer + connect host concurrently — readiness wata
    // races between both sides, so neither order matters.
    await Promise.all([consumer.start(), host.start()])

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

    const consumer = Wata.create({
      transport: postMessage_consumer({ target: () => port1 }),
      schema: integrationSchema,
    })
    const host = HostWata.create({
      transport: postMessage_host({ target: () => port2 }),
      schema: integrationSchema,
    })

    host.on('request', (event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    // Start the consumer first; host is still un-connected. The transport
    // should buffer the request until the host sends `urpc.ready`.
    await consumer.start()
    const inflight = consumer.send({ method: 'ping', params: [] })

    // Now bring the host up.
    await host.start()

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

    const consumer = Wata.create({
      transport: postMessage_consumer({ target: () => port1 }),
      schema: integrationSchema,
    })
    const host = HostWata.create({
      transport: postMessage_host({ target: () => port2 }),
      schema: integrationSchema,
    })

    let consumerClosed = false
    let hostClosed = false
    consumer.on('close', () => (consumerClosed = true))
    host.on('close', () => (hostClosed = true))

    await Promise.all([consumer.start(), host.start()])
    await consumer.close()

    expect(consumerClosed).toMatchInlineSnapshot(`true`)
    // Host side gets `close` on the next tick once its own port loses its
    // peer; we explicitly close it to make this deterministic.
    await host.close()
    expect(hostClosed).toMatchInlineSnapshot(`true`)
  })

  test('rejects target() returning null with PopupBlockedError', async () => {
    const consumer = Wata.create({
      transport: postMessage_consumer({
        target: () => null as unknown as Window,
        host: 'https://wallet.example',
      }),
    })

    await expect(consumer.start()).rejects.toThrowErrorMatchingInlineSnapshot(
      `[PostMessage.PopupBlockedError: \`target\` returned null — popup blocked or window unavailable]`,
    )
  })
})
