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

import type { Bytes } from 'ox'

import * as Envelope from './Envelope.js'
import * as Errors from './Errors.js'
import * as Events from './Events.js'
import type * as MessageSig from './MessageSig.js'

/** Side of the protocol this transport speaks for. */
export type Role = 'consumer' | 'host'

/** Discriminator for the transport's lifetime model. */
export type Exchange = 'ongoing' | 'single_exchange'

/**
 * Events delivered on every transport. `message` carries the parsed
 * inbound envelope, `close` carries the optional close cause, `error`
 * carries the transport-level failure, `prompt` carries the optional
 * user-facing pairing/verification payload (only transports that pair
 * out-of-band ever emit it; the rest pin it to `never`).
 */
export type EventMap<meta extends MessageMeta = NoMessageMeta, prompt extends object = never> = {
  /** Transport closed (cleanly or with cause). */
  close: Error | undefined
  /** Transport-level failure. */
  error: Error
  /** Inbound envelope frame. */
  message: MessageArgs<meta>
  /** User-facing pairing/verification prompt produced during startup. */
  prompt: prompt
}

/** Metadata observed by a transport while receiving an inbound frame. */
export type MessageMeta = Record<string, unknown>

/** Message event arguments for transports with or without metadata. */
export type MessageArgs<meta extends MessageMeta = MessageMeta> = keyof meta extends never
  ? [
      /** Parsed inbound envelope. */
      envelope: Envelope.Envelope,
    ]
  : [
      /** Parsed inbound envelope. */
      envelope: Envelope.Envelope,
      /** Transport-defined metadata observed while receiving the frame. */
      meta: meta,
    ]

/** Empty metadata for transports that cannot observe peer metadata. */
export type NoMessageMeta = {}

/**
 * Signer-backed identity owned by the wrapping `Wata` application and
 * lazy-bound into transports that need to sign or publish authenticated
 * discovery fields.
 */
export type Identity = {
  /** Ed25519 public key encoded as unpadded base64url. */
  publicKey: string
  /**
   * Sign an arbitrary byte string under the identity key, returning the
   * raw 64-byte Ed25519 signature. The fundamental signing primitive,
   * used by transports whose proof is a detached signature over a
   * constructed blob (e.g. the `mobile-link` host `identity_sig`).
   */
  sign: (bytes: Bytes.Bytes) => Bytes.Bytes
  /** Sign an HTTP message under the identity key (RFC 9421). */
  signHttpMessage: (
    options: IdentitySignHttpMessageOptions,
  ) => IdentitySignHttpMessageReturn | Promise<IdentitySignHttpMessageReturn>
}

/** Options passed to an identity HTTP-message signer. */
export type IdentitySignHttpMessageOptions = Omit<MessageSig.sign.Options, 'privateKey'>

/** RFC 9421 headers returned by an identity HTTP-message signer. */
export type IdentitySignHttpMessageReturn = MessageSig.Headers

/**
 * Parent `Wata.create` context lazy-bound into transports that need
 * application-level discovery, metadata, or identity material.
 */
export type Binding = {
  /** Public origin shared by the wrapping application. */
  baseUrl?: string | undefined
  /** Signer-backed identity supplied to `Wata.create`. */
  identity?: Identity | undefined
  /** Human-facing app metadata. */
  meta?: unknown | undefined
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
   * Build the per-transport binding object (`register_url`,
   * `token_url`, etc.) given the parent `baseUrl`.
   */
  binding: (baseUrl: string) => unknown
  /**
   * Transport identifier in the published `transports` map (e.g.
   * `'device-code'`, `'webhook-callback'`, `'relay'`).
   */
  id: string
}

/** Directional support for one JSON-RPC operation kind. */
export type DirectionCapabilities = {
  /** True when the consumer side may initiate this operation. */
  consumer: boolean
  /** True when the host side may initiate this operation. */
  host: boolean
}

