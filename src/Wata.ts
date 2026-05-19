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

import { Base64, Bytes, Ed25519, type Hex } from 'ox'

import * as Discovery from './core/Discovery.js'
import * as Envelope from './core/Envelope.js'
import * as Errors from './core/Errors.js'
import * as Events from './core/Events.js'
import * as Http from './core/Http.js'
import * as Rpc from './core/Rpc.js'
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

/**
 * Listener supplied to {@link Consumer.on} (and to {@link "./host/Wata".Host.on}).
 * Receives the typed payload for the subscribed event directly. The
 * underlying `rettime` `TypedEvent` is unwrapped to keep call sites
 * focused on the data they care about.
 */
export type Listener<payload> = (payload: payload) => unknown

/** Lifecycle events emitted on every `Wata` (consumer + host). */
export type LifecycleEventMap = {
  /** Emitted exactly once when the session closes, cleanly or with cause. */
  close: Error | undefined
  /** Emitted when the transport surfaces an error (network, parse, AEAD). */
  error: Error
  /** Emitted after `start()` completes (both consumer and host). */
  open: void
}

/** Non-empty tuple of consumer transports accepted by {@link create}. */
export type ConsumerTransports = readonly [
  Transport.Transport<'consumer', string>,
  ...Transport.Transport<'consumer', string>[],
]

/** Default single-transport tuple used by the broad {@link Consumer} type. */
export type SingleConsumerTransports = readonly [Transport.Transport<'consumer', string>]

/** Transport-specific consumer session exposed on `wata.<transportName>`. */
export type ConsumerSession<
  schema extends Schema.Schema | undefined,
  transport extends Transport.Transport<'consumer', string>,
