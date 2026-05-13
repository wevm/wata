import { Envelope } from 'handshakes'
import { postMessage } from 'handshakes/host'
import { describe, expect, test } from 'vp/test'

import * as protocol from '../../consumer/transports/internal/protocol.js'

/**
 * Browser unit tests for the host-side `postMessage` transport. The host is
 * a thin wrapper around the same `createSide` helper as the consumer — these
 * tests cover the host-specific bits (role + inverted handshake direction).
 */
describe('postMessage (host)', () => {
  test('emits `tempocp.ready` on start and waits for the consumer hello', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage({ open: () => port1 })

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
          "type": "tempocp.ready",
        },
      ]
    `)

    await transport.close()
  })

  test('drains buffered frames once the consumer hello arrives', async () => {
    const { port1, port2 } = new MessageChannel()
    const transport = postMessage({ open: () => port1 })

    const peerSeen: unknown[] = []
    port2.addEventListener('message', (event) => {
      peerSeen.push(event.data)
    })
    port2.start()

    await transport.start()
    // Wait for the host's ready frame to land at the peer before clearing.
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Consumer hasn't said hello yet — outbound frames should be buffered.
    await transport.send(Envelope.plain({ method: 'one' }))
    await transport.send(Envelope.plain({ method: 'two' }))

    // Drop the host's hello (`tempocp.ready`) so the snapshot only shows
    // the buffered user frames.
    peerSeen.length = 0

    port2.postMessage(protocol.consumerHello)

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(peerSeen).toMatchInlineSnapshot(`
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

  test('reports role: "host" and exchange: "ongoing"', () => {
    const { port1 } = new MessageChannel()
    const transport = postMessage({ open: () => port1 })
    expect(transport.role).toBe('host')
    expect(transport.exchange).toBe('ongoing')
  })
})
