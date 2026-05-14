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
 * - `on` — single typed event surface for inbound delivery and failure
 *   propagation. Listeners receive the typed payload directly (the parsed
 *   envelope, the close cause, or the error). Cancel a subscription by
 *   passing `{ signal }` to the `on` call and aborting the controller.
 *   Phase 1 `Handshake` wraps this into the consumer-facing event surface.
 *
 * Adapters MUST only carry normalized {@link "./core/Envelope".Envelope}
 * frames over the wire — never raw protocol-internal shapes — so the
 * transport boundary stays stable across schema and protocol revisions.
 */

import * as Envelope from './Envelope.js'
import * as Errors from './Errors.js'
import * as Events from './Events.js'

/** Side of the protocol this transport speaks for. */
export type Role = 'consumer' | 'host'

/** Discriminator for the transport's lifetime model. */
export type Exchange = 'ongoing' | 'single_exchange'

/**
 * Events delivered on every transport. `message` carries the parsed
 * inbound envelope, `close` carries the optional close cause, `error`
 * carries the transport-level failure.
 */
export type EventMap = {
  /** Inbound envelope frame. */
  message: Envelope.Envelope
  /** Transport closed (cleanly or with cause). */
  close: Error | undefined
  /** Transport-level failure. */
  error: Error
}

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
  /**
   * Subscribe to a transport event. Listener receives the typed payload
   * directly. Pass `{ signal }` to scope the subscription to an
   * `AbortController`.
   */
  on: Events.Emitter<EventMap>['on']
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