/** JSON-RPC operation directions supported by a transport. */
export type Capabilities = {
  /** Notification directions supported by the transport. */
  notifications: DirectionCapabilities
  /** Request directions supported by the transport. */
  requests: DirectionCapabilities
}

/**
 * Shape-customizing options for a {@link Transport}, folded into a single
 * bag so the common `Transport<role, name>` stays terse. Every field is
 * optional; omitted fields fall back to their default (`sendValue: void`,
 * `meta: NoMessageMeta`, `prompt: never`, `startOptions: never`). Spell
 * out only the fields a concrete transport actually widens, e.g.
 * `Transport<'consumer', 'relay', { prompt: Prompt; startOptions: Opts }>`.
 */
export type Options = {
  /** Metadata observed on inbound `message` events. Defaults to {@link NoMessageMeta}. */
  meta?: MessageMeta
  /** User-facing pairing/verification prompt payload. Defaults to `never`. */
  prompt?: object
  /** Value resolved by {@link Transport.send}. Defaults to `void`. */
  sendValue?: unknown
  /** Options accepted by {@link Transport.start}. Defaults to `never`. */
  startOptions?: unknown
}

/**
 * Fully-resolved {@link Options} — every field present. {@link Transport}
 * normalizes a partial {@link Options} bag into this via
 * {@link ResolveOptions} before projecting it into {@link Shape}, so the
 * object shape (and the extractor types) reach each field by direct
 * indexed access (which TypeScript can reverse-infer through, unlike a
 * defaulting conditional).
 */
type ResolvedOptions = {
  /** Metadata observed on inbound `message` events. */
  meta: MessageMeta
  /** User-facing pairing/verification prompt payload. */
  prompt: object
  /** Value resolved by {@link Transport.send}. */
  sendValue: unknown
  /** Options accepted by {@link Transport.start}. */
  startOptions: unknown
}

/** Normalize a partial {@link Options} bag into a {@link ResolvedOptions}. */
type ResolveOptions<options extends Options> = {
  meta: options extends { meta: infer meta extends MessageMeta } ? meta : NoMessageMeta
  prompt: options extends { prompt: infer prompt extends object } ? prompt : never
  sendValue: options extends { sendValue: infer sendValue } ? sendValue : void
  startOptions: options extends { startOptions: infer startOptions } ? startOptions : never
}

/**
 * A {@link Transport} with an unconstrained {@link Options.sendValue},
 * for constraint positions that accept any transport regardless of what
 * its `send` resolves with. Prefer this over `Transport<role, name>` in
 * `extends` clauses — the bare form pins `sendValue` to `void`.
 */
export type Any<role extends Role = Role, name extends string = string> = Transport<
  role,
  name,
  { sendValue: unknown }
>

/**
 * Transport-owned members beyond the normalized base {@link Transport}
 * contract — e.g. the `mobileLink` transport's `handleUrl`. The wrapping
 * consumer session hoists these onto its named accessor so callers reach
 * them directly as `wata.<name>.<member>`, mirroring the host side where
 * the named accessor *is* the transport.
 */
export type Extras<transport> = Omit<transport, keyof Any>

/**
 * Runtime counterpart to {@link Extras}: the own keys of the normalized
 * base {@link Transport} contract. The consumer session hoists every
 * *other* own key off the wrapped transport so transport-specific
 * helpers (e.g. `mobileLink`'s `handleUrl`) surface directly on
 * `wata.<name>`.
 */
export const baseKeys = [
  'bind',
  'callbackUrls',
  'capabilities',
  'close',
  'discovery',
  'exchange',
  'name',
  'on',
  'publicKey',
  'role',
  'routes',
  'send',
  'start',
] as const satisfies readonly (keyof Any)[]

/**
 * The normalized transport contract. Every adapter — consumer-side,
 * host-side, role-agnostic loopback — implements this shape. The third
 * type argument is a partial {@link Options} bag; see {@link Shape} for
 * the projected object type.
 */
