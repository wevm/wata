/**
 * `wata` `Wata` namespace: the consumer-side public surface
 * plus the shared types both sides re-export.
 *
 * `Wata.create` here always returns a {@link Consumer}. To create a
 * host, import from `wata/host` (where `Wata.create` returns a
 * {@link Host}). Splitting per-side keeps the return type a literal
 * narrowing rather than a `transport['role'] extends 'consumer' ?
 * Consumer : Host` conditional, which gives editors and type-error
 * messages the right shape immediately.
 *
 * Shared types (lifecycle event map, listener signature, send result) live
 * in this file and are re-exported verbatim from
 * {@link "./host/Wata"} so user code can reach them from either side.
 *
 * Consumers can opt into typed JSON-RPC methods through `schema`, app
 * metadata/discovery through `baseUrl` + `meta`, and transport-specific
 * HTTP handlers through the wrapped transport.
 */

import { Ed25519, type Hex } from 'ox'

import * as Crypto from './core/Crypto.js'
import * as Discovery from './core/Discovery.js'
import * as Errors from './core/Errors.js'
import * as Events from './core/Events.js'
import * as Http from './core/Http.js'
import * as Rpc from './core/Rpc.js'
import * as Runtime from './core/Runtime.js'
import * as Schema from './core/Schema.js'
import * as Transport from './core/Transport.js'
import * as Wellknown from './core/Wellknown.js'

/**
 * Result of a single {@link Consumer.send} call. We return `{ id, result }`
 * (rather than the bare `result`) so callers can correlate with logs and
 * batch/trace tooling without losing the JSON-RPC identity.
 */
export type SendResult<result> = {
  /** Id of the JSON-RPC request that produced this response. */
  id: Rpc.Id
  /** Decoded `result` payload from the host's success response. */
  result: result
}

/** Listener supplied to `Wata.on`. */
export type Listener<payload> = Events.Listener<payload>

/** Raw RPC envelope types surfaced through lifecycle events. */
export type RpcEnvelopeType = 'rpc-requests' | 'rpc-responses'

/** Metadata passed as the second argument to raw RPC envelope listeners. */
export type RpcEnvelopeMeta<type extends RpcEnvelopeType = RpcEnvelopeType> = {
  /** Direction relative to the local `Wata` instance. */
  direction: 'incoming' | 'outgoing'
  /** SDK-facing transport name that carried this envelope. */
  transport: string
  /** Raw uRPC envelope type. */
  type: type
}

type RpcRequestMessageOf<
  schema extends Schema.Schema | undefined,
  context extends Rpc.RequestContext,
> = schema extends Schema.Schema
  ? {
      [method in Schema.MethodName<schema>]:
        | Rpc.Notification<method, Rpc.Params & Schema.ParamsOf<schema, method>>
        | Rpc.Request<method, Rpc.Params & Schema.ParamsOf<schema, method>, context>
    }[Schema.MethodName<schema>]
  : Rpc.Request<string, Rpc.Params, context> | Rpc.Notification

type RpcResponseMessageOf<schema extends Schema.Schema | undefined> = Rpc.Response<
  RpcResponseResultOf<schema>
>

type RpcResponseResultOf<schema extends Schema.Schema | undefined> = schema extends Schema.Schema
  ? {
      [method in Schema.MethodName<schema>]: Schema.ResultOf<schema, method>
    }[Schema.MethodName<schema>]
  : unknown

/** Payload passed to `'rpc-requests'` listeners. */
export type RpcRequestsPayload<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = readonly RpcRequestMessageOf<schema, context>[]

/** Payload passed to `'rpc-responses'` listeners. */
export type RpcResponsesPayload<schema extends Schema.Schema | undefined = undefined> =
  readonly RpcResponseMessageOf<schema>[]

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

/** Lifecycle events emitted on every `Wata` (consumer + host). */
export type LifecycleEventMap<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /** Emitted exactly once when the session closes, cleanly or with cause. */
  close: Error | undefined
  /** Emitted when the transport surfaces an error (network, parse, AEAD). */
  error: Error
  /** Emitted after `start()` completes (both consumer and host). */
  open: void
  /** Observed `rpc-requests` envelope. */
  'rpc-requests': [
    /** JSON-RPC request/notification payloads carried by the envelope. */
    requests: RpcRequestsPayload<schema, context>,
    /** Direction and transport metadata for the envelope. */
    meta: RpcEnvelopeMeta<'rpc-requests'>,
  ]
  /** Observed `rpc-responses` envelope. */
  'rpc-responses': [
    /** JSON-RPC response payloads carried by the envelope. */
    responses: RpcResponsesPayload<schema>,
    /** Direction and transport metadata for the envelope. */
    meta: RpcEnvelopeMeta<'rpc-responses'>,
  ]
}

