import {
  Envelope,
  Handshake,
  Rpc,
  postMessage as postMessage_consumer,
} from 'handshakes'
import {
  Handshake as HostHandshake,
  postMessage,
} from 'handshakes/host'
import { describe, expect, test } from 'vp/test'

import * as protocol from '../../consumer/transports/internal/protocol.js'

/**
 * Browser unit tests for the host-side `postMessage` transport. The host is
 * a thin wrapper around the same `createSide` helper as the consumer — these
 * tests cover the host-specific bits (role + inverted handshake direction).
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

    expect(peerSeen).toMatchInlineSnapshot(`
      [
        {
          "type": "urpc.ready",
        },
      ]
    `)

    await transport.close()
  })

  test('drains buffered frames once the consumer hello arrives', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage({ target: () => port1 })

    const peerSeen: unknown[] = []
    port2.addEventListener('message', (event) => {
      peerSeen.push(event.data)
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

    port2.postMessage(protocol.consumerHello)

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(peerSeen).toMatchInlineSnapshot(`
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

  test('reports role: "host" and exchange: "ongoing"', () => {
    const { port1 } = new MessageChannel()
    const transport = postMessage({ target: () => port1 })
    expect(transport.role).toBe('host')
    expect(transport.exchange).toBe('ongoing')
  })
})

/**
 * End-to-end coverage for the host-side `Handshake.respond` / `Handshake.reject`
 * API over real `postMessage` (`MessageChannel` peers). Mirrors
 * `src/Handshake.test.ts` but on the wire, and exercises the
 * "no listener at all → method not found" fallthrough too.
 */
describe('Handshake.respond / Handshake.reject (postMessage)', () => {
  function pair() {
    const { port1, port2 } = new MessageChannel()
    const consumer = Handshake.create({ transport: postMessage_consumer({ target: () => port1 }) })
    const host = HostHandshake.create({ transport: postMessage({ target: () => port2 }) })
    return { consumer, host }
  }

  test('handshake.respond settles a pending request by id (lazy connect)', async () => {
    // Both sides skip the explicit `start()` — `on(...)`
    // and `send(...)` should self-start the transports.
    const { consumer, host } = pair()

    let captured: { id: number | string } | undefined
    host.on('request', (event) => {
      captured = { id: event.id }
    })

    const inflight = consumer.send({ method: 'ping', params: [] })
    // Wait until the host has actually received the request frame.
    await waitFor(() => captured !== undefined)
    host.respond(captured!.id, { ok: true })

    expect((await inflight).result).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)

    await consumer.close()
  })

  test('handshake.reject sends a JSON-RPC error response by id', async () => {
    const { consumer, host } = pair()
    await Promise.all([consumer.start(), host.start()])

    let captured: { id: number | string } | undefined
    host.on('request', (event) => {
      captured = { id: event.id }
    })

    const inflight = consumer.send({ method: 'ping', params: [] })
    await waitFor(() => captured !== undefined)

    host.reject(captured!.id, { code: -32000, message: 'denied' })

    await expect(inflight).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: denied]`)

    await consumer.close()
  })

  test('no listener at all → method not found', async () => {
    const { consumer, host } = pair()
    await Promise.all([consumer.start(), host.start()])

    await expect(
      consumer.send({ method: 'ping', params: [] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(`[Rpc.RpcError: method not found]`)

    await consumer.close()
  })
})

async function waitFor(predicate: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
