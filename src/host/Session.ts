/**
 * Host session types and composition.
 *
 * {@link Session} is the live host session for one transport, returned by
 * `wata.<name>.start()`. A multi-transport host opens one per transport;
 * {@link compose} merges several of those into a single handle so one set
 * of handlers answers requests arriving on any of them — the inbound
 * `onRequest` / `onNotification` / lifecycle surface fans out across every
 * member, while answering stays on the event itself (`event.respond`,
 * which knows its transport).
 *
 * @example
 * ```ts
 * import { Session, Wata, deviceCode, webhookCallback } from 'wata/host'
 *
 * const wata = Wata.create({
 *   transports: [deviceCode({ ... }), webhookCallback({ ... })],
 * })
 *
 * const session = await Session.compose([
 *   wata.deviceCode.start(),
 *   wata.webhookCallback.start(),
 * ])
 *
 * session.onRequest(async (event) => {
 *   await event.respond({ message: 'pong', transport: event.transport })
 * })
 * ```
 */

import * as Events from '../core/Events.js'
import * as Rpc from '../core/Rpc.js'
import type * as Schema from '../core/Schema.js'
import type * as core_Session from '../core/Session.js'
import type * as Transport from '../core/Transport.js'
import type * as Wata from './Wata.js'

/**
 * Event payload delivered to host `'request'` listeners.
 *
 * The discriminator (`method`) is **lifted to the top level** so listeners
 * can narrow `respond`'s argument and `params` together with a single
 * check (`if (event.method === 'ping') { ... }`). TypeScript does not
 * narrow through nested discriminators when one of the sibling properties
 * is a function (the contravariant parameter type collapses to an
 * intersection that is usually `never`).
 */
export type RequestEvent<
  method extends string = string,
  params extends Rpc.Params = Rpc.Params,
  result = unknown,
  transport extends Wata.HostTransport = Wata.HostTransport,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /** Optional per-request context metadata attached by the consumer. */
  context?: context | undefined
  /** Id of the JSON-RPC request being answered. */
  id: Rpc.Id
  /** Transport metadata observed while receiving the request. */
  meta: Wata.HostEventMeta<transport>
  /** Method name. Top-level discriminator for schema-narrowed listeners. */
  method: method
  /** Method params. */
  params: params
  /**
   * Sugar for `wata.reject(event.id, error)`. Resolves once the error
   * response has flushed to the transport (so popup hosts can `await`
   * delivery before calling `window.close()`). Idempotent.
   */
  reject: (error: { code: number; data?: unknown; message: string }) => Promise<void>
  /** The full JSON-RPC request envelope as parsed off the wire. */
  request: Rpc.Request<method, params, context>
  /**
   * Sugar for `wata.respond(event.id, result)`. Resolves once the
   * success response has flushed to the transport (so popup hosts can
   * `await` delivery before calling `window.close()`). Idempotent
   * across `event.respond` / `event.reject` / `wata.respond` /
   * `wata.reject`.
   */
  respond: (result: result) => Promise<void>
  /** SDK-facing name of the transport that delivered this request. */
  transport: transport['name']
}

/** Event payload delivered to host `'notification'` listeners. */
export type NotificationEvent<
  method extends string = string,
  params extends Rpc.Params = Rpc.Params,
  transport extends Wata.HostTransport = Wata.HostTransport,
> = {
  /** Transport metadata observed while receiving the notification. */
  meta: Wata.HostEventMeta<transport>
  /** Method name. Top-level discriminator for schema-narrowed listeners. */
  method: method
  /** The full JSON-RPC notification envelope as parsed off the wire. */
  notification: Rpc.Notification<method, params>
  /** Notification params. */
  params: params
  /** SDK-facing name of the transport that delivered this notification. */
  transport: transport['name']
}

/**
 * Distribute over the schema's method names so the `request` payload is a
 * proper discriminated union. Narrowing on `event.method` narrows
 * `event.respond`'s argument and `event.params` together.
 */
type DistributeRequest<
  schema extends Schema.Schema,
  name extends string,
  transport extends Wata.HostTransport,
  context extends Rpc.RequestContext,
> = transport extends Wata.HostTransport
  ? name extends Schema.MethodName<schema>
    ? Schema.ParamsOf<schema, name> extends infer params
      ? params extends Rpc.Params
        ? RequestEvent<name, params, Schema.ResultOf<schema, name>, transport, context>
        : never
      : never
    : never
  : never

/** Same shape as {@link DistributeRequest}, but for notifications. */
type DistributeNotification<
  schema extends Schema.Schema,
  name extends string,
  transport extends Wata.HostTransport,