/** Consumer-side event map. */
export type ConsumerEventMap<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = LifecycleEventMap<schema, context> & {
  /** Inbound JSON-RPC notification from the host. */
  notification: SchemaNotificationEvent<schema>
}

/** Non-empty tuple of consumer transports accepted by {@link create}. */
export type ConsumerTransports = readonly [
  Transport.Transport<'consumer', string, unknown>,
  ...Transport.Transport<'consumer', string, unknown>[],
]

/** Default single-transport tuple used by the broad {@link Consumer} type. */
export type SingleConsumerTransports = readonly [Transport.Transport<'consumer', string>]

/** Transport-specific consumer session exposed on `wata.<transportName>`. */
export type ConsumerSession<
  schema extends Schema.Schema | undefined,
  transport extends Transport.Transport<'consumer', string, unknown>,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Send a typed JSON-RPC notification (no response expected).
   * Auto-starts this transport on first use.
   */
  notify: <const method extends Consumer.MethodName<schema>>(
    options: Consumer.NotifyOptions<schema, method>,
  ) => Promise<void>
  /** Remove a previously subscribed listener. */
  off: <type extends keyof ConsumerEventMap<schema, context>>(
    type: type,
    listener: Listener<ConsumerEventMap<schema, context>[type]>,
  ) => void
  /**
   * Subscribe to a consumer event. Returns an `AbortController` so the
   * subscription can be cancelled (or composed with an external signal).
   */
  on: <type extends keyof ConsumerEventMap<schema, context>>(
    type: type,
    listener: Listener<ConsumerEventMap<schema, context>[type]>,
  ) => AbortController
  /** Side of the protocol this wata speaks for. */
  role: 'consumer'
  /** Optional method-registry schema flowed through `send` / `notify`. */
  schema: schema
  /**
   * Send a typed JSON-RPC request over this transport. Auto-starts on
   * first use. Ongoing transports resolve with the host's `result`.
   * Out-of-band transports may resolve with registration metadata and emit
   * the eventual host result through `'rpc-responses'`.
   */
  send: <const method extends Consumer.MethodName<schema>>(
    options: Consumer.SendOptions<schema, method, context>,
  ) => Promise<Consumer.SendReturn<schema, transport, method>>
  /**
   * Explicitly bring the session up. Starts the transport and resolves
   * once it is ready to send and receive frames. Emits `'open'` on success.
   *
   * Optional: {@link Consumer.send} and {@link Consumer.notify} call
   * `start` internally on first use, so most callers can skip it.
   * Reach for it when the open wata should overlap other work, or
   * when a UI wants to surface the connecting state before any traffic.
   */
  start: () => Promise<void>
  /** The wrapped transport. */
  transport: transport
}

/** Consumer surface shared by single and multi-transport instances. */
export type ConsumerBase<
  schema extends Schema.Schema | undefined,
  transports extends ConsumerTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /** Close all configured transports. Idempotent. */
  close: (cause?: Error) => Promise<void>
  /**
   * Composite web-standard fetch handler. Present when any configured
   * transport exposes HTTP routes or when discovery is auto-published.
   */
  fetch: Http.HandlersForTransports<transports>['fetch']
  /** Remove a previously subscribed consumer listener. */
  off: <type extends keyof ConsumerEventMap<schema, context>>(
    type: type,
    listener: Listener<ConsumerEventMap<schema, context>[type]>,
  ) => void
  /** Subscribe to aggregate consumer events. */
  on: <type extends keyof ConsumerEventMap<schema, context>>(
    type: type,
    listener: Listener<ConsumerEventMap<schema, context>[type]>,
  ) => AbortController
  /** Side of the protocol this wata speaks for. */
  role: 'consumer'
  /** Optional method-registry schema. */
  schema: schema
  /** Configured transports, in user-supplied order. */
  transports: transports
}

