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

import * as Discovery from './core/Discovery.js'
import * as Envelope from './core/Envelope.js'
import * as Errors from './core/Errors.js'
import * as Events from './core/Events.js'
import * as Http from './core/Http.js'
import * as Rpc from './core/Rpc.js'
import * as Schema from './core/Schema.js'
import * as SchemaRuntime from './core/SchemaRuntime.js'
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

/** Listener supplied to a consumer `onX` subscriber method. */
export type Listener<payload> = Events.Listener<payload>

/** Consumer event names, used to derive the `onX` / `offX` surface. */
const consumerEventNames = ['close', 'envelope', 'error', 'notification', 'open', 'prompt'] as const

/** Direction + transport metadata for an observed {@link ObservedEnvelope}. */
export type EnvelopeMeta = {
  /** Direction relative to the local `Wata` instance. */
  direction: 'incoming' | 'outgoing'
  /** SDK-facing transport name that carried this envelope. */
  transport: string
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

/** Decoded payload of an observed `rpc-requests` envelope. */
export type RpcRequestsPayload<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = readonly RpcRequestMessageOf<schema, context>[]

/** Decoded payload of an observed `rpc-responses` envelope. */
export type RpcResponsesPayload<schema extends Schema.Schema | undefined = undefined> =
  readonly RpcResponseMessageOf<schema>[]

/**
 * A uRPC envelope surfaced through the `'envelope'` observability tap:
 * either an `rpc-requests` or `rpc-responses` envelope, with its decoded
 * payload. Discriminate on `type` to narrow `payload`. Handshake /
 * transport frames (`hello`, `ready`, `encrypted`) are never surfaced.
 */
export type ObservedEnvelope<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> =
  | {
      /** JSON-RPC request / notification payloads carried by the envelope. */
      payload: RpcRequestsPayload<schema, context>
      /** Envelope type discriminator. */
      type: 'rpc-requests'
    }
  | {
      /** JSON-RPC response payloads carried by the envelope. */
      payload: RpcResponsesPayload<schema>
      /** Envelope type discriminator. */
      type: 'rpc-responses'
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

/** Lifecycle events emitted on every `Wata` (consumer + host). */
export type LifecycleEventMap<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /** Emitted exactly once when the session closes, cleanly or with cause. */
  close: Error | undefined
  /**
   * Observed uRPC envelope crossing the wire (read-only tap), in either
   * direction. Fires for `rpc-requests` and `rpc-responses` envelopes
   * only; discriminate on `envelope.type` to narrow the payload.
   */
  envelope: [
    /** The observed envelope with its decoded payload. */
    envelope: ObservedEnvelope<schema, context>,
    /** Direction and transport metadata for the envelope. */
    meta: EnvelopeMeta,
  ]
  /** Emitted when the transport surfaces an error (network, parse, AEAD). */
  error: Error
  /** Emitted after `start()` completes (both consumer and host). */
  open: void
}

/** Consumer-side event map. */
export type ConsumerEventMap<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
  prompt extends object = never,
> = LifecycleEventMap<schema, context> & {
  /** Inbound JSON-RPC notification from the host. */
  notification: SchemaNotificationEvent<schema>
  /**
   * User-facing pairing/verification prompt produced by an out-of-band
   * transport (e.g. `relay`, `deviceCode`) during startup. Discriminated
   * by {@link ConsumerPromptEvent transport}, so listeners narrow to the
   * exact payload of the transport that produced it.
   */
  prompt: prompt
}

/**
 * Consumer `'prompt'` payload derived from a transport: the transport's
 * own {@link "./core/Transport".PromptOf prompt} shape tagged with its
 * SDK-facing `transport` name. Transports that never pair out-of-band
 * contribute `never`, so they drop out of the union.
 */
export type ConsumerPromptEvent<transport extends { name: string }> = transport extends unknown
  ? [Transport.PromptOf<transport>] extends [never]
    ? never
    : Transport.PromptOf<transport> & {
        /** SDK-facing name of the transport that produced the prompt. */
        transport: transport['name']
      }
  : never

/**
 * Consumer `onX` / `offX` listener surface — one method per
 * {@link ConsumerEventMap} event. Shared by {@link ConsumerSession} and
 * {@link ConsumerBase}. Payloads are sourced from `map`, so the per-event
 * payload docs live on the event map; the docs here describe each
 * subscription. Every `onX` returns an `AbortController` so the
 * subscription can be cancelled (or composed with an external signal).
 */
export type ConsumerListeners<map extends Record<string, unknown>> = {
  /**
   * Remove a previously subscribed `'close'` listener (matched by
   * reference).
   */
  offClose: (listener: Listener<map['close']>) => void
  /**
   * Remove a previously subscribed `'envelope'` listener (matched by
   * reference).
   */
  offEnvelope: (listener: Listener<map['envelope']>) => void
  /**
   * Remove a previously subscribed `'error'` listener (matched by
   * reference).
   */
  offError: (listener: Listener<map['error']>) => void
  /**
   * Remove a previously subscribed `'notification'` listener (matched by
   * reference).
   */
  offNotification: (listener: Listener<map['notification']>) => void
  /**
   * Remove a previously subscribed `'open'` listener (matched by
   * reference).
   */
  offOpen: (listener: Listener<map['open']>) => void
  /**
   * Remove a previously subscribed `'prompt'` listener (matched by
   * reference).
   */
  offPrompt: (listener: Listener<map['prompt']>) => void
  /**
   * Subscribe to the session closing, cleanly or with a cause. Fires
   * exactly once per session.
   */
  onClose: (listener: Listener<map['close']>) => AbortController
  /**
   * Observe raw uRPC envelopes (`rpc-requests` / `rpc-responses`)
   * crossing the wire in either direction — a read-only tap for
   * logging/tracing. Discriminate on `envelope.type`; use `send` /
   * `notify` to issue traffic.
   */
  onEnvelope: (listener: Listener<map['envelope']>) => AbortController
  /**
   * Subscribe to transport errors (network, parse, AEAD).
   */
  onError: (listener: Listener<map['error']>) => AbortController
  /**
   * Subscribe to inbound JSON-RPC notifications from the host.
   */
  onNotification: (listener: Listener<map['notification']>) => AbortController
  /**
   * Subscribe to the session opening — fired once `start()` completes.
   */
  onOpen: (listener: Listener<map['open']>) => AbortController
  /**
   * Subscribe to user-facing pairing/verification prompts produced by an
   * out-of-band transport (e.g. `relay`, `deviceCode`) during startup.
   */
  onPrompt: (listener: Listener<map['prompt']>) => AbortController
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
> = ConsumerListeners<ConsumerEventMap<schema, context, ConsumerPromptEvent<transport>>> & {
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Send a typed JSON-RPC notification (no response expected).
   * Auto-starts this transport on first use.
   */
  notify: <const method extends Consumer.MethodName<schema>>(
    options: Consumer.NotifyOptions<schema, method>,
  ) => Promise<void>
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
   *
   * Forwards any start options the wrapped transport accepts (e.g. the
   * relay transport's `{ scheme }`).
   */
  start: (options?: Transport.StartOptionsOf<transport>) => Promise<void>
  /** The wrapped transport. */
  transport: transport
}

/** Consumer surface shared by single and multi-transport instances. */
export type ConsumerBase<
  schema extends Schema.Schema | undefined,
  transports extends ConsumerTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = ConsumerListeners<
  ConsumerEventMap<schema, context, ConsumerPromptEvent<transports[number]>>
> & {
  /** Close all configured transports. Idempotent. */
  close: (cause?: Error) => Promise<void>
  /**
   * Composite web-standard fetch handler. Present when any configured
   * transport exposes HTTP routes or when discovery is auto-published.
   */
  fetch: Http.HandlersForTransports<transports>['fetch']
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
 * hostWata.onRequest(async (event) => {
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
  const { baseUrl, identity, meta } = options

  if (meta && !baseUrl)
    throw new Errors.BaseError('`baseUrl` is required when `meta` is set', {
      details: 'consumer_id needs a fully-qualified origin',
    })
  assertUniqueTransportNames(transports)

  // Lazy-inject parent app context into every transport so adapters can
  // derive discovery URLs, signing keys, and peer-facing metadata from
  // one app-level `Wata.create` call.
  for (const transport of transports) transport.bind?.({ baseUrl, identity, meta })

  const sessions = transports.map((transport) =>
    createConsumerSession({ context, schema, transport }),
  )
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

  if (sessions.length === 1) {
    const session = sessions[0]!
    return {
      ...session,
      fetch: httpFetch as Consumer<schema, transports, RequestContextOf<context>>['fetch'],
      transports,
    } as unknown as Consumer<schema, transports, RequestContextOf<context>>
  }

  const emitter =
    Events.create<
      ConsumerEventMap<schema, RequestContextOf<context>, ConsumerPromptEvent<transports[number]>>
    >()
  // The aggregate prompt payload is generic over `transports`, so loosen
  // the local emit to forward each session's already-tagged payload.
  const emitPrompt = emitter.emit as (type: 'prompt', payload: object) => boolean
  for (const session of sessions) {
    session.onError((error) => emitter.emit('error', error))
    session.onNotification((...payload) => emitter.emit('notification', ...payload))
    session.onPrompt((prompt) => emitPrompt('prompt', prompt as object))
    session.onEnvelope((envelope, meta) => emitter.emit('envelope', envelope, meta))
  }
  const consumer = {
    async close(cause?: Error) {
      await Promise.all(sessions.map((session) => session.close(cause)))
      emitter.emit('close', cause)
    },
    fetch: httpFetch as Consumer<schema, transports, RequestContextOf<context>>['fetch'],
    ...Events.subscribers(emitter, consumerEventNames),
    role: 'consumer' as const,
    schema,
    transports,
  }
  for (const session of sessions) Object.assign(consumer, { [session.transport.name]: session })
  return consumer as unknown as Consumer<schema, transports, RequestContextOf<context>>
}

function createConsumerSession<
  const schema extends Schema.Schema | undefined,
  const transport extends Transport.Transport<'consumer', string, unknown>,
  const context extends Schema.Context | undefined,
>(parameters: {
  context: context
  schema: schema
  transport: transport
}): ConsumerSession<schema, transport, RequestContextOf<context>> {
  const { context, schema, transport } = parameters

  const emitter =
    Events.create<
      ConsumerEventMap<schema, RequestContextOf<context>, ConsumerPromptEvent<transport>>
    >()
  const pending = new Map<Rpc.Id, Pending>()
  const methodById = new Map<Rpc.Id, string>()
  // `started` = currently in an active session. After close, drops back
  // to `false`, and the next `send()` / `notify()` lazily re-starts the
  // transport. Popups closing externally are a normal end-of-session
  // event, not a permanent wata failure.
  //
  // `phase` enforces the spec §7 mode-discipline gate: while `pre-key`,
  // any inbound `encrypted` envelope is rejected with JSON-RPC `-32600`
  // and the session is torn down. Once the AEAD layer flips it to
  // `keyed` (after key derivation), the inverse rule kicks in: any
  // inbound plaintext envelope is rejected the same
  // way. The transition is one-way; never reverts.
  type State = { phase: 'pre-key' | 'keyed'; started: boolean }
  const state: State = {
    phase: 'pre-key',
    started: false,
  }
  let startPromise: Promise<void> | undefined
  let nextId = 1

  function rejectPending(cause: Error) {
    for (const [, deferred] of pending) deferred.reject(cause)
    pending.clear()
    methodById.clear()
  }

  function rejectResponseValidation(message: Rpc.Response, cause: unknown): void {
    if ('error' in message || message.id === null) {
      emitter.emit('error', cause as Error)
      return
    }
    const deferred = pending.get(message.id)
    if (!deferred) {
      emitter.emit('error', cause as Error)
      return
    }
    pending.delete(message.id)
    methodById.delete(message.id)
    emitter.emit('error', cause as Error)
    deferred.reject(cause as Error)
  }

  function validateResponseMessage(message: Rpc.Response): Rpc.Response {
    if ('error' in message) return message
    if (!schema) return message
    const method = message.id === null ? undefined : methodById.get(message.id)
    const result = SchemaRuntime.validateResultForMethod(schema, method, message.result)
    return {
      id: message.id,
      jsonrpc: message.jsonrpc,
      result,
    }
  }

  function handleResponse(message: Rpc.Response, options: { validated?: boolean } = {}) {
    if ('error' in message) {
      const id = message.id
      if (id === null) return
      const deferred = pending.get(id)
      if (!deferred) return
      pending.delete(id)
      methodById.delete(id)
      const { code, data, message: text } = message.error
      deferred.reject(new Rpc.RpcError(text, { code, data }))
      return
    }
    const id = message.id
    if (id === null) return
    const deferred = pending.get(id)
    if (!deferred) return
    pending.delete(id)
    const method = methodById.get(id)
    methodById.delete(id)
    try {
      const validated = options.validated
        ? message.result
        : schema
          ? SchemaRuntime.validateResultForMethod(schema, method, message.result)
          : message.result
      deferred.resolve({ id, result: validated })
    } catch (cause) {
      deferred.reject(cause as Error)
    }
  }

  function dispatchNotification(message: Rpc.Notification): void {
    if (schema) {
      try {
        SchemaRuntime.validateParamsForMethod(schema, message.method, message.params)
      } catch (cause) {
        emitter.emit('error', cause as Error)
        return
      }
    }
    const payload = {
      method: message.method,
      notification: message,
      params: message.params,
      transport: transport.name,
    } as ConsumerEventMap<schema, RequestContextOf<context>>['notification']
    emitter.emit(
      'notification',
      ...([payload] as Events.EventArgs<
        ConsumerEventMap<schema, RequestContextOf<context>>['notification']
      >),
    )
  }

  function emitEnvelope(
    envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' | 'rpc-responses' }>,
    direction: EnvelopeMeta['direction'],
  ): void {
    emitter.emit(
      'envelope',
      envelope as unknown as ObservedEnvelope<schema, RequestContextOf<context>>,
      { direction, transport: transport.name },
    )
  }

  /**
   * Spec §7 mode-discipline rejection. Sends the peer an unsolicited
   * JSON-RPC `-32600` error (`id: null`, since we have no request to
   * correlate against), tears the transport down, and surfaces the
   * cause to local listeners.
   */
  function rejectModeViolation(reason: string): void {
    const error = new Errors.ProtocolError(reason)
    void (async () => {
      try {
        const envelope = Envelope.rpcResponses([
          Rpc.error({ code: -32600, data: reason, id: null, message: 'invalid request' }),
        ])
        emitEnvelope(envelope, 'outgoing')
        await transport.send(envelope)
      } catch {
        // Peer may already be unreachable; the teardown below is what matters.
      }
      try {
        await transport.close(error)
      } catch {
        // Same: surface via the local `error` event below regardless.
      }
      emitter.emit('error', error)
    })()
  }

  transport.on('message', (envelope) => {
    // Pre-key phase: encrypted frames are not yet allowed (the AEAD
    // layer has not derived keys for this session). Spec §7 mandates
    // a JSON-RPC `-32600` response and immediate teardown.
    if (state.phase === 'pre-key' && envelope.type === 'encrypted') {
      rejectModeViolation('encrypted envelope received before key derivation')
      return
    }
    // Keyed phase: the inverse, any plaintext envelope is rejected
    // because the spec forbids mixing plaintext and ciphertext after
    // keying. Reachable once a session enters keyed mode; harmless
    // while nothing flips `state.phase` to `keyed`.
    if (state.phase === 'keyed' && envelope.type !== 'encrypted') {
      rejectModeViolation('plaintext envelope received after key derivation')
      return
    }
    if (envelope.type === 'rpc-responses') {
      const payload: Rpc.Response[] = []
      for (const message of envelope.payload) {
        try {
          payload.push(validateResponseMessage(message))
        } catch (cause) {
          rejectResponseValidation(message, cause)
        }
      }
      if (payload.length === 0) return
      const envelope_validated = Envelope.rpcResponses(payload)
      emitEnvelope(envelope_validated, 'incoming')
      for (const message of envelope_validated.payload) handleResponse(message, { validated: true })
      return
    }
    if (envelope.type === 'rpc-requests') {
      emitEnvelope(envelope, 'incoming')
      for (const message of envelope.payload) if (!('id' in message)) dispatchNotification(message)
      return
    }
    // `ready` / `hello` ride at the transport layer.
  })

  transport.on('close', (cause) => {
    if (!state.started) return
    state.started = false
    rejectPending(cause ?? new Transport.ClosedError('wata transport closed'))
    emitter.emit('close', cause)
  })

  transport.on('error', (error) => {
    emitter.emit('error', error)
  })

  // `transport`'s prompt payload is generic here (the bound collapses it
  // to `never`), so loosen the local emit to forward the tagged payload.
  const emitPrompt = emitter.emit as (type: 'prompt', payload: object) => boolean
  transport.on('prompt', (prompt) => {
    emitPrompt('prompt', { ...(prompt as object), transport: transport.name })
  })

  async function start(options?: Transport.StartOptionsOf<transport>): Promise<void> {
    if (state.started) return
    if (startPromise) return startPromise
    startPromise = (async () => {
      try {
        await (transport.start as (options?: Transport.StartOptionsOf<transport>) => Promise<void>)(
          options,
        )
        state.started = true
        emitter.emit('open', undefined)
      } finally {
        startPromise = undefined
      }
    })()
    return startPromise
  }

  return {
    async close(cause) {
      if (!state.started) return
      state.started = false
      rejectPending(cause ?? new Transport.ClosedError('wata closed locally'))
      await transport.close(cause)
      emitter.emit('close', cause)
    },
    async notify(opts) {
      if (!transport.capabilities.notifications.consumer)
        throw new Transport.UnsupportedError(
          `transport \`${transport.name}\` does not support consumer notifications`,
        )
      if (!state.started) await start()
      if (schema) SchemaRuntime.validateParamsForMethod(schema, opts.method, opts.params)
      const envelope = Envelope.rpcRequests([
        Rpc.notification({ method: opts.method, params: opts.params }),
      ])
      emitEnvelope(envelope, 'outgoing')
      await transport.send(envelope)
    },
    ...Events.subscribers(emitter, consumerEventNames),
    role: 'consumer',
    schema,
    async send(opts) {
      if (!state.started) await start()

      const id = opts.id ?? nextId++
      if (schema) SchemaRuntime.validateParamsForMethod(schema, opts.method, opts.params)
      const context_value =
        opts.context === undefined
          ? undefined
          : context
            ? Schema.validate(context, opts.context)
            : Schema.validate(Rpc.schema.requestContext, opts.context)

      const deferred = new Promise<SendResult<unknown>>((resolve, reject) => {
        pending.set(id, { reject, resolve })
      })
      methodById.set(id, opts.method)

      try {
        const envelope = Envelope.rpcRequests([
          Rpc.request({
            context: context_value,
            id,
            method: opts.method,
            params: opts.params,
          }),
        ])
        emitEnvelope(envelope, 'outgoing')
        const metadata = await transport.send(envelope)
        if (metadata !== undefined) {
          void deferred.catch(() => undefined)
          return metadata as Consumer.SendReturn<schema, transport, typeof opts.method>
        }
      } catch (cause) {
        pending.delete(id)
        methodById.delete(id)
        throw cause
      }

      return (await deferred) as Consumer.SendReturn<schema, transport, typeof opts.method>
    },
    start,
    transport,
  }
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
     * Optional signer-backed identity. When set, `Wata` publishes its
     * public key in discovery and lazy-injects the signer into transports
     * that need authenticated HTTP messages.
     */
    identity?: Transport.Identity | undefined
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

type Pending = {
  reject: (error: Error) => void
  resolve: (result: SendResult<unknown>) => void
}
