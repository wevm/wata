import { describe, expect, test } from 'vp/test'
import { Envelope, Rpc, Wata, postMessage as postMessage_consumer } from 'wata'
import { Wata as HostWata, postMessage } from 'wata/host'

import * as protocol from '../../consumer/transports/internal/protocol.js'

/**
 * Browser unit tests for the host-side `postMessage` transport. The host is
 * a thin wrapper around the same `createSide` helper as the consumer — these
 * tests cover the host-specific bits (role + inverted wata direction).
 */
describe('postMessage (host)', () => {
  test('emits `urpc.ready` on start and waits for the consumer hello', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage({ target: () => port1 })

    const peerSeen: unknown[] = []
    port2.addEventListener('message', (event) => {
      peerSeen.push(event.data)
    })
    port2.start()

    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const ready = peerSeen[0] as { id: string; type: string }
    expect({
      count: peerSeen.length,
      idIsUuidV4: protocol.isUuidV4(ready.id),
      type: ready.type,
    }).toMatchInlineSnapshot(`
      {
        "count": 1,
        "idIsUuidV4": true,
        "type": "urpc.ready",
      }
    `)

    await transport.close()
  })

  test('replays ready before draining buffered frames once the consumer hello arrives', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage({ target: () => port1 })

    // Strip the wire `id` so snapshots stay stable across runs.
    const peerSeen: unknown[] = []
    port2.addEventListener('message', (event) => {
      peerSeen.push(protocol.readFrame(event.data)?.frame ?? event.data)
    })
    port2.start()

    await transport.start()
    // Wait for the host's ready frame to land at the peer before clearing.
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Consumer hasn't said hello yet — outbound frames should be buffered.
    await transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'one', params: [] })]))
    await transport.send(Envelope.rpcRequests([Rpc.notification({ method: 'two', params: [] })]))

    // Drop the host's hello (`urpc.ready`) so the snapshot only shows
    // the buffered user frames.
    peerSeen.length = 0

    port2.postMessage(protocol.withId(protocol.consumerHello))

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(peerSeen).toMatchInlineSnapshot(`
    	[
    	  {
    	    "type": "urpc.ready",
    	  },
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

  test('reports role: "host" and exchange: "ongoing"', () => {
    const { port1 } = new MessageChannel()
    const transport = postMessage({ target: () => port1 })
    expect({ exchange: transport.exchange, role: transport.role }).toMatchInlineSnapshot(`
      {
        "exchange": "ongoing",
        "role": "host",
      }
    `)
  })

  test('defers `targetOrigin` to `start({ targetOrigin })`, pinning inbound events', async () => {
    const source = Object.assign(new EventTarget(), { postMessage() {} }) as unknown as Window &
      EventTarget
    const handle = {
      addEventListener: source.addEventListener.bind(source),
      postMessage() {},
      removeEventListener: source.removeEventListener.bind(source),
    } as unknown as Window
    // No `targetOrigin` at construction — supplied at start.
    const host = await HostWata.create({
      transports: [postMessage({ source, target: () => handle })],
    }).start({ targetOrigin: 'https://app.example' })

    const seen: Array<string | undefined> = []
    host.onNotification((event) => seen.push(event.meta.origin))

    // Wrong origin — dropped.
    source.dispatchEvent(
      new MessageEvent('message', {
        data: protocol.withId(
          Envelope.rpcRequests([Rpc.notification({ method: 'noisy', params: [] })]),
        ),
        origin: 'https://attacker.example',
      }),
    )
    // Pinned origin — delivered.
    source.dispatchEvent(
      new MessageEvent('message', {
        data: protocol.withId(
          Envelope.rpcRequests([Rpc.notification({ method: 'trusted', params: [] })]),
        ),
        origin: 'https://app.example',
      }),
    )

    await waitFor(() => seen.length === 1)
    expect(seen).toMatchInlineSnapshot(`
      [
        "https://app.example",
      ]
    `)

    await host.close()
  })
})

/**
 * End-to-end coverage for the host-side session `respond` / `reject` API over
 * real `postMessage` (`MessageChannel` peers). Mirrors
 * `src/Wata.test.ts` but on the wire, and exercises the
 * "no listener at all → method not found" fallthrough too.
 */
describe('session.respond / session.reject (postMessage)', () => {
  function pair() {
    const { port1, port2 } = new MessageChannel()
    const consumer = Wata.create({ transports: [postMessage_consumer({ target: () => port1 })] })
    const host = HostWata.create({ transports: [postMessage({ target: () => port2 })] })
    return { consumer, host }
  }

  test('respond settles a pending request by id', async () => {
    const { consumer, host } = pair()
    const [consumer_session, host_session] = await Promise.all([consumer.start(), host.start()])

    let captured: { id: number | string } | undefined
    host_session.onRequest((event) => {
      captured = { id: event.id }
    })

    const inflight = consumer_session.send({ method: 'ping', params: [] })
    // Wait until the host has actually received the request frame.
    await waitFor(() => captured !== undefined)
    host_session.respond(captured!.id, { ok: true })

    expect((await inflight).result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)

    await consumer_session.close()
    await host_session.close()
  })

  test('reject sends a JSON-RPC error response by id', async () => {
    const { consumer, host } = pair()
    const [consumer_session, host_session] = await Promise.all([consumer.start(), host.start()])

    let captured: { id: number | string } | undefined
    host_session.onRequest((event) => {
      captured = { id: event.id }
    })

    const inflight = consumer_session.send({ method: 'ping', params: [] })
    await waitFor(() => captured !== undefined)

    host_session.reject(captured!.id, { code: -32000, message: 'denied' })

    await expect(inflight).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: denied]`)

    await consumer_session.close()
    await host_session.close()
  })

  test('no listener at all → method not found', async () => {
    const { consumer, host } = pair()
    const [consumer_session, host_session] = await Promise.all([consumer.start(), host.start()])

    await expect(
      consumer_session.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: method not found]`)

    await consumer_session.close()
    await host_session.close()
  })

  test('notify delivers a host notification when host started first', async () => {
    const { consumer, host } = pair()
    const seen: Rpc.Notification[] = []
    const consumer_session = await consumer.start()
    consumer_session.onNotification(({ notification }) => {
      seen.push(notification)
    })

    const host_session = await host.start()
    const sent = host_session.notify({ method: 'dialog.mode.switch', params: [{ mode: 'popup' }] })
    await sent

    // The consumer establishes the channel on its first outbound frame — until
    // then the host's notification stays buffered. Once connected, the queued
    // notification flushes to the consumer.
    await consumer_session.notify({ method: 'ready', params: [] })

    await waitFor(() => seen.length === 1)

    expect(seen).toMatchInlineSnapshot(`
      [
        {
          "jsonrpc": "2.0",
          "method": "dialog.mode.switch",
          "params": [
            {
              "mode": "popup",
            },
          ],
        },
      ]
    `)

    await consumer_session.close()
    await host_session.close()
  })

  test('re-announced hello flushes a host notification when the host missed the first hello', async () => {
    // An iframe host that mounts after the consumer's first hello never sees
    // it. Drop that first hello on the wire: unless the consumer re-announces
    // on the host's `ready`, the host never marks ready and its buffered
    // notification strands forever. Relay between two channels so we can
    // selectively swallow the first consumer hello.
    const toHost = new MessageChannel() // consumer <-> relay
    const toConsumer = new MessageChannel() // relay <-> host
    let droppedHello = false
    toHost.port2.addEventListener('message', (event) => {
      const inbound = protocol.readFrame(event.data)
      const isHello =
        inbound && (inbound.frame as { type?: string }).type === protocol.consumerHello.type
      if (isHello && !droppedHello) {
        droppedHello = true // the late host "misses" this one
        return
      }
      toConsumer.port1.postMessage(event.data)
    })
    toConsumer.port1.addEventListener('message', (event) => {
      toHost.port2.postMessage(event.data)
    })
    toHost.port2.start()
    toConsumer.port1.start()

    const consumer = Wata.create({
      transports: [postMessage_consumer({ target: () => toHost.port1 })],
    })
    const host = HostWata.create({ transports: [postMessage({ target: () => toConsumer.port2 })] })

    const seen: Rpc.Notification[] = []
    const consumer_session = await consumer.start()
    consumer_session.onNotification(({ notification }) => seen.push(notification))

    // The consumer establishes the channel on its first outbound frame; this
    // produces the hello the relay drops, so the host "misses" it.
    await consumer_session.notify({ method: 'connect', params: [] })

    const host_session = await host.start()
    // Buffered until the re-announced hello makes the host ready.
    await host_session.notify({ method: 'accountsChanged', params: [] })

    await waitFor(() => seen.length === 1)
    expect(droppedHello).toBe(true)
    expect(seen[0]?.method).toMatchInlineSnapshot(`"accountsChanged"`)

    await consumer_session.close()
    await host_session.close()
  })

  test('passes MessageEvent origin through host request and notification metadata', async () => {
    const source = Object.assign(new EventTarget(), { postMessage() {} }) as unknown as Window &
      EventTarget
    const handle = {
      addEventListener: source.addEventListener.bind(source),
      postMessage() {},
      removeEventListener: source.removeEventListener.bind(source),
    } as unknown as Window
    const host = await HostWata.create({
      transports: [
        postMessage({ source, target: () => handle, targetOrigin: 'https://app.example' }),
      ],
    }).start()
    const events: Array<{ kind: string; origin: string | undefined; transport: string }> = []

    host.onNotification((event) => {
      events.push({
        kind: 'notification',
        origin: event.meta.origin,
        transport: event.meta.transport,
      })
    })
    host.onRequest((event) => {
      events.push({
        kind: 'request',
        origin: event.meta.origin,
        transport: event.meta.transport,
      })
      if (event.method === 'ping') return event.respond({ ok: true })
      return undefined
    })
    source.dispatchEvent(
      new MessageEvent('message', {
        data: protocol.withId(
          Envelope.rpcRequests([
            Rpc.notification({ method: 'ping', params: [] }),
            Rpc.request({ id: 1, method: 'ping', params: [] }),
          ]),
        ),
        origin: 'https://app.example',
      }),
    )

    await waitFor(() => events.length === 2)
    expect(events).toMatchInlineSnapshot(`
      [
        {
          "kind": "notification",
          "origin": "https://app.example",
          "transport": "postMessage",
        },
        {
          "kind": "request",
          "origin": "https://app.example",
          "transport": "postMessage",
        },
      ]
    `)

    await host.close()
  })
})

async function waitFor(predicate: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