/** Child sessions keyed by each transport's SDK-facing name. */
export type ConsumerChildMap<
  schema extends Schema.Schema | undefined,
  transports extends ConsumerTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  [name in transports[number]['name']]: ConsumerSession<
    schema,
    Extract<transports[number], { name: name }>,
    context
  >
}

/**
 * Consumer-side `Wata`. Returned by {@link create}. A single transport
 * exposes `send` / `notify` at the top level; multiple transports expose
 * named child sessions such as `wata.webhookCallback.send`.
 */
export type Consumer<
  schema extends Schema.Schema | undefined = undefined,
  transports extends ConsumerTransports = SingleConsumerTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = ConsumerBase<schema, transports, context> &
  (transports extends readonly [
    infer transport extends Transport.Transport<'consumer', string, unknown>,
  ]
    ? ConsumerSession<schema, transport, context>
    : ConsumerChildMap<schema, transports, context>)

/** Request context value inferred from an optional Wata-wide context schema. */
export type RequestContextOf<context extends Schema.Context | undefined> =
  context extends Schema.Context ? Schema.ContextOf<context> : Rpc.RequestContext

export declare namespace Consumer {
  /** Method names known to a consumer (any string when no schema supplied). */
  type MethodName<schema extends Schema.Schema | undefined> = schema extends Schema.Schema
    ? Schema.MethodName<schema>
    : string

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

  /** Return type of `send`, preserving transport-specific registration metadata. */
  type SendReturn<
    schema extends Schema.Schema | undefined,
    transport extends Transport.Transport<'consumer', string, unknown>,
    method extends string,
  > =
    transport extends Transport.Transport<'consumer', string, infer value>
      ? [value] extends [void]
        ? SendResult<ResultOf<schema, method>>
        : value
      : never

  /** Options for {@link Consumer.send}. */
  type SendOptions<
    schema extends Schema.Schema | undefined,
    method extends string,
    context extends Rpc.RequestContext = Rpc.RequestContext,
  > = {
    /** Optional per-request context metadata. */
    context?: context | undefined
    /** Optional explicit request id. Defaults to a monotonically-increasing number. */
    id?: Rpc.Id | undefined
    /** Method name. Narrowed against the schema when one was supplied. */
    method: method
    /** Method params. Narrowed against the schema when one was supplied. */
    params: ParamsOf<schema, method>
  }

  /** Options for {@link Consumer.notify}. */
  type NotifyOptions<schema extends Schema.Schema | undefined, method extends string> = {
    /** Method name. Narrowed against the schema when one was supplied. */
    method: method
    /** Method params. Narrowed against the schema when one was supplied. */
    params: ParamsOf<schema, method>
  }
}

/**
 * Create a consumer-side {@link Consumer} `Wata` around one or more transports.
 *
 * @example
 * ```ts
 * import { Wata, loopback } from 'wata'
 * import { Wata as HostWata } from 'wata/host'
 *
 * const { consumer, host } = loopback()
 *
 * const hostWata = HostWata.create({ transports: [host] })
 * hostWata.on('request', async (event) => {
 *   if (event.method === 'ping') await event.respond({ ok: true })
 * })
 *
 * const wata = Wata.create({ transports: [consumer] })
 * const { result } = await wata.send({ method: 'ping', params: [] })
 * ```
 */
export function create<
  const schema extends Schema.Schema | undefined = undefined,
  const transports extends ConsumerTransports = SingleConsumerTransports,
  const context extends Schema.Context | undefined = undefined,
