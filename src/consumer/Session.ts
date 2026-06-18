/**
 * Consumer session types.
 *
 * The consumer session surface: the live {@link Session} object returned by
 * `wata.<name>.start()` (`send` / `notify`, the `onX` / `offX` event
 * surface, the pairing `prompt`, and transport-specific
 * {@link Transport.Extras extras}), plus the consumer event/listener types
 * the session emits ({@link ConsumerListeners}, {@link ConsumerEventMap},
 * {@link ConsumerPromptEvent}, {@link NotificationEvent}, {@link SendResult}).
 *
 * Cross-side primitives ({@link Listener}, {@link EnvelopeMeta},
 * {@link ObservedEnvelope}, {@link LifecycleEventMap}, {@link RequestContextOf})
 * live in {@link "../core/Session"} and are re-exported here so the public
 * `Session` namespace carries the full consumer session vocabulary. The
 * consumer config + factory live in {@link "./Wata"}.
 */

import type * as Rpc from '../core/Rpc.js'
import type * as Schema from '../core/Schema.js'
import type * as core_Session from '../core/Session.js'
import type * as Transport from '../core/Transport.js'
import type * as Wata from './Wata.js'

export * from '../core/Session.js'

/**
 * Result of a single {@link Wata.Consumer.send} call. We return
 * `{ id, result }` (rather than the bare `result`) so callers can correlate
 * with logs and batch/trace tooling without losing the JSON-RPC identity.
 */
export type SendResult<result> = {
  /** Id of the JSON-RPC request that produced this response. */
  id: Rpc.Id
  /** Decoded `result` payload from the host's success response. */
  result: result
}

/** Event payload delivered to consumer `'notification'` listeners. */
export type NotificationEvent<
  method extends string = string,
  params extends Rpc.Params = Rpc.Params,
> = {
  /** Method name. Top-level discriminator for schema-narrowed listeners. */
  method: method
  /** The full JSON-RPC notification envelope as parsed off the wire. */
  notification: Rpc.Notification<method, params>
  /** Notification params. */
  params: params
  /** SDK-facing name of the transport that delivered this notification. */
  transport: string
}

/** Distribute notification payloads over schema method names. */
type DistributeNotification<schema extends Schema.Schema, name extends string> =
  name extends Schema.MethodName<schema>
    ? Schema.ParamsOf<schema, name> extends infer params
      ? params extends Rpc.Params
        ? NotificationEvent<name, params>
        : never
      : never
    : never

/** Helper conditional mapping a schema to a typed consumer notification event. */
export type SchemaNotificationEvent<schema extends Schema.Schema | undefined> =
  schema extends Schema.Schema
    ? DistributeNotification<schema, Schema.MethodName<schema>>
    : NotificationEvent

/** Consumer-side event map. */
export type ConsumerEventMap<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
  prompt extends object = never,
> = core_Session.LifecycleEventMap<schema, context> & {
  /** Inbound JSON-RPC notification from the host. */
  notification: SchemaNotificationEvent<schema>
  /**
   * User-facing pairing/verification prompt produced by an out-of-band
   * transport (e.g. `relay`, `deviceCode`) during startup. Discriminated
   * by {@link ConsumerPromptEvent transport}, so listeners narrow to the
   * exact payload of the transport that produced it.
   */
  prompt: prompt
  /**
   * Emitted exactly once when the session's transport has started — the
   * point the awaited {@link Session.ready} promise resolves. Fires after
   * the connection is established for eager / connected transports.
   */
  ready: undefined
}

/**
 * Consumer `'prompt'` payload derived from a transport: the transport's
 * own {@link "../core/Transport".PromptOf prompt} shape tagged with its
 * SDK-facing `transport` name. Transports that never pair out-of-band
 * contribute `never`, so they drop out of the union.
 */
export type ConsumerPromptEvent<transport extends Transport.Any> = transport extends unknown
  ? [Transport.PromptOf<transport>] extends [never]
    ? never
    : Transport.PromptOf<transport> & {
        /** SDK-facing name of the transport that produced the prompt. */
        transport: transport['name']
      }
  : never

/**
 * Consumer `onX` / `offX` listener surface — one method per
 * {@link ConsumerEventMap} event. Shared by {@link Session} and
 * {@link Wata.ConsumerBase}. Payloads are sourced from `map`, so the
 * per-event payload docs live on the event map; the docs here describe each
 * subscription. Every `onX` returns an `AbortController` so the
 * subscription can be cancelled (or composed with an external signal).
 */
