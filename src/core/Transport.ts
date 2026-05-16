/**
 * Normalized transport interface implemented by every uRPC wire adapter.
 *
 * A transport is a thin wrapper around a particular wire (popup
 * `postMessage`, HTTPS POST, SSE, deep link, in-process loopback). It
 * exposes:
 *
 * - `role` / `exchange` — protocol-level metadata. `role` is pinned by the
 *   import path (`wata` for consumer, `wata/host` for host) so
 *   `Wata.create` can shape its return type from a literal. `exchange`
 *   discriminates ongoing transports (`window`, `mobileLink`, `relay`) from
 *   single-exchange transports (`deviceCode`, `webhookCallback`,
 *   `mobileWebAuth`) and gates the `auto-close after terminal response`
 *   behaviour.
 * - `start` / `send` / `close` — wire lifecycle.
 * - `on` — single typed event surface for inbound delivery and failure
 *   propagation. Listeners receive the typed payload directly (the parsed
 *   envelope, the close cause, or the error). Cancel a subscription by
 *   passing `{ signal }` to the `on` call and aborting the controller.
 *   Phase 1 `Wata` wraps this into the consumer-facing event surface.
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
  /** Transport closed (cleanly or with cause). */
  close: Error | undefined
  /** Transport-level failure. */
  error: Error
  /** Inbound envelope frame. */
  message: Envelope.Envelope
}

/**
 * Discovery contribution surfaced by an HTTP-server-shaped transport.
 * Read by `Wata.create({ baseUrl, meta })` to auto-build the
 * `transports` map of `/.well-known/urpc/{host,consumer}.json` —
 * each transport contributes its own entry under {@link id} via
 * {@link binding}, called with the parent `baseUrl`.
 *
 * Non-HTTP transports (e.g. `loopback`, `postMessage`) leave this
 * `undefined`; they don't appear in the published discovery doc.
 */
export type DiscoveryBinding = {
  /**
   * Transport identifier in the published `transports` map (e.g.
   * `'device-code'`, `'webhook-callback'`, `'relay'`).
   */
  id: string
  /**
   * Build the per-transport binding object (`register_url`,
   * `token_url`, etc.) given the parent `baseUrl`.
   */
  binding: (baseUrl: string) => unknown
}

/**
 * The normalized transport contract. Every adapter — consumer-side,
 * host-side, role-agnostic loopback — implements this shape.
 */
export type Transport<role extends Role = Role> = {
  /**
   * Apply a parent app's `baseUrl` to this transport. Lazy-bound by
   * `Wata.create({ baseUrl })` so transports that need an origin
   * (e.g. host `deviceCode` building `verification_uri`) can
   * inherit it from the wrapping `Wata` instance. Idempotent — a
   * transport's own constructor-level `baseUrl` (if any) wins.
   */
  bindBaseUrl?: ((baseUrl: string) => void) | undefined
  /**
   * Apply parent {@link Discovery.Meta} to this transport. Lazy-bound
   * by `Wata.create({ meta })` so transports that need to surface
   * metadata to the peer (e.g. consumer `deviceCode` serializing
   * `meta` into `/register` payloads) can inherit it from the
   * wrapping `Wata` instance. A transport's own constructor-level
   * `meta` (if any) wins.
   */
  bindMeta?: ((meta: unknown) => void) | undefined
  /** Close the transport. Idempotent. */
  close: (cause?: Error) => Promise<void>
  /**
   * Optional discovery contribution. HTTP-server-shaped host
   * transports populate this so {@link "../Wata".create} can auto-build
   * the `transports` map of the published well-known document.
   */
  discovery?: DiscoveryBinding | undefined
  /** Lifetime model — see {@link Exchange}. */
  exchange: Exchange
  /**
   * Subscribe to a transport event. Listener receives the typed payload
   * directly. Pass `{ signal }` to scope the subscription to an
   * `AbortController`.
   */
  on: Events.Emitter<EventMap>['on']
  /** Side of the protocol this transport speaks for. */
  role: role
  /** Send a single envelope frame to the peer. */
  send: (envelope: Envelope.Envelope) => Promise<void>
  /** Open the transport. Resolves once the wire is ready to send and receive. */
  start: () => Promise<void>
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
