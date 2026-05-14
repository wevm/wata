/**
 * In-process loopback transport — paired consumer + host adapters that
 * round-trip frames synchronously through a shared queue.
 *
 * This is the test substrate the rest of the suite relies on:
 *
 * - it lets us exercise the full `Transport` contract (start, send, close,
 *   message/close/error subscriptions) without spinning up a network,
 * - it accepts and emits Envelope frames just like a real transport, so
 *   the encryption + JSON-RPC layers can be exercised end-to-end against
 *   it without a `Handshake` instance (Phase 0 exit criteria),
 * - and once `Handshake.create` lands in Phase 1, the same loopback pair
 *   becomes the substrate for high-level integration tests.
 *
 * @example
 * ```ts
 * import { loopback } from 'handshakes'
 *
 * const { consumer, host } = loopback()
 * await consumer.start()
 * await host.start()
 *
 * host.on('message', (envelope) => console.log('host received', envelope))
 * await consumer.send(Envelope.rpcRequests([Rpc.notification({ method: 'ping', params: [] })]))
 * ```
 */

import * as Envelope from '../Envelope.js'
import * as Events from '../Events.js'
import * as Transport from '../Transport.js'

/**
 * Create a paired consumer + host loopback transport.
 *
 * @example
 * ```ts
 * import { loopback } from 'handshakes'
 *
 * const { consumer, host } = loopback()
 * ```
 */
export function loopback(): loopback.ReturnType {
  const consumer = createSide('consumer')
  const host = createSide('host')

  // Each side delivers its outbound frames to the other side's inbound queue.
  consumer.setPeer(host)
  host.setPeer(consumer)

  return { consumer: consumer.transport, host: host.transport }
}

export declare namespace loopback {
  /** Result of {@link loopback}. */
  type ReturnType = {
    /** Consumer-side transport. */
    consumer: Transport.Transport<'consumer'>
    /** Host-side transport. */
    host: Transport.Transport<'host'>
  }
}

type Peer = {
  transport: Transport.Transport
  deliver: (envelope: Envelope.Envelope) => void
  state: { started: boolean; closed: boolean }
}

function createSide<role extends 'consumer' | 'host'>(role: role) {
  const emitter = Events.create<Transport.EventMap>()
  const state = { started: false, closed: false }

  // Frames delivered to this side before it has subscribed are buffered so
  // the test ordering doesn't depend on whether a `message` listener is
  // attached before or after the first `send`.
  const buffered: Envelope.Envelope[] = []

  let peer: Peer | undefined

  function deliver(envelope: Envelope.Envelope) {
    if (state.closed) return
    if (emitter.listenerCount('message') === 0) {
      buffered.push(envelope)
      return
    }
    emitter.emit('message', envelope)
  }

  const transport: Transport.Transport<role> = {
    role,
    exchange: 'ongoing',
    async start() {
      if (state.closed) throw new Transport.ClosedError('loopback transport already closed')
      state.started = true
    },
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('loopback transport already closed')
      if (!state.started) throw new Transport.ClosedError('loopback transport not started')
      if (!peer) throw new Transport.ClosedError('loopback transport has no peer')
      peer.deliver(envelope)
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
      emitter.emit('close', cause)
      // Cascade to peer so both sides observe the close.
      if (peer && !peer.state.closed) await peer.transport.close(cause)
    },
    on(type, listener, options) {
      emitter.on(type, listener, options)
      // Drain any frames queued before the first `message` listener
      // attached. Done after `emitter.on` returns so the freshly-added
      // listener is part of the dispatch set.
      if (type === 'message')
        while (buffered.length > 0) {
          const next = buffered.shift()
          if (next !== undefined) emitter.emit('message', next)
        }
    },
  }

  return {
    transport,
    deliver,
    state,
    setPeer(value: Peer) {
      peer = value
    },
  }
}
