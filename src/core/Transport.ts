/**
 * Normalized transport interface implemented by every TempoCP wire adapter.
 *
 * A transport is a thin wrapper around a particular wire (popup
 * `postMessage`, HTTPS POST, SSE, deep link, in-process loopback). It
 * exposes:
 *
 * - `role` / `exchange` — protocol-level metadata. `role` is pinned by the
 *   import path (`handshakes` for consumer, `handshakes/host` for host) so
 *   `Handshake.create` can shape its return type from a literal. `exchange`
 *   discriminates ongoing transports (`window`, `mobileLink`, `relay`) from
 *   single-exchange transports (`deviceCode`, `webhookCallback`,
 *   `mobileWebAuth`) and gates the `auto-close after terminal response`
 *   behaviour.
 * - `start` / `send` / `close` — wire lifecycle.
 * - `onMessage` / `onClose` / `onError` — inbound delivery and failure
 *   propagation. Each subscriber returns an unsubscribe function. Phase 1
 *   `Handshake` wraps this into the typed `rettime` event surface visible
 *   to consumers.
 *
 * Adapters MUST only carry normalized {@link "./core/Envelope".Envelope}
 * frames over the wire — never raw protocol-internal shapes — so the
 * transport boundary stays stable across schema and protocol revisions.
 */

import * as Envelope from './Envelope.js'
import * as Errors from './Errors.js'

/** Side of the protocol this transport speaks for. */
export type Role = 'consumer' | 'host'

/** Discriminator for the transport's lifetime model. */
export type Exchange = 'ongoing' | 'single_exchange'

/** Listener called whenever an inbound envelope is delivered. */
export type MessageListener = (envelope: Envelope.Envelope) => void

/** Listener called when the transport closes (cleanly or with cause). */
export type CloseListener = (cause?: Error) => void

/** Listener called on transport-level failures. */
export type ErrorListener = (error: Error) => void

/** Function returned from every `on*` subscription; call to unsubscribe. */
export type Unsubscribe = () => void

/**
 * The normalized transport contract. Every adapter — consumer-side,
 * host-side, role-agnostic loopback — implements this shape.
 */
export type Transport<role extends Role = Role> = {
  /** Side of the protocol this transport speaks for. */
  role: role
  /** Lifetime model — see {@link Exchange}. */
  exchange: Exchange
  /** Open the transport. Resolves once the wire is ready to send and receive. */
  start: () => Promise<void>
  /** Send a single envelope frame to the peer. */
  send: (envelope: Envelope.Envelope) => Promise<void>
  /** Close the transport. Idempotent. */
  close: (cause?: Error) => Promise<void>
  /** Subscribe to inbound envelope frames. */
  onMessage: (listener: MessageListener) => Unsubscribe
  /** Subscribe to close events. */
  onClose: (listener: CloseListener) => Unsubscribe
  /** Subscribe to transport-level error events. */
  onError: (listener: ErrorListener) => Unsubscribe
}

/**
 * Thrown when the underlying transport fails (network error, peer
 * unreachable, single-exchange transport invoked twice). Wraps the original
 * cause when one is available.
 */
export class TransportError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'Transport.TransportError'
}

/**
 * Thrown when a `send()` call is made after the session has closed (peer
 * disconnected, single-exchange transport already settled, or `.close()`
 * invoked locally).
 */
export class ClosedError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'Transport.ClosedError'
}

/**
 * Thrown when a transport rejects an operation that isn't representable on
 * its wire format (e.g. `sendBatch()` on a single-exchange transport that
 * doesn't carry batches).
 */
export class UnsupportedError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'Transport.UnsupportedError'
}
