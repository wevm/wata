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
 * host.onMessage((envelope) => console.log('host received', envelope))
 * await consumer.send(Envelope.plain({ method: 'ping' }))
 * ```
 */

import type * as Envelope from '../Envelope.js'
import {
  ClosedError,
  type CloseListener,
  type ErrorListener,
  type MessageListener,
  type Transport,
  type Unsubscribe,
} from '../Transport.js'

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
    consumer: Transport<'consumer'>
    /** Host-side transport. */
    host: Transport<'host'>
  }
}

type Peer = {
  transport: Transport
  deliver: (envelope: Envelope.Envelope) => void
  state: { started: boolean; closed: boolean }
}

function createSide<role extends 'consumer' | 'host'>(role: role) {
  const messageListeners = new Set<MessageListener>()
  const closeListeners = new Set<CloseListener>()
  const errorListeners = new Set<ErrorListener>()
  const state = { started: false, closed: false }

  // Frames delivered to this side before it has subscribed are buffered so
  // the test ordering doesn't depend on whether `onMessage` happens before
  // or after the first `send`.
  const buffered: Envelope.Envelope[] = []

  let peer: Peer | undefined

  function deliver(envelope: Envelope.Envelope) {
    if (state.closed) return
    if (messageListeners.size === 0) {
      buffered.push(envelope)
      return
    }
    for (const listener of messageListeners) listener(envelope)
  }

  const subscribe =
    <listener>(set: Set<listener>) =>
    (listener: listener): Unsubscribe => {
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    }

  const transport: Transport<role> = {
    role,
    exchange: 'ongoing',
    async start() {
      if (state.closed) throw new ClosedError('loopback transport already closed')
      state.started = true
    },
    async send(envelope) {
      if (state.closed) throw new ClosedError('loopback transport already closed')
      if (!state.started) throw new ClosedError('loopback transport not started')
      if (!peer) throw new ClosedError('loopback transport has no peer')
      peer.deliver(envelope)
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
      for (const listener of closeListeners) listener(cause)
      // Cascade to peer so both sides observe the close.
      if (peer && !peer.state.closed) await peer.transport.close(cause)
    },
    onMessage(listener) {
      const unsubscribe = subscribe(messageListeners)(listener)
      // Drain any frames queued before subscription happened.
      while (buffered.length > 0) {
        const next = buffered.shift()
        if (next !== undefined) listener(next)
      }
      return unsubscribe
    },
    onClose: subscribe(closeListeners),
    onError: subscribe(errorListeners),
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
