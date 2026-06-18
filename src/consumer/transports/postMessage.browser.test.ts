import { describe, expect, test, vi } from 'vp/test'
import { Envelope, Wata, PostMessage, Rpc, Schema, postMessage as postMessage_consumer } from 'wata'
import { Wata as HostWata, postMessage as postMessage_host } from 'wata/host'
import { z } from 'zod/mini'

import * as protocol from './internal/protocol.js'

// The consumer defers connection — target acquisition + hello — to the first
// outbound frame, so `start()` never opens a popup outside a user gesture.
// Receive-path / handshake tests drive that by sending one throwaway
// notification, which buffers locally until the peer is ready.
function connect(transport: { send: (envelope: Envelope.Envelope) => Promise<unknown> }) {
  return transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'connect', params: [] })]))
}

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
    await connect(transport)

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

    // Strip the wire `id` and ignore handshake control frames (hello/ready,
    // including the consumer's re-announce) so the snapshot shows only the
    // buffered user frames.
    const received: unknown[] = []
    port2.addEventListener('message', (event) => {
      const frame = protocol.readFrame(event.data)?.frame ?? event.data
      if (protocol.isControlFrame(frame)) return
      received.push(frame)
    })
    port2.start()

    await transport.start()

    // The first `send` connects (acquires the target, emits hello), but no
    // `hostReady` has arrived yet — so both outbound frames buffer locally.
    await transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'one', params: [] })]))
    await transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'two', params: [] })]))

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
    await connect(transport)

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

  test('pins inbound frames to the bound peer window, dropping same-origin siblings', async () => {
    // Two real iframes stand in for two same-origin wallet windows: the one
    // this transport opened (`handle`) and a sibling session's window. Their
    // `contentWindow`s are genuine, distinct `WindowProxy`s — valid
    // `MessageEvent.source` values the browser would never let one forge.
    const boundFrame = document.createElement('iframe')
    const siblingFrame = document.createElement('iframe')
    document.body.append(boundFrame, siblingFrame)
    const handle = boundFrame.contentWindow as Window
    const sibling = siblingFrame.contentWindow as Window

    const transport = postMessage_consumer({
      target: () => handle,
      host: 'https://wallet.example',
      source: window,
    })
    await transport.start()
    await connect(transport)

    const seen: unknown[] = []
    transport.on('message', (envelope) => seen.push(envelope))

    // Right origin, *other* window (a sibling same-origin session) — dropped.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: protocol.withId(
          Envelope.rpcRequests([Rpc.notification({ method: 'sibling', params: [] })]),
        ),
        origin: 'https://wallet.example',
        source: sibling,
      }),
    )
    // Right origin, bound window — delivered.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: protocol.withId(
          Envelope.rpcRequests([Rpc.notification({ method: 'bound', params: [] })]),
        ),
        origin: 'https://wallet.example',
        source: handle,
      }),
    )

    expect(seen).toMatchInlineSnapshot(`
    	[
    	  {
    	    "payload": [
    	      {
    	        "jsonrpc": "2.0",
    	        "method": "bound",
    	        "params": [],
    	      },
    	    ],
    	    "type": "rpc-requests",
    	  },
    	]
    `)

    await transport.close()
    boundFrame.remove()
    siblingFrame.remove()
  })

  test('re-announces hello when it first hears the host, so a late host still readies', async () => {
    // A host that mounts after the consumer's first hello (iframe still
    // loading) misses it. The consumer must re-announce on the host's ready
    // so the host receives a consumer frame, marks ready, and can flush its
    // buffered outbound. MessagePort target keeps this focused on the
    // handshake (no origin/source pinning).
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    const hellos: unknown[] = []
    port2.addEventListener('message', (event) => {
      const inbound = protocol.readFrame(event.data)
      if (inbound && (inbound.frame as { type?: string }).type === protocol.consumerHello.type)
        hellos.push(event.data)
    })
    port2.start()

    await transport.start()
    await connect(transport)
    await vi.waitFor(() => expect(hellos).toHaveLength(1)) // initial hello

    // The host (which "missed" the first hello) sends its ready.
    port2.postMessage(protocol.withId(protocol.hostReady))

    // The consumer re-announces, so a late host now gets a consumer frame.
    await vi.waitFor(() => expect(hellos).toHaveLength(2))

    await transport.close()
  })

  test('emits `error` when an inbound payload fails to parse as an envelope', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    const errors: Error[] = []
    transport.on('error', (error) => errors.push(error))

    await transport.start()
    await connect(transport)
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
    await connect(transport)
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
    await connect(transport)
    await new Promise((resolve) => setTimeout(resolve, 10))

    port2.postMessage({
      ...Envelope.rpcRequests([Rpc.notification({ method: 'bad-id', params: [] })]),
      id: 'not-a-uuid',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(errors[0]).toBeInstanceOf(PostMessage.InvalidFrameError)

    await transport.close()
  })

  test('throws `PopupBlockedError` on connect when `target` returns null', async () => {
    const transport = postMessage_consumer({
      target: () => null as unknown as Window,
      host: 'https://wallet.example',
    })
    // `start` defers target acquisition — the first outbound frame connects
    // and surfaces the blocked popup.
    await transport.start()
    await expect(connect(transport)).rejects.toBeInstanceOf(PostMessage.PopupBlockedError)
  })

  test('throws `InvalidTargetError` on connect when `target` returns a non-Window-non-Port handle', async () => {
    const transport = postMessage_consumer({
      target: () => 'nope' as unknown as MessagePort,
    })
    await transport.start()
    await expect(connect(transport)).rejects.toBeInstanceOf(PostMessage.InvalidTargetError)
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
    // First `send` connects (acquires the target once).
    await connect(transport)
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
    await connect(transport)
    await transport.close()
    expect(closed).toMatchInlineSnapshot(`1`)
  })

  test('defers `target` to `start({ target })`', async () => {
    const { port1, port2 } = new MessageChannel()
    // No `target` at construction — supplied at start instead.
    const transport = postMessage_consumer()

    port2.addEventListener('message', (event) => {
      const inbound = protocol.readFrame(event.data)
      if (inbound && (inbound.frame as { type?: string }).type === protocol.consumerHello.type)
        port2.postMessage(protocol.withId(protocol.hostReady))
    })
    port2.start()

    await transport.start({ target: () => port1 })
    await connect(transport)

    const received = new Promise<Envelope.Envelope>((resolve) => {
      transport.on('message', (envelope) => resolve(envelope))
    })
    port2.postMessage(
      protocol.withId(Envelope.rpcRequests([Rpc.notification({ method: 'ping', params: [] })])),
    )
    expect((await received).type).toMatchInlineSnapshot(`"rpc-requests"`)

    await transport.close()
  })

  test('throws `TargetRequiredError` when `target` is supplied at neither construction nor start', async () => {
    const transport = postMessage_consumer()
    await expect(transport.start()).rejects.toBeInstanceOf(PostMessage.TargetRequiredError)
  })

  test('start-time `close` override wins over construction `close`', async () => {
    const { port1 } = new MessageChannel()
    let which = ''
    const transport = postMessage_consumer({
      target: () => port1,
      close: () => {
        which = 'construction'
      },
    })
    await transport.start({
      close: () => {
        which = 'start'
      },
    })
    await connect(transport)
    await transport.close()
    expect(which).toMatchInlineSnapshot(`"start"`)
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
    await connect(transport)

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

  test('sends the consumer-hello frame on first send', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    const seen: unknown[] = []
    port2.addEventListener('message', (event) => {
      seen.push(event.data)
    })
    port2.start()

    await transport.start()
    // `start` is deferred — connecting (here, via the first `send`) is what
    // emits the consumer hello. The throwaway frame buffers behind it.
    await connect(transport)
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

  test('connect: eager sends hello during start, before any outbound frame', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ connect: 'eager', target: () => port1 })

    const seen: unknown[] = []
    port2.addEventListener('message', (event) => {
      seen.push(event.data)
    })
    port2.start()

    // No `send` / `connect` throwaway — `start` itself must connect and hello.
    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const hello = seen[0] as { type: string; id: string }
    expect({ count: seen.length, type: hello.type }).toMatchInlineSnapshot(`
      {
        "count": 1,
        "type": "urpc.hello",
      }
    `)

    await transport.close()
  })

  test('connect: eager receives a proactive host frame without an outbound request', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ connect: 'eager', target: () => port1 })

    // Host readies as soon as it hears the consumer hello, then proactively
    // pushes a notification — the consumer must receive it without ever
    // sending an outbound request.
    port2.addEventListener('message', (event) => {
      const inbound = protocol.readFrame(event.data)
      if (inbound && (inbound.frame as { type?: string }).type === protocol.consumerHello.type) {
        port2.postMessage(protocol.withId(protocol.hostReady))
        port2.postMessage(
          protocol.withId(
            Envelope.rpcRequests([
              Rpc.notification({ method: 'accountsChanged', params: [['0xabc']] }),
            ]),
          ),
        )
      }
    })
    port2.start()

    const received = new Promise<Envelope.Envelope>((resolve) => {
      transport.on('message', (envelope) => resolve(envelope))
    })

    await transport.start()

    expect(await received).toMatchInlineSnapshot(`
      {
        "payload": [
          {
            "jsonrpc": "2.0",
            "method": "accountsChanged",
            "params": [
              [
                "0xabc",
              ],
            ],
          },
        ],
        "type": "rpc-requests",
      }
    `)

    await transport.close()
  })

  test('connect: lazy (default) defers hello to the first outbound frame', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage_consumer({ target: () => port1 })

    const seen: unknown[] = []
    port2.addEventListener('message', (event) => {
      seen.push(event.data)
    })
    port2.start()

    // `start` alone must NOT connect for a lazy consumer — no hello yet.
    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen.length).toMatchInlineSnapshot(`0`)

    // The first outbound frame is what connects and sends hello.
    await connect(transport)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((seen[0] as { type: string }).type).toMatchInlineSnapshot(`"urpc.hello"`)

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
      transports: [postMessage_consumer({ target: () => port1 })],
      schema: integrationSchema,
    })
    const host = await HostWata.create({
      transports: [postMessage_host({ target: () => port2 })],
      schema: integrationSchema,
    }).start()

    host.onRequest((event) => {
      if (event.method === 'ping') event.respond({ ok: true })
      if (event.method === 'add') {
        const [a, b] = event.params
        event.respond(a + b)
      }
    })

    // Start both sides — readiness wata races between both transports, so
    // neither order matters.
    const session = await consumer.start()

    const ping = await session.send({ method: 'ping', params: [] })
    expect(ping).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "ok": true,
        },
      }
    `)

    const sum = await session.send({ method: 'add', params: [2, 3] })
    expect(sum.result).toMatchInlineSnapshot(`5`)

    await session.close()
  })

  test('buffers outbound frames sent before the peer is ready', async () => {
    const { port1, port2 } = new MessageChannel()

    const consumer = Wata.create({
      transports: [postMessage_consumer({ target: () => port1 })],
      schema: integrationSchema,
    })
    const host = HostWata.create({
      transports: [postMessage_host({ target: () => port2 })],
      schema: integrationSchema,
    })

    // Start the consumer first; host is still un-connected. The transport
    // should buffer the request until the host sends `urpc.ready`.
    const session = await consumer.start()
    const inflight = session.send({ method: 'ping', params: [] })

    // Now bring the host up.
    const host_session = await host.start()
    host_session.onRequest((event) => {
      if (event.method === 'ping') event.respond({ ok: true })
    })

    const out = await inflight
    expect(out.result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)

    await session.close()
    await host_session.close()
  })

  test('emits `close` on both sides when consumer closes', async () => {
    const { port1, port2 } = new MessageChannel()

    const consumer = Wata.create({
      transports: [postMessage_consumer({ target: () => port1 })],
      schema: integrationSchema,
    })
    const host = HostWata.create({
      transports: [postMessage_host({ target: () => port2 })],
      schema: integrationSchema,
    })

    let consumerClosed = false
    let hostClosed = false

    const [session, host_session] = await Promise.all([consumer.start(), host.start()])
    session.onClose(() => (consumerClosed = true))
    host_session.onClose(() => (hostClosed = true))
    await session.close()

    expect(consumerClosed).toMatchInlineSnapshot(`true`)
    // Host side gets `close` on the next tick once its own port loses its
    // peer; we explicitly close it to make this deterministic.
    await host_session.close()
    expect(hostClosed).toMatchInlineSnapshot(`true`)
  })

  test('rejects target() returning null with PopupBlockedError', async () => {
    const consumer = Wata.create({
      transports: [
        postMessage_consumer({
          target: () => null as unknown as Window,
          host: 'https://wallet.example',
        }),
      ],
    })

    // `start` defers target acquisition, so the blocked popup surfaces on the
    // first outbound request rather than at start.
    const session = await consumer.start()
    await expect(
      session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[PostMessage.PopupBlockedError: \`target\` returned null — popup blocked or window unavailable]`,
    )
  })
})