export type ConsumerListeners<map extends Record<string, unknown>> = {
  /**
   * Remove a previously subscribed `'close'` listener (matched by
   * reference).
   */
  offClose: (listener: core_Session.Listener<map['close']>) => void
  /**
   * Remove a previously subscribed `'envelope'` listener (matched by
   * reference).
   */
  offEnvelope: (listener: core_Session.Listener<map['envelope']>) => void
  /**
   * Remove a previously subscribed `'error'` listener (matched by
   * reference).
   */
  offError: (listener: core_Session.Listener<map['error']>) => void
  /**
   * Remove a previously subscribed `'notification'` listener (matched by
   * reference).
   */
  offNotification: (listener: core_Session.Listener<map['notification']>) => void
  /**
   * Remove a previously subscribed `'prompt'` listener (matched by
   * reference).
   */
  offPrompt: (listener: core_Session.Listener<map['prompt']>) => void
  /**
   * Remove a previously subscribed `'ready'` listener (matched by
   * reference).
   */
  offReady: (listener: core_Session.Listener<map['ready']>) => void
  /**
   * Subscribe to the session closing, cleanly or with a cause. Fires
   * exactly once per session.
   */
  onClose: (listener: core_Session.Listener<map['close']>) => AbortController
  /**
   * Observe raw uRPC envelopes (`rpc-requests` / `rpc-responses`)
   * crossing the wire in either direction — a read-only tap for
   * logging/tracing. Discriminate on `envelope.type`; use `send` /
   * `notify` to issue traffic.
   */
  onEnvelope: (listener: core_Session.Listener<map['envelope']>) => AbortController
  /**
   * Subscribe to transport errors (network, parse, AEAD).
   */
  onError: (listener: core_Session.Listener<map['error']>) => AbortController
  /**
   * Subscribe to inbound JSON-RPC notifications from the host.
   */
  onNotification: (listener: core_Session.Listener<map['notification']>) => AbortController
  /**
   * Subscribe to user-facing pairing/verification prompts produced by an
   * out-of-band transport (e.g. `relay`, `deviceCode`) during startup.
   * Replays the session's current {@link Session.prompt} (if any) to the
   * listener on subscribe, since the prompt is produced during `start()` —
   * before the session handle is returned to the caller.
   */
  onPrompt: (listener: core_Session.Listener<map['prompt']>) => AbortController
  /**
   * Subscribe to the session becoming ready — its transport has started
   * (connection established for eager / connected transports). Fires
   * exactly once per session; mirrors the awaited {@link Session.ready}
   * promise.
   */
  onReady: (listener: core_Session.Listener<map['ready']>) => AbortController
}

/**
 * Session core shared by the consumer's named accessor ({@link Session})
 * and the single-transport top-level surface. Holds the wrapped lifecycle
 * methods; transport-specific extras are layered on by {@link Session}.
 */
type Core<
  schema extends Schema.Schema | undefined,
  transport extends Transport.Any<'consumer'>,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = ConsumerListeners<ConsumerEventMap<schema, context, ConsumerPromptEvent<transport>>> & {
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Send a typed JSON-RPC notification (no response expected).
   */
  notify: <const method extends Wata.Consumer.MethodName<schema>>(
    options: Wata.Consumer.NotifyOptions<schema, method>,
  ) => Promise<void>
  /**
   * The session's current pairing/verification prompt, if the wrapped
   * transport produced one during `start()` (e.g. the `relay` transport's
   * pairing link). `undefined` for transports that never pair out-of-band.
   * Render it directly without subscribing to {@link onPrompt}; the same
   * payload is also replayed to late `onPrompt` subscribers.
   */
  prompt: ConsumerPromptEvent<transport> | undefined
  /**
   * Resolves once the session's transport has started — the connection is
   * established for eager / connected transports. Rejects if the start
   * fails (e.g. a blocked popup). Await it when you need to surface the
   * connect outcome or render a connecting state; `send` / `notify` already
   * await it internally, so most callers can ignore it.
   */
  ready: Promise<void>
  /** Side of the protocol this wata speaks for. */
  role: 'consumer'
  /** Optional method-registry schema flowed through `send` / `notify`. */
  schema: schema
  /**
   * Send a typed JSON-RPC request over this transport. Ongoing transports
   * resolve with the host's `result`. Out-of-band transports may resolve
   * with registration metadata and emit the eventual host result through
   * `'rpc-responses'`.
   */
  send: <const method extends Wata.Consumer.MethodName<schema>>(
    options: Wata.Consumer.SendOptions<schema, method, context>,
  ) => Promise<Wata.Consumer.SendReturn<schema, transport, method>>
  /** The wrapped transport. */
  transport: transport
}

/**
 * Transport-specific consumer session exposed on `wata.<transportName>`.
 * Carries the session's wrapped lifecycle surface plus any
 * transport-specific {@link Transport.Extras extras} (e.g. the
 * `mobileLink` transport's `handleUrl`), hoisted up so callers reach
 * them directly as `wata.<name>.handleUrl(...)` — mirroring the host,
 * where the named accessor *is* the transport. Extras that would collide
 * with a session member are dropped so the wrapped surface always wins.
 */
export type Session<
  schema extends Schema.Schema | undefined,
  transport extends Transport.Any<'consumer'>,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = Core<schema, transport, context> &
  Omit<Transport.Extras<transport>, keyof Core<schema, transport, context>>
