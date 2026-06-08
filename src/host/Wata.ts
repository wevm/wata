/**
 * `wata/host` `Wata` namespace: the host-side public surface.
 *
 * `Wata.create` here always returns a {@link Host}. To create a
 * consumer, import from `wata` instead. Shared types
 * (`SendResult`, `Listener`, `LifecycleEventMap`, `BootstrapRequiredError`)
 * live on the consumer-side `Wata` namespace at `wata`; reach
 * for them there when you need to type both sides in the same module.
 *
 * Host-only types ({@link RequestEvent}, {@link NotificationEvent},
 * {@link Host}, {@link HostEventMap}) live in this file so they don't
 * pollute the consumer namespace.
 */

import { Ed25519, type Hex } from 'ox'

import * as Crypto from '../core/Crypto.js'
import * as Discovery from '../core/Discovery.js'
import * as Errors from '../core/Errors.js'
import * as Http from '../core/Http.js'
import * as Rpc from '../core/Rpc.js'
import * as Runtime from '../core/Runtime.js'
import * as Schema from '../core/Schema.js'
import * as Transport from '../core/Transport.js'
import * as Wellknown from '../core/Wellknown.js'
import * as Wata from '../Wata.js'

/** Host transport accepted by {@link create}. */
export type HostTransport = Transport.Transport<'host', string, unknown, Transport.MessageMeta>

/** Metadata delivered to host request and notification listeners. */
export type HostEventMeta<transport extends HostTransport = HostTransport> =
  Transport.MessageMetaOf<transport> & {
    /** SDK-facing name of the transport that delivered this event. */
    transport: transport['name']
  }

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
  transport extends HostTransport = HostTransport,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /** Optional per-request context metadata attached by the consumer. */
  context?: context | undefined
  /** Id of the JSON-RPC request being answered. */
  id: Rpc.Id
  /** Transport metadata observed while receiving the request. */
  meta: HostEventMeta<transport>
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
  transport extends HostTransport = HostTransport,