> = transport extends Wata.HostTransport
  ? name extends Schema.MethodName<schema>
    ? Schema.ParamsOf<schema, name> extends infer params
      ? params extends Rpc.Params
        ? NotificationEvent<name, params, transport>
        : never
      : never
    : never
  : never

type DistributeTransportNotification<transport extends Wata.HostTransport> =
  transport extends Wata.HostTransport ? NotificationEvent<string, Rpc.Params, transport> : never

type DistributeTransportRequest<
  transport extends Wata.HostTransport,
  context extends Rpc.RequestContext,
> = transport extends Wata.HostTransport
  ? RequestEvent<string, Rpc.Params, unknown, transport, context>
  : never

type HostRequestEventOf<
  schema extends Schema.Schema | undefined,
  method extends string,
  transport extends Wata.HostTransport,
  context extends Rpc.RequestContext,
> = transport extends Wata.HostTransport
  ? method extends Wata.Host.MethodName<schema>
    ? Wata.Host.ParamsOf<schema, method> extends infer params
      ? params extends Rpc.Params
        ? RequestEvent<method, params, Wata.Host.ResultOf<schema, method>, transport, context>
        : never
      : never
    : never
  : never

type HostRequestListener<
  schema extends Schema.Schema | undefined,
  method extends string,
  transport extends Wata.HostTransport,
  context extends Rpc.RequestContext,
> = (
  event: HostRequestEventOf<schema, method, transport, context>,
) => Wata.Host.ResultOf<schema, method> | Promise<Wata.Host.ResultOf<schema, method> | void> | void

type HostRequestDispatchListener<
  schema extends Schema.Schema | undefined,
  transports extends Wata.HostTransports,
  context extends Rpc.RequestContext,
> = (event: SchemaRequestEvent<schema, transports, context>) => Promise<void> | void

/**
 * Helper conditional that maps a {@link Schema} method name to the typed
 * `RequestEvent` payload host listeners receive.
 */
export type SchemaRequestEvent<
  schema extends Schema.Schema | undefined,
  transports extends Wata.HostTransports = Wata.HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = schema extends Schema.Schema
  ? DistributeRequest<schema, Schema.MethodName<schema>, transports[number], context>
  : DistributeTransportRequest<transports[number], context>

/** Helper conditional mapping a schema to the typed `NotificationEvent`. */
export type SchemaNotificationEvent<
  schema extends Schema.Schema | undefined,
  transports extends Wata.HostTransports = Wata.HostTransports,
> = schema extends Schema.Schema
  ? DistributeNotification<schema, Schema.MethodName<schema>, transports[number]>
  : DistributeTransportNotification<transports[number]>

/** Host-side event map (lifecycle + request/notification dispatch). */
export type HostEventMap<
  schema extends Schema.Schema | undefined,
  transports extends Wata.HostTransports = Wata.HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = core_Session.LifecycleEventMap<schema, context> & {
  /** Inbound JSON-RPC notification. Fire-and-forget. */
  notification: SchemaNotificationEvent<schema, transports>
  /**
   * Inbound JSON-RPC request. Broad listeners should respond via
   * `event.respond`; only method-scoped request listeners may answer by
   * returning a non-`undefined` result.
   */
  request: SchemaRequestEvent<schema, transports, context>
}

export type HostOffRequest<
  schema extends Schema.Schema | undefined,
  transports extends Wata.HostTransports,
  context extends Rpc.RequestContext,
> = {
  /** Remove a method-scoped request listener. */
  <const method extends Wata.Host.MethodName<schema>>(
    method: method,
    listener: HostRequestListener<schema, method, transports[number], context>,
  ): void
  /** Remove a broad request listener. */
  (listener: HostRequestDispatchListener<schema, transports, context>): void
}

export type HostOnRequest<
  schema extends Schema.Schema | undefined,
  transports extends Wata.HostTransports,
  context extends Rpc.RequestContext,
> = {
  /**
   * Subscribe to requests for one JSON-RPC method. A non-`undefined` listener
   * return value answers the request.
   */
  <const method extends Wata.Host.MethodName<schema>>(
    method: method,
    listener: HostRequestListener<schema, method, transports[number], context>,
  ): AbortController
  /**
   * Subscribe to broad host request dispatch. Respond via `event.respond`;
   * listener return values are ignored.
   */
  (listener: HostRequestDispatchListener<schema, transports, context>): AbortController
}

/**
 * Host `onX` / `offX` listener surface — one method per
 * {@link HostEventMap} event, excluding `'request'` (which has its own
 * overloaded {@link Wata.Host.onRequest}). Payloads are sourced from `map`, so
 * the per-event payload docs live on the event map; the docs here
 * describe each subscription. Every `onX` returns an `AbortController` so
 * the subscription can be cancelled (or composed with an external signal).
 * Lazy-connects the transport on first call.
 */