> = ConsumerTransportExtras<transport> & {
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Send a typed JSON-RPC notification (no response expected).
   * Auto-starts this transport on first use.
   */
  notify: <
    const method extends Consumer.MethodName<schema>,
    const params extends Consumer.ParamsOf<schema, method>,
  >(
    options: Consumer.NotifyOptions<method, params>,
  ) => Promise<void>
  /** Remove a previously subscribed listener. */
  off: <type extends keyof LifecycleEventMap>(
    type: type,
    listener: Listener<LifecycleEventMap[type]>,
  ) => void
  /**
   * Subscribe to a lifecycle event. Returns an `AbortController` so the
   * subscription can be cancelled (or composed with an external signal).
   */
  on: <type extends keyof LifecycleEventMap>(
    type: type,
    listener: Listener<LifecycleEventMap[type]>,
  ) => AbortController
  /** Side of the protocol this wata speaks for. */
  role: 'consumer'
  /** Optional method-registry schema flowed through `send` / `notify`. */
  schema: schema
  /**
   * Send a typed JSON-RPC request over this transport. Auto-starts on
   * first use. Resolves with the host's `result` (or rejects with
   * {@link Rpc.RpcError} if the host returned an error response).
   */
  send: <
    const method extends Consumer.MethodName<schema>,
    const params extends Consumer.ParamsOf<schema, method>,
  >(
    options: Consumer.SendOptions<method, params>,
  ) => Promise<SendResult<Consumer.ResultOf<schema, method>>>
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

type ConsumerTransportExtras<transport extends Transport.Transport<'consumer', string>> =
  transport extends { handle: infer handle } ? { handle: handle } : {}

/** Consumer surface shared by single and multi-transport instances. */
export type ConsumerBase<
  schema extends Schema.Schema | undefined,
  transports extends ConsumerTransports,
> = {
  /** Close all configured transports. Idempotent. */
  close: (cause?: Error) => Promise<void>
  /**
   * Composite web-standard fetch handler. Present when any configured
   * transport exposes HTTP routes or when discovery is auto-published.
   */
  fetch: Http.HandlersForTransports<transports>['fetch']
  /** See {@link fetch}. */
  listener: Http.HandlersForTransports<transports>['listener']
  /** Remove a previously subscribed lifecycle listener. */
  off: <type extends keyof LifecycleEventMap>(
    type: type,
    listener: Listener<LifecycleEventMap[type]>,
  ) => void
  /** Subscribe to aggregate lifecycle events. */
  on: <type extends keyof LifecycleEventMap>(
    type: type,
    listener: Listener<LifecycleEventMap[type]>,
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
> = {
  [name in transports[number]['name']]: ConsumerSession<
    schema,
    Extract<transports[number], { name: name }>
  >
}

/**
 * Consumer-side `Wata`. Returned by {@link create}. Every transport exposes
 * a named child session such as `wata.webhookCallback.send`; a single
 * transport also exposes `send` / `notify` at the top level.
 */
export type Consumer<
  schema extends Schema.Schema | undefined = undefined,
  transports extends ConsumerTransports = SingleConsumerTransports,
> = ConsumerBase<schema, transports> &
  ConsumerChildMap<schema, transports> &
  (transports extends readonly [infer transport extends Transport.Transport<'consumer', string>]
    ? ConsumerSession<schema, transport>
    : {})

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

  /** Options for {@link Consumer.send}. */
  type SendOptions<method extends string, params extends Rpc.Params> = {
    /** Optional explicit request id. Defaults to a monotonically-increasing number. */
    id?: Rpc.Id | undefined
    /** Method name. Narrowed against the schema when one was supplied. */
    method: method
    /** Method params. Narrowed against the schema when one was supplied. */
    params: params
  }

  /** Options for {@link Consumer.notify}. */
  type NotifyOptions<method extends string, params extends Rpc.Params> = {
    /** Method name. Narrowed against the schema when one was supplied. */
    method: method
    /** Method params. Narrowed against the schema when one was supplied. */
    params: params
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
>(options: create.Options<schema, transports>): Consumer<schema, transports> {
  const transports = options.transports as transports
  const schema = options.schema as schema
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

  const sessions = transports.map((transport) => createConsumerSession({ schema, transport }))
  const routed = Http.composeRouted(transports.filter(isHttpServer))
  let httpFetch = routed?.fetch
  let httpListener = routed?.listener
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
    httpListener = wrapped.listener
  }

  if (sessions.length === 1) {
    const session = sessions[0]!
    return {
      ...session,
      fetch: httpFetch as Consumer<schema, transports>['fetch'],
      [session.transport.name]: session,
      listener: httpListener as Consumer<schema, transports>['listener'],
      transports,
    } as unknown as Consumer<schema, transports>
  }

  const emitter = Events.create<LifecycleEventMap>()
  for (const session of sessions) {
    session.on('error', (error) => emitter.emit('error', error))
  }
  const consumer = {
    async close(cause?: Error) {
      await Promise.all(sessions.map((session) => session.close(cause)))
      emitter.emit('close', cause)
    },
    fetch: httpFetch as Consumer<schema, transports>['fetch'],
    listener: httpListener as Consumer<schema, transports>['listener'],
    off: emitter.off,
    on(type: keyof LifecycleEventMap, listener: Listener<LifecycleEventMap[typeof type]>) {
      const controller = new AbortController()
      emitter.on(type, listener as never, { signal: controller.signal })
      return controller
    },
    role: 'consumer' as const,
    schema,
    transports,
  }
  for (const session of sessions) Object.assign(consumer, { [session.transport.name]: session })
  return consumer as unknown as Consumer<schema, transports>
}

function createConsumerSession<
  const schema extends Schema.Schema | undefined,
  const transport extends Transport.Transport<'consumer', string>,
>(parameters: { schema: schema; transport: transport }): ConsumerSession<schema, transport> {
  const { schema, transport } = parameters

  const emitter = Events.create<LifecycleEventMap>()

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

  function handleResponse(message: Rpc.Response) {
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
      const validated = schema
        ? validateResultIfKnown(schema, method, message.result)
        : message.result
      deferred.resolve({ id, result: validated })
    } catch (cause) {
      deferred.reject(cause as Error)
    }
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
        await transport.send(
          Envelope.rpcResponses([
            Rpc.error({ code: -32600, data: reason, id: null, message: 'invalid request' }),
          ]),
        )
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
      for (const message of envelope.payload) handleResponse(message)
      return
    }
    // `rpc-requests`, `ready`, `hello` are not currently routed into the
    // consumer-side surface; ignored. (Hosts don't issue requests today;
    // `ready`/`hello` ride at the transport layer.)
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

  async function start(): Promise<void> {
    if (state.started) return
    if (startPromise) return startPromise
    startPromise = (async () => {
      try {
        await transport.start()
        state.started = true
        emitter.emit('open', undefined)
      } finally {
        startPromise = undefined
      }
    })()
    return startPromise
  }

  return {
    async close(cause?: Error) {
      if (!state.started) return
      state.started = false
      rejectPending(cause ?? new Transport.ClosedError('wata closed locally'))
      await transport.close(cause)
      emitter.emit('close', cause)
    },
    async notify<
      const method extends Consumer.MethodName<schema>,
      const params extends Consumer.ParamsOf<schema, method>,
    >(options: Consumer.NotifyOptions<method, params>) {
      if (!state.started) await start()
      if (schema) validateParamsIfKnown(schema, options.method, options.params)
      await transport.send(
        Envelope.rpcRequests([
          Rpc.notification({ method: options.method, params: options.params }),
        ]),
      )
    },
    off: emitter.off,
    on<type extends keyof LifecycleEventMap>(
      type: type,
      listener: Listener<LifecycleEventMap[type]>,
    ) {
      const controller = new AbortController()
      emitter.on(type, listener, { signal: controller.signal })
      return controller
    },
    role: 'consumer',
    schema,
    async send<
      const method extends Consumer.MethodName<schema>,
      const params extends Consumer.ParamsOf<schema, method>,
    >(options: Consumer.SendOptions<method, params>) {
      if (!state.started) await start()

      const id = options.id ?? nextId++
      if (schema) validateParamsIfKnown(schema, options.method, options.params)

      const deferred = new Promise<SendResult<unknown>>((resolve, reject) => {
        pending.set(id, { reject, resolve })
      })
      methodById.set(id, options.method)

      try {
        await transport.send(
          Envelope.rpcRequests([
            Rpc.request({ id, method: options.method, params: options.params }),
          ]),
        )
      } catch (cause) {
        pending.delete(id)
        methodById.delete(id)
        throw cause
      }

      return (await deferred) as SendResult<Consumer.ResultOf<schema, typeof options.method>>
    },
    start,
    transport,
    ...('handle' in transport ? { handle: transport.handle } : {}),
  } as unknown as ConsumerSession<schema, transport>
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<
    schema extends Schema.Schema | undefined,
    transports extends ConsumerTransports = SingleConsumerTransports,
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
     * Optional human-facing app metadata. When set together with
     * {@link baseUrl}, `Wata` auto-publishes a
     * `/.well-known/urpc/consumer.json` off the transport's
     * `.fetch` / `.listener` (or as a standalone surface if the
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

function assertUniqueTransportNames(transports: readonly Transport.Transport[]): void {
  const seen = new Set<string>()
  for (const transport of transports) {
    if (seen.has(transport.name))
      throw new Errors.BaseError(`duplicate transport name \`${transport.name}\``)
    seen.add(transport.name)
  }
}

function collectCallbackUrls(transports: readonly Transport.Transport[]): readonly string[] {
  const urls = new Set<string>()
  for (const transport of transports) for (const url of transport.callbackUrls ?? []) urls.add(url)
  return Array.from(urls)
}

function collectPublicKey(transports: readonly Transport.Transport[]): string | undefined {
  let publicKey: string | undefined
  for (const transport of transports) {
    if (!transport.publicKey) continue
    if (publicKey && publicKey !== transport.publicKey)
      throw new Errors.BaseError('configured transports expose conflicting public keys')
    publicKey = transport.publicKey
  }
  return publicKey
}

function isHttpServer<transport extends Transport.Transport>(
  transport: transport,
): transport is transport & Http.RoutedServer {
  const candidate = transport as Partial<Http.RoutedServer>
  return typeof candidate.fetch === 'function' && typeof candidate.listener === 'function'
}

type Pending = {
  reject: (error: Error) => void
  resolve: (result: SendResult<unknown>) => void
}

function identityFromPrivateKey(privateKey: Hex.Hex): Transport.Identity {
  const publicKey = Base64.fromBytes(Bytes.from(Ed25519.getPublicKey({ privateKey })), {
    pad: false,
    url: true,
  })
  return { privateKey, publicKey }
}

/**
 * Validate inbound `params` against the schema entry for `method` if one
 * exists. Used by both sides. Consumer validates outbound calls before
 * sending; host validates inbound requests/notifications before dispatch.
 *
 * @internal
 */
export function validateParamsIfKnown(
  schema: Schema.Schema,
  method: string,
  params: Rpc.Params,
): void {
  const definition = schema.methods[method]
  if (!definition) return
  Schema.validate(definition.params, params)
}

function validateResultIfKnown(
  schema: Schema.Schema,
  method: string | undefined,
  result: unknown,
): unknown {
  if (!method) return result
  const definition = schema.methods[method]
  if (!definition) return result
  return Schema.validate(definition.result, result)
}