> = {
  /** Transport metadata observed while receiving the notification. */
  meta: HostEventMeta<transport>
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
  transport extends HostTransport,
  context extends Rpc.RequestContext,
> = transport extends HostTransport
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
  transport extends HostTransport,
> = transport extends HostTransport
  ? name extends Schema.MethodName<schema>
    ? Schema.ParamsOf<schema, name> extends infer params
      ? params extends Rpc.Params
        ? NotificationEvent<name, params, transport>
        : never
      : never
    : never
  : never

type DistributeTransportNotification<transport extends HostTransport> =
  transport extends HostTransport ? NotificationEvent<string, Rpc.Params, transport> : never

type DistributeTransportRequest<
  transport extends HostTransport,
  context extends Rpc.RequestContext,
> = transport extends HostTransport
  ? RequestEvent<string, Rpc.Params, unknown, transport, context>
  : never

type HostRequestEventOf<
  schema extends Schema.Schema | undefined,
  method extends string,
  transport extends HostTransport,
  context extends Rpc.RequestContext,
> = transport extends HostTransport
  ? method extends Host.MethodName<schema>
    ? Host.ParamsOf<schema, method> extends infer params
      ? params extends Rpc.Params
        ? RequestEvent<method, params, Host.ResultOf<schema, method>, transport, context>
        : never
      : never
    : never
  : never

type HostRequestListener<
  schema extends Schema.Schema | undefined,
  method extends string,
  transport extends HostTransport,
  context extends Rpc.RequestContext,
> = (
  event: HostRequestEventOf<schema, method, transport, context>,
) => Host.ResultOf<schema, method> | Promise<Host.ResultOf<schema, method> | void> | void

export type HostRequestDispatchListener<
  schema extends Schema.Schema | undefined,
  transports extends HostTransports,
  context extends Rpc.RequestContext,
> = (event: SchemaRequestEvent<schema, transports, context>) => Promise<void> | void

/**
 * Helper conditional that maps a {@link Schema} method name to the typed
 * `RequestEvent` payload host listeners receive.
 */
export type SchemaRequestEvent<
  schema extends Schema.Schema | undefined,
  transports extends HostTransports = HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = schema extends Schema.Schema
  ? DistributeRequest<schema, Schema.MethodName<schema>, transports[number], context>
  : DistributeTransportRequest<transports[number], context>

/** Helper conditional mapping a schema to the typed `NotificationEvent`. */
export type SchemaNotificationEvent<
  schema extends Schema.Schema | undefined,
  transports extends HostTransports = HostTransports,
> = schema extends Schema.Schema
  ? DistributeNotification<schema, Schema.MethodName<schema>, transports[number]>
  : DistributeTransportNotification<transports[number]>

/** Host-side event map (lifecycle + request/notification dispatch). */
export type HostEventMap<
  schema extends Schema.Schema | undefined,
  transports extends HostTransports = HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = Wata.LifecycleEventMap<schema, context> & {
  /** Inbound JSON-RPC notification. Fire-and-forget. */
  notification: SchemaNotificationEvent<schema, transports>
  /**
   * Inbound JSON-RPC request. Broad listeners should respond via
   * `event.respond`; only method-scoped request listeners may answer by
   * returning a non-`undefined` result.
   */
  request: SchemaRequestEvent<schema, transports, context>
}

type HostOff<
  schema extends Schema.Schema | undefined,
  transports extends HostTransports,
  context extends Rpc.RequestContext,
> = {
  /** Remove a method-scoped request listener. */
  <const method extends Host.MethodName<schema>>(
    type: 'request',
    method: method,
    listener: HostRequestListener<schema, method, transports[number], context>,
  ): void
  /** Remove a broad request listener. */
  (type: 'request', listener: HostRequestDispatchListener<schema, transports, context>): void
  /** Remove a previously subscribed host listener. */
  <type extends Exclude<keyof HostEventMap<schema, transports, context>, 'request'>>(
    type: type,
    listener: Wata.Listener<HostEventMap<schema, transports, context>[type]>,
  ): void
}

type HostOn<
  schema extends Schema.Schema | undefined,
  transports extends HostTransports,
  context extends Rpc.RequestContext,
> = {
  /**
   * Subscribe to requests for one JSON-RPC method. A non-`undefined` listener
   * return value answers the request.
   */
  <const method extends Host.MethodName<schema>>(
    type: 'request',
    method: method,
    listener: HostRequestListener<schema, method, transports[number], context>,
  ): AbortController
  /**
   * Subscribe to broad host request dispatch. Respond via `event.respond`;
   * listener return values are ignored.
   */
  (
    type: 'request',
    listener: HostRequestDispatchListener<schema, transports, context>,
  ): AbortController
  /** Subscribe to a host event. */
  <type extends Exclude<keyof HostEventMap<schema, transports, context>, 'request'>>(
    type: type,
    listener: Wata.Listener<HostEventMap<schema, transports, context>[type]>,
  ): AbortController
}

/** Non-empty tuple of host transports accepted by {@link create}. */
export type HostTransports = readonly [HostTransport, ...HostTransport[]]

/** Host-side `Wata`. Returned by {@link create}. */
export type Host<
  schema extends Schema.Schema | undefined = undefined,
  transports extends HostTransports = HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Web-standard fetch handler forwarded from the transport when
   * present. HTTP-shaped transports (`deviceCode`, `webhookCallback`,
   * …) expose the standard {@link Http.Server} signature that drops
   * onto Cloudflare Workers, Bun, Deno, Vercel Edge, Hono, etc. Node
   * `http.RequestListener` adapters live behind `wata/server`
   * `Handler` helpers.
   */
  fetch: Http.HandlersForTransports<transports>['fetch']
  /**
   * Send a typed JSON-RPC notification from the host to the consumer.
   * Auto-starts transports that support host-origin notifications.
   */
  notify: <const method extends Host.MethodName<schema>>(
    options: Host.NotifyOptions<schema, method>,
  ) => Promise<void>
  /** Remove a previously subscribed listener. */
  off: HostOff<schema, transports, context>
  /**
   * Subscribe to a host event. Returns an `AbortController` so the
   * subscription can be cancelled (or composed with an external signal).
   *
   * Lazy-connects the transport on first call, so most hosts never need
   * to call {@link Host.start} explicitly.
   */
  on: HostOn<schema, transports, context>
  /**
   * Settle a still-pending inbound request by id with a JSON-RPC error.
   * Mirror of {@link Host.respond}. Resolves once the error response
   * has flushed to the transport.
   *
   * @param id - Id of the pending request to settle.
   * @param error - JSON-RPC error envelope (`code` + `message`, optional `data`).
   */
  reject: (id: Rpc.Id, error: reject.Error) => Promise<void>
  /**
   * Settle a still-pending inbound request by id with a JSON-RPC `result`.
   * Resolves once the success response has flushed to the transport, so
   * popup hosts can `await` delivery before calling `window.close()`.
   *
   * Store `event.id` from a `'request'` listener for UI flows where
   * the response is gathered asynchronously (approval dialogs, late
   * confirmations, etc.). No need for per-request closures or to
   * return a Promise from the listener.
   *
   * Throws {@link UnknownRequestError} if no request with that id is
   * currently pending (already responded, never received, or the
   * wata is closed).
   *
   * Throws {@link AmbiguousRequestError} if more than one transport has
   * the same pending id. In multi-transport hosts, prefer
   * `event.respond(...)` / `event.reject(...)` inside the request event
   * when duplicate ids are possible.
   *
   * @param id - Id of the pending request to settle.
   * @param result - Success `result` payload to send.
   */
  respond: <result = unknown>(id: Rpc.Id, result: result) => Promise<void>
  /** Side of the protocol this wata speaks for. */
  role: 'host'
  /** Optional method-registry schema flowed through `'request'` / `'notification'` events. */
  schema: schema
  /**
   * Explicitly bring the session up. Starts the transport and resolves
   * once it is ready to send and receive frames. Emits `'open'` on success.
   *
   * Optional: {@link Host.on}, {@link Host.notify}, {@link Host.respond},
   * and {@link Host.reject} trigger `start` internally on first use,
   * so most hosts can skip it.
   * Reach for it when a UI wants to surface the connecting state before
   * any request lands, or when start-time errors should reject up-front.
   */
  start: () => Promise<void>
  /** Configured transports, in user-supplied order. */
  transports: transports
}