export type HostListeners<map extends Record<string, unknown>> = {
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
   * Subscribe to the session closing, cleanly or with a cause. Fires
   * exactly once per session.
   */
  onClose: (listener: core_Session.Listener<map['close']>) => AbortController
  /**
   * Observe raw uRPC envelopes (`rpc-requests` / `rpc-responses`)
   * crossing the wire in either direction — a read-only tap for
   * logging/tracing. Discriminate on `envelope.type`; handle inbound
   * requests via {@link Wata.Host.onRequest}.
   */
  onEnvelope: (listener: core_Session.Listener<map['envelope']>) => AbortController
  /**
   * Subscribe to transport errors (network, parse, AEAD).
   */
  onError: (listener: core_Session.Listener<map['error']>) => AbortController
  /**
   * Subscribe to inbound JSON-RPC notifications from the consumer.
   */
  onNotification: (listener: core_Session.Listener<map['notification']>) => AbortController
}

/** A started session or a still-pending `start()` promise. */
export type MaybePromise<value> = Promise<value> | value

/**
 * Live host session for one transport, returned by
 * {@link Wata.HostHandle.start}. Carries the request/notification dispatch
 * surface, response helpers, and the `onX` lifecycle subscribers — all
 * scoped to the single transport that produced it.
 */
type Core<
  schema extends Schema.Schema | undefined,
  transport extends Wata.HostTransport,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = HostListeners<Omit<HostEventMap<schema, readonly [transport], context>, 'request'>> & {
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Send a typed JSON-RPC notification from the host to the consumer.
   */
  notify: <const method extends Wata.Host.MethodName<schema>>(
    options: Wata.Host.NotifyOptions<schema, method>,
  ) => Promise<void>
  /** Remove a previously subscribed request listener. */
  offRequest: HostOffRequest<schema, readonly [transport], context>
  /**
   * Subscribe to inbound JSON-RPC requests. Returns an `AbortController`
   * so the subscription can be cancelled (or composed with an external
   * signal).
   *
   * Pass a method name first (`onRequest('ping', listener)`) to scope to
   * one method — that listener answers by *returning* a result. A broad
   * `onRequest(listener)` sees every method; respond via `event.respond`
   * (return values are ignored).
   */
  onRequest: HostOnRequest<schema, readonly [transport], context>
  /**
   * Settle a still-pending inbound request by id with a JSON-RPC error.
   * Mirror of {@link Session.respond}. Resolves once the error
   * response has flushed to the transport.
   *
   * @param id - Id of the pending request to settle.
   * @param error - JSON-RPC error envelope (`code` + `message`, optional `data`).
   */
  reject: (id: Rpc.Id, error: Wata.reject.Error) => Promise<void>
  /**
   * Settle a still-pending inbound request by id with a JSON-RPC `result`.
   * Resolves once the success response has flushed to the transport, so
   * popup hosts can `await` delivery before calling `window.close()`.
   *
   * Store `event.id` from a `'request'` listener for UI flows where the
   * response is gathered asynchronously (approval dialogs, late
   * confirmations, etc.). No need for per-request closures or to return a
   * Promise from the listener.
   *
   * Throws {@link Wata.UnknownRequestError} if no request with that id is
   * currently pending (already responded, never received, or the session
   * is closed).
   *
   * @param id - Id of the pending request to settle.
   * @param result - Success `result` payload to send.
   */
  respond: <result = unknown>(id: Rpc.Id, result: result) => Promise<void>
  /** Side of the protocol this wata speaks for. */
  role: 'host'
  /** Optional method-registry schema flowed through `'request'` / `'notification'` events. */
  schema: schema
  /** The wrapped transport. */
  transport: transport
}

/** Host session returned by {@link Wata.HostHandle.start}. */
export type Session<
  schema extends Schema.Schema | undefined,
  transport extends Wata.HostTransport,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = Core<schema, transport, context> &
  Omit<Transport.Extras<transport>, keyof Core<schema, transport, context>>

// The non-inferred positions below use `any` because {@link Session} is
// contravariant in `schema`/`context` (its `off*` listener params), so any
// concrete bound (`Schema.Schema | undefined`, `Rpc.RequestContext`) would
// fail the conditional match and collapse the inference to `never`.

/** Recover the shared schema from a tuple of composed member sessions. */
export type SchemaOf<sessions extends readonly unknown[]> =
  Awaited<sessions[number]> extends Session<infer schema, any, any> ? schema : never

/** Recover the shared request context from a tuple of member sessions. */
export type ContextOf<sessions extends readonly unknown[]> =
  Awaited<sessions[number]> extends Session<any, any, infer context> ? context : never