export type Transport<
  role extends Role = Role,
  name extends string = string,
  options extends Options = {},
> = Shape<role, name, ResolveOptions<options>>

/**
 * Projected transport object type, keyed by a {@link ResolvedOptions}
 * bag whose fields are read by direct indexed access. Extractor types
 * ({@link PromptOf}, {@link MessageMetaOf}) match against this directly so
 * the `prompt` / `meta` positions stay reverse-inferable.
 */
type Shape<role extends Role, name extends string, options extends ResolvedOptions> = {
  /**
   * Apply parent application context to this transport. Lazy-bound by
   * `Wata.create({ baseUrl, identity, meta })` so transports can
   * derive discovery URLs, sign messages, and surface peer-facing
   * metadata from one app-level call. Idempotent: constructor-level
   * transport options still win.
   */
  bind?: ((binding: Binding) => void) | undefined
  /**
   * Consumer-side discovery contribution surfaced to the wrapping
   * `Wata.create({ baseUrl, meta })` so that the auto-published
   * `consumer.json` can carry a `callback_urls` allowlist (e.g.
   * the `webhookCallback` consumer transport's derived callback URL).
   * Host transports leave this `undefined`.
   */
  callbackUrls?: readonly string[] | undefined
  /** JSON-RPC operation directions this transport can represent. */
  capabilities: Capabilities
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
  /** Stable SDK-facing transport name used to expose child sessions. */
  name: name
  /**
   * Subscribe to a transport event. Listener receives the typed payload
   * directly. Pass `{ signal }` to scope the subscription to an
   * `AbortController`.
   */
  on: Events.Emitter<EventMap<options['meta'], options['prompt']>>['on']
  /**
   * Consumer-side identity public key surfaced to the wrapping
   * `Wata.create({ baseUrl, meta })` so that the auto-published
   * `consumer.json` can carry the `identity_pubkey` field required
   * by transports that authenticate the consumer (e.g.
   * `webhook-callback`). Encoded as **unpadded base64url** per
   * uRPC Discovery §2.2. Transports that don't authenticate the
   * consumer leave this `undefined`.
   */
  publicKey?: string | undefined
  /** Side of the protocol this transport speaks for. */
  role: role
  /**
   * HTTP route prefixes owned by this transport, when it exposes
   * `.fetch`. Composite `Wata.create({ transports })`
   * uses these to route requests without probing every transport.
   */
  routes?: readonly string[] | undefined
  /** Send a single envelope frame to the peer. */
  send: (envelope: Envelope.Envelope) => Promise<options['sendValue']>
  /**
   * Open the transport. Resolves once the wire is ready to send and
   * receive. Transports that accept per-start configuration (e.g. the
   * relay transport's `{ scheme }` / `{ pairingUri }`) widen
   * {@link Options.startOptions}; the rest take no argument.
   */
  start: (options?: options['startOptions']) => Promise<void>
}

/** Metadata emitted by a concrete transport. */
export type MessageMetaOf<transport extends Any> =
  transport extends Transport<Role, string, { meta: infer meta extends MessageMeta }>
    ? meta
    : MessageMeta

/**
 * User-facing prompt payload produced by a concrete transport, or
 * `never` for transports that never pair out-of-band.
 */
export type PromptOf<transport> =
  transport extends Transport<Role, string, { prompt: infer prompt extends object }>
    ? prompt
    : never

/**
 * Options accepted by a concrete transport's {@link Transport.start},
 * or `never` for transports whose `start` takes no argument.
 */
export type StartOptionsOf<transport extends { start: (...args: never) => unknown }> = Exclude<
  Parameters<transport['start']>[0],
  undefined
>

/** Value resolved by a transport's {@link Transport.send}. */
export type SendValue<transport extends { send: (...args: never) => Promise<unknown> }> = Awaited<
  ReturnType<transport['send']>
>

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