/** Helper types for the host-side {@link Host} API. */
export declare namespace Host {
  /** Method names known to a host (any string when no schema supplied). */
  type MethodName<schema extends Schema.Schema | undefined> = schema extends Schema.Schema
    ? Schema.MethodName<schema>
    : string

  /** Options for {@link Host.notify}. */
  type NotifyOptions<schema extends Schema.Schema | undefined, method extends string> = {
    /** Method name. Narrowed against the schema when one was supplied. */
    method: method
    /** Method params. Narrowed against the schema when one was supplied. */
    params: ParamsOf<schema, method>
  }

  /** Params type for a given method (any when no schema supplied). */
  type ParamsOf<
    schema extends Schema.Schema | undefined,
    method extends string,
  > = schema extends Schema.Schema
    ? method extends Schema.MethodName<schema>
      ? Rpc.Params & Schema.ParamsOf<schema, method>
      : Rpc.Params
    : Rpc.Params

  /** Result type for a given method (unknown when no schema supplied). */
  type ResultOf<
    schema extends Schema.Schema | undefined,
    method extends string,
  > = schema extends Schema.Schema
    ? method extends Schema.MethodName<schema>
      ? Schema.ResultOf<schema, method>
      : unknown
    : unknown
}

export declare namespace reject {
  /** Error payload accepted by {@link Host.reject} / `event.reject`. */
  type Error = {
    /** JSON-RPC error code. */
    code: number
    /** Optional JSON-RPC error `data` payload. */
    data?: unknown | undefined
    /** JSON-RPC error message. */
    message: string
  }
}

/**
 * Create a host-side {@link Host} `Wata` around one or more transports.
 *
 * @example
 * Synchronous answer from inside the listener.
 * ```ts
 * import { Wata, postMessage } from 'wata/host'
 *
 * const wata = Wata.create({
 *   transports: [postMessage()],
 * })
 *
 * wata.on('request', async (event) => {
 *   if (event.method === 'ping') await event.respond({ ok: true })
 * })
 * ```
 *
 * @example
 * Late answer by id (UI / approval flows). `wata.on` lazy-connects
 * the transport on first call, so an explicit `start()` is optional.
 * ```ts
 * import { Wata, postMessage } from 'wata/host'
 *
 * const wata = Wata.create({
 *   transports: [postMessage()],
 * })
 *
 * let id: string | number | undefined
 *
 * wata.on('request', (event) => {
 *   id = event.id
 * })
 *
 * // Later, when the user clicks "approve":
 * if (id !== undefined) await wata.respond(id, { ok: true })
 * ```
 */
export function create<
  const schema extends Schema.Schema | undefined = undefined,
  const transports extends HostTransports = HostTransports,
  const context extends Schema.Context | undefined = undefined,