/** Recover the per-member transports as a tuple from member sessions. */
export type TransportsOf<sessions extends readonly unknown[]> = {
  [index in keyof sessions]: Awaited<sessions[index]> extends Session<any, infer transport, any>
    ? transport
    : never
}

/**
 * Live handle over several {@link Session}s. Exposes the
 * fan-out subscribe surface — `onRequest` (broad + method-scoped),
 * `onNotification`, `onError`, `onEnvelope`, and lifecycle `onClose` —
 * plus `close` and the underlying `sessions` array. Answering stays on
 * the request event (`event.respond`); cross-transport `respond(id)` /
 * `notify` are intentionally omitted (use `session.sessions[n]` for
 * per-transport sends).
 */
export type Composed<
  schema extends Schema.Schema | undefined,
  transports extends Wata.HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = HostListeners<Omit<HostEventMap<schema, transports, context>, 'request'>> & {
  /** Close every composed session. Idempotent; emits `'close'` once all closed. */
  close: (cause?: Error) => Promise<void>
  /** Remove a request listener from every composed session. */
  offRequest: HostOffRequest<schema, transports, context>
  /**
   * Subscribe to inbound requests across every composed session. The
   * event's `transport` is the union of the composed transports; answer
   * via `event.respond` (which routes back through the right transport).
   */
  onRequest: HostOnRequest<schema, transports, context>
  /** Side of the protocol this session speaks for. */
  role: 'host'
  /** Schema shared by the composed sessions. */
  schema: schema
  /** The composed member sessions, in input order. */
  sessions: { [index in keyof transports]: Session<schema, transports[index], context> }
}

/**
 * Compose several host sessions into one handle.
 *
 * Accepts started sessions or pending `start()` promises (awaited in
 * parallel) that share a schema. Subscriptions registered on the result
 * fan out to every member; `close()` tears them all down.
 *
 * @param sessions - Member sessions (or their `start()` promises).
 * @returns A {@link Composed} session spanning all members.
 */
export async function compose<
  const sessions extends readonly [
    // `any` at the schema/context positions is a generic *bound* only — it
    // accepts members with any concrete schema/context (which are otherwise
    // contravariant in the session's `off*` listener params). The real types
    // flow back to callers through the extractors (`SchemaOf` etc.) below.
    MaybePromise<Session<any, Wata.HostTransport, any>>,
    ...MaybePromise<Session<any, Wata.HostTransport, any>>[],
  ],
>(
  sessions: sessions,
): Promise<Composed<SchemaOf<sessions>, TransportsOf<sessions>, ContextOf<sessions>>> {
  const resolved = await Promise.all(sessions)
  const [first] = resolved
  if (!first) throw new Error('Session.compose requires at least one session')

  // Aggregate close: the composed `close` fires once, when every member
  // has closed. The first non-empty cause wins.
  const lifecycle = Events.create<{ close: Error | undefined }>()
  let open = resolved.length
  let cause_first: Error | undefined
  for (const session of resolved)
    session.onClose((cause) => {
      if (cause && !cause_first) cause_first = cause
      open -= 1
      if (open === 0) lifecycle.emit('close', cause_first)
    })
  const close = Events.subscribers(lifecycle, ['close'])

  // Per-source events + request dispatch fan out directly: register the
  // listener on every member, returning one `AbortController` that
  // cancels all of them.
  const fanOn =
    (method: 'onEnvelope' | 'onError' | 'onNotification' | 'onRequest') =>
    (...args: readonly never[]): AbortController => {
      const controllers = resolved.map((session) =>
        (session[method] as (...a: readonly never[]) => AbortController)(...args),
      )
      const controller = new AbortController()
      controller.signal.addEventListener(
        'abort',
        () => {
          for (const child of controllers) child.abort()
        },
        { once: true },
      )
      return controller
    }
  const fanOff =
    (method: 'offEnvelope' | 'offError' | 'offNotification' | 'offRequest') =>
    (...args: readonly never[]): void => {
      for (const session of resolved) (session[method] as (...a: readonly never[]) => void)(...args)
    }

  return {
    async close(cause?: Error) {
      await Promise.all(resolved.map((session) => session.close(cause)))
    },
    offClose: close.offClose,
    offEnvelope: fanOff('offEnvelope'),
    offError: fanOff('offError'),
    offNotification: fanOff('offNotification'),
    offRequest: fanOff('offRequest'),
    onClose: close.onClose,
    onEnvelope: fanOn('onEnvelope'),
    onError: fanOn('onError'),
    onNotification: fanOn('onNotification'),
    onRequest: fanOn('onRequest'),
    role: 'host',
    schema: first.schema,
    sessions: resolved,
  } as unknown as Composed<SchemaOf<sessions>, TransportsOf<sessions>, ContextOf<sessions>>
}