>(
  options: create.Options<schema, transports, context>,
): Consumer<schema, transports, RequestContextOf<context>> {
  const transports = options.transports as transports
  const schema = options.schema as schema
  const context = options.context as context
  const { baseUrl, meta, privateKey } = options
  const identity = privateKey ? identityFromPrivateKey(privateKey) : undefined

  if (meta && !baseUrl)
    throw new Errors.BaseError('`baseUrl` is required when `meta` is set', {
      details: 'consumer_id needs a fully-qualified origin',
    })
  assertUniqueTransportNames(transports)

  // Lazy-inject parent app context into every transport so adapters can
  // derive discovery URLs, signing keys, and peer-facing metadata from
  // one app-level `Wata.create` call.
  for (const transport of transports) transport.bind?.({ baseUrl, identity, meta })

  const routed = Http.composeRouted(transports.filter(isHttpServer))
  let httpFetch = routed?.fetch
  if (meta && baseUrl) {
    const publicKey = identity?.publicKey ?? collectPublicKey(transports)
    const callbackUrls = collectCallbackUrls(transports)
    const document = Wellknown.buildConsumerDocument({
      baseUrl,
      meta,
      ...(callbackUrls.length > 0 ? { callbackUrls } : {}),
      ...(publicKey ? { publicKey } : {}),
    })
    const wrapped = Wellknown.wrapFetch({
      base: routed ? { fetch: routed.fetch } : undefined,
      document,
      wellknownPath: Wellknown.consumerPath,
    })
    httpFetch = wrapped.fetch
  }

  const runtime = Runtime.create({ context, schema, transports })
  return {
    ...runtime,
    fetch: httpFetch as Consumer<schema, transports, RequestContextOf<context>>['fetch'],
  } as unknown as Consumer<schema, transports, RequestContextOf<context>>
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<
    schema extends Schema.Schema | undefined,
    transports extends ConsumerTransports = SingleConsumerTransports,
    context extends Schema.Context | undefined = undefined,
  > = {
    /**
     * Public origin of the consumer app (e.g. `https://acme.dev`).
     * Lifted to the `Wata.create` root because it's an app-wide
     * concept. Lazy-injected into transports that need it via
     * {@link Transport.Transport.bind}. For example, consumer
     * `deviceCode` derives `consumer_url =
     * ${baseUrl}/.well-known/urpc/consumer.json` from it.
     *
     * REQUIRED when {@link meta} is supplied.
     */
    baseUrl?: string | undefined
    /**
     * Optional Wata-wide schema for per-request context metadata.
     * When set, `send({ context })` is typed and validated against
     * this single app-level bag shape rather than per-method entries.
     */
    context?: context | undefined
    /**
     * Optional human-facing app metadata. When set together with
     * {@link baseUrl}, `Wata` auto-publishes a
     * `/.well-known/urpc/consumer.json` off the transport's
     * `.fetch` (or as a standalone surface if the
     * transport doesn't expose its own HTTP handlers).
     * Lazy-injected into transports via
     * {@link Transport.Transport.bind}.
     */
    meta?: Discovery.Meta | undefined
    /**
     * Consumer's long-term Ed25519 identity private seed. `Wata`
     * derives the unpadded base64url public key for discovery and
     * lazy-injects both values into transports that need identity
     * signing.
     */
    privateKey?: Hex.Hex | undefined
    /** Optional method-registry schema (typed `send` / `notify` payloads). */
    schema?: schema | undefined
    /** Consumer-role transports this wata wraps. */
    transports: transports
  }
}

function assertUniqueTransportNames(
  transports: readonly Transport.Transport<Transport.Role, string, unknown>[],
): void {
  const seen = new Set<string>()
  for (const transport of transports) {
    if (seen.has(transport.name))
      throw new Errors.BaseError(`duplicate transport name \`${transport.name}\``)
    seen.add(transport.name)
  }
}

function collectCallbackUrls(
  transports: readonly Transport.Transport<Transport.Role, string, unknown>[],
): readonly string[] {
  const urls = new Set<string>()
  for (const transport of transports) for (const url of transport.callbackUrls ?? []) urls.add(url)
  return Array.from(urls)
}

function collectPublicKey(
  transports: readonly Transport.Transport<Transport.Role, string, unknown>[],
): string | undefined {
  let publicKey: string | undefined
  for (const transport of transports) {
    if (!transport.publicKey) continue
    if (publicKey && publicKey !== transport.publicKey)
      throw new Errors.BaseError('configured transports expose conflicting public keys')
    publicKey = transport.publicKey
  }
  return publicKey
}

function isHttpServer<transport extends Transport.Transport<Transport.Role, string, unknown>>(
  transport: transport,
): transport is transport & Http.RoutedServer {
  const candidate = transport as Partial<Http.RoutedServer>
  return typeof candidate.fetch === 'function'
}

function identityFromPrivateKey(privateKey: Hex.Hex): Transport.Identity {
  const publicKey = Crypto.encodePublicKey(Ed25519.getPublicKey({ privateKey }))
  return { privateKey, publicKey }
}