>(
  options: create.Options<schema, transports, context>,
): Host<schema, transports, Wata.RequestContextOf<context>> {
  const transports = options.transports as transports
  const schema = options.schema as schema
  const context = options.context as context
  const { baseUrl, meta, privateKey } = options
  const identity = privateKey ? identityFromPrivateKey(privateKey) : undefined

  if (meta && !baseUrl)
    throw new Errors.BaseError('`baseUrl` is required when `meta` is set', {
      details: 'host_id and transport bindings need a fully-qualified origin',
    })
  if (meta && !privateKey)
    throw new Errors.BaseError('`privateKey` is required when `meta` is set', {
      details:
        'host.json publishes the long-term Ed25519 identity pubkey derived from the private seed',
    })
  assertUniqueTransportNames(transports)

  // Lazy-inject parent app context into the transports so HTTP-server-
  // shaped adapters can populate verification URIs and sign responses
  // from one app-wide config.
  for (const transport of transports) transport.bind?.({ baseUrl, identity, meta })

  const routed = Http.composeRouted(transports.filter(isHttpServer))
  let httpFetch = routed?.fetch
  if (meta && baseUrl && identity) {
    const document = Wellknown.buildHostDocument({
      baseUrl,
      meta,
      publicKey: identity.publicKey,
      transports: collectTransports(transports, baseUrl),
    })
    const wrapped = Wellknown.wrapFetch({
      base: routed ? { fetch: routed.fetch } : undefined,
      document,
      wellknownPath: Wellknown.hostPath,
    })
    httpFetch = wrapped.fetch
  }

  const runtime = Runtime.create({ context, schema, transports })
  return {
    ...runtime,
    fetch: httpFetch as Host<schema, transports, Wata.RequestContextOf<context>>['fetch'],
  } as Host<schema, transports, Wata.RequestContextOf<context>>
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<
    schema extends Schema.Schema | undefined,
    transports extends HostTransports = HostTransports,
    context extends Schema.Context | undefined = undefined,
  > = {
    /**
     * Public origin of the host (e.g. `https://wallet.example`).
     * Lifted to the `Wata.create` root because it's an app-wide
     * concept. Every transport on this `Wata` shares the same origin.
     * Lazy-injected into transports that need it via
     * {@link Transport.Transport.bind}.
     *
     * REQUIRED when {@link meta} is supplied (we need it to build
     * `host_id` and the transport bindings in the published
     * `host.json`). Optional otherwise.
     */
    baseUrl?: string | undefined
    /**
     * Optional Wata-wide schema for per-request context metadata.
     * When set, host `'request'` events expose `event.context`
     * with this single app-level bag shape.
     */
    context?: context | undefined
    /**
     * Optional human-facing app metadata. When set together with
     * {@link baseUrl} and {@link privateKey}, `Wata` auto-publishes
     * a `/.well-known/urpc/host.json` off the transport's existing
     * `.fetch`. No separate mount required. The
     * published doc's `transports` map is auto-built from the
     * transport's {@link Transport.Transport.discovery} binding.
     * Lazy-injected into transports that opt into
     * {@link Transport.Transport.bind}.
     */
    meta?: Discovery.Meta | undefined
    /**
     * Host's long-term Ed25519 identity private seed. `Wata` derives
     * the unpadded base64url public key required by host discovery and
     * lazy-injects both values into transports that sign as the host.
     */
    privateKey?: Hex.Hex | undefined
    /** Optional method-registry schema (typed `'request'` / `'notification'` payloads). */
    schema?: schema | undefined
    /** Host-role transports this wata wraps. */
    transports: transports
  }
}

function identityFromPrivateKey(privateKey: Hex.Hex): Transport.Identity {
  const publicKey = Crypto.encodePublicKey(Ed25519.getPublicKey({ privateKey }))
  return { privateKey, publicKey }
}

function assertUniqueTransportNames(transports: readonly HostTransport[]): void {
  const seen = new Set<string>()
  for (const transport of transports) {
    if (seen.has(transport.name))
      throw new Errors.BaseError(`duplicate transport name \`${transport.name}\``)
    seen.add(transport.name)
  }
}

/**
 * Collect the per-transport `transports` map entries the wrapping
 * `Wata.create({ baseUrl, meta })` publishes in `host.json`. Walks
 * the configured transports and asks each one to contribute its
 * discovery binding for `baseUrl`.
 *
 * @internal
 */
export function collectTransports(
  transports: readonly HostTransport[],
  baseUrl: string,
): Record<string, unknown> {
  const documentTransports: Record<string, unknown> = {}
  for (const transport of transports) {
    const discovery = transport.discovery
    if (!discovery) continue
    if (documentTransports[discovery.id])
      throw new Errors.BaseError(`duplicate discovery transport \`${discovery.id}\``)
    documentTransports[discovery.id] = discovery.binding(baseUrl)
  }
  return documentTransports
}

function isHttpServer<transport extends HostTransport>(
  transport: transport,
): transport is transport & Http.RoutedServer {
  const candidate = transport as Partial<Http.RoutedServer>
  return typeof candidate.fetch === 'function'
}

/**
 * Thrown by {@link Host.respond} / {@link Host.reject} when more than one
 * transport has a pending request with the supplied id. Use the request
 * event's `respond` / `reject` helpers to target the delivering transport.
 */
export const AmbiguousRequestError = Runtime.AmbiguousRequestError
export type AmbiguousRequestError = Runtime.AmbiguousRequestError

/**
 * Thrown by {@link Host.respond} / {@link Host.reject} when no inbound
 * request with the supplied id is currently pending. Means the request
 * was already settled, never received, or the wata has closed.
 */
export const UnknownRequestError = Runtime.UnknownRequestError
export type UnknownRequestError = Runtime.UnknownRequestError
