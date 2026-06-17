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
 * Session-surface types (lifecycle event map, listener signature, send
 * result, envelope tap) live in {@link "./core/Session"} so they sit with
 * the session they describe; this file owns the config + `create` factory.
 *
 * Consumers can opt into typed JSON-RPC methods through `schema`, app
 * metadata/discovery through `baseUrl` + `meta`, and transport-specific
 * HTTP handlers through the wrapped transport.
 */

import * as Discovery from '../core/Discovery.js'
import * as Envelope from '../core/Envelope.js'
import * as Errors from '../core/Errors.js'
import * as Events from '../core/Events.js'
import * as Http from '../core/Http.js'
import * as Rpc from '../core/Rpc.js'
import * as Schema from '../core/Schema.js'
import * as SchemaRuntime from '../core/SchemaRuntime.js'
import * as Transport from '../core/Transport.js'
import * as Wellknown from '../core/Wellknown.js'
import type * as Session from './Session.js'

/** Consumer event names, used to derive the `onX` / `offX` surface. */
const consumerEventNames = ['close', 'envelope', 'error', 'notification', 'prompt'] as const

/** Non-empty tuple of consumer transports accepted by {@link create}. */
export type ConsumerTransports = readonly [
  Transport.Any<'consumer'>,
  ...Transport.Any<'consumer'>[],
]

/** Default single-transport tuple used by the broad {@link Consumer} type. */
export type SingleConsumerTransports = readonly [Transport.Transport<'consumer', string>]

/** Consumer config surface shared by single and multi-transport instances. */
export type ConsumerBase<
  schema extends Schema.Schema | undefined,
  transports extends ConsumerTransports,
> = {
  /** Close every started session. Idempotent. */
  close: (cause?: Error) => Promise<void>
  /**
   * Composite web-standard fetch handler. Present when any configured
   * transport exposes HTTP routes or when discovery is auto-published.
   * Inbound traffic only reaches listeners once the relevant transport's
   * session has been opened with {@link ConsumerHandle.start}.
   */
  fetch: Http.HandlersForTransports<transports>['fetch']
  /** Side of the protocol this wata speaks for. */
  role: 'consumer'
  /** Optional method-registry schema. */
  schema: schema
  /** Configured transports, in user-supplied order. */
  transports: transports
}

/**
 * Per-transport handle exposed on the consumer config (e.g. `wata.relay`).
 * Call {@link start} to open the {@link Session.Session} — the live object
 * that carries `send` / `notify` and the `onX` event surface.
 */
export type ConsumerHandle<
  schema extends Schema.Schema | undefined,
  transport extends Transport.Any<'consumer'>,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /**
   * Open the session for this transport and resolve with it. Idempotent
   * while the session is active: repeat calls return the same session.
   * Once the session closes, a fresh `start()` opens a new one.
   *
   * Forwards any start options the wrapped transport accepts (e.g. the
   * relay transport's `{ target, url }`). The options parameter follows
   * {@link Transport.StartFn} — required when the transport defers a
   * mandatory value to start (e.g. a `relay()` built without a `url`),
   * optional otherwise. Passing options to an already-started handle
   * throws — close the session first to restart with new options.
   */
  start: Transport.StartFn<
    Transport.StartOptionsOf<transport>,
    Session.Session<schema, transport, context>
  >
}

/** Transport handles keyed by each transport's SDK-facing name. */
export type ConsumerHandleMap<
  schema extends Schema.Schema | undefined,
  transports extends ConsumerTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  [transport in transports[number] as string extends transport['name']
    ? never
    : transport['name']]: ConsumerHandle<schema, transport, context>
}

/**
 * Consumer-side `Wata` config. Returned by {@link create}. Defines the
 * configuration only — no live event handlers or `send`. Every transport
 * is exposed as a named handle (e.g. `wata.relay`, `wata.mobileLink`)
 * whose {@link ConsumerHandle.start} opens the live {@link Session.Session}.
 * A single transport additionally lifts `start` to the top level for
 * ergonomics (`wata.start()`).
 */
export type Consumer<
  schema extends Schema.Schema | undefined = undefined,
  transports extends ConsumerTransports = SingleConsumerTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = ConsumerBase<schema, transports> &
  ConsumerHandleMap<schema, transports, context> &
  (transports extends readonly [infer transport extends Transport.Any<'consumer'>]
    ? Pick<ConsumerHandle<schema, transport, context>, 'start'>
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

  /** Return type of `send`, preserving transport-specific registration metadata. */
  type SendReturn<
    schema extends Schema.Schema | undefined,
    transport extends Transport.Any<'consumer'>,
    method extends string,
  > = [Transport.SendValue<transport>] extends [void]
    ? Session.SendResult<ResultOf<schema, method>>
    : Transport.SendValue<transport>

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
 * `create` returns config only; call `start()` to open the live session
 * that carries `send` / `notify` and the event surface. A single-transport
 * config lifts `start` to the top level (`wata.start()`); multi-transport
 * configs expose a handle per transport (`wata.<name>.start()`).
 *
 * @example
 * ```ts
 * import { Wata, loopback } from 'wata'
 * import { Wata as HostWata } from 'wata/host'
 *
 * const { consumer, host } = loopback()
 *
 * const hostSession = await HostWata.create({ transports: [host] }).start()
 * hostSession.onRequest(async (event) => {
 *   if (event.method === 'ping') await event.respond({ ok: true })
 * })
 *
 * const session = await Wata.create({ transports: [consumer] }).start()
 * const { result } = await session.send({ method: 'ping', params: [] })
 * ```
 */
export function create<
  const schema extends Schema.Schema | undefined = undefined,
  const transports extends ConsumerTransports = SingleConsumerTransports,
  const context extends Schema.Context | undefined = undefined,
>(
  options: create.Options<schema, transports, context>,
): Consumer<schema, transports, Session.RequestContextOf<context>> {
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

  const handles = transports.map((transport) =>
    createConsumerHandle({ context, schema, transport }),
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

  // Surface each transport's handle by name (e.g. `wata.relay`) so callers
  // open a specific session with `wata.<name>.start()`.
  const byName: Record<string, unknown> = {}
  transports.forEach((transport, index) => {
    byName[transport.name] = handles[index]
  })

  const consumer = {
    async close(cause?: Error) {
      await Promise.all(handles.map((handle) => handle.close(cause)))
    },
    fetch: httpFetch as Consumer<schema, transports, Session.RequestContextOf<context>>['fetch'],
    role: 'consumer' as const,
    schema,
    transports,
    ...byName,
    // Single-transport sugar: lift `start` so `wata.start()` opens the
    // lone session without reaching through `wata.<name>`.
    ...(handles.length === 1 ? { start: handles[0]!.start } : {}),
  }
  return consumer as unknown as Consumer<schema, transports, Session.RequestContextOf<context>>
}

/**
 * Per-transport handle backing `wata.<name>`. Lazily creates and opens a
 * {@link Session.Session} on {@link ConsumerHandle.start}, caches it while
 * active, and invalidates the cache when the session closes so a fresh
 * `start()` opens a new session.
 */
function createConsumerHandle<
  const schema extends Schema.Schema | undefined,
  const transport extends Transport.Any<'consumer'>,
  const context extends Schema.Context | undefined,
>(parameters: {
  context: context
  schema: schema
  transport: transport
}): ConsumerHandle<schema, transport, Session.RequestContextOf<context>> & {
  close: (cause?: Error) => Promise<void>
} {
  const { context, schema, transport } = parameters
  type ConsumerSession = Session.Session<schema, transport, Session.RequestContextOf<context>>
  let active: ConsumerSession | undefined
  let startPromise: Promise<ConsumerSession> | undefined

  return {
    async close(cause) {
      await active?.close(cause)
    },
    start(options?: Transport.StartOptionsOf<transport>) {
      if (active) {
        if (options !== undefined)
          throw new Errors.BaseError(
            `transport \`${transport.name}\` is already started; close the session before restarting with new options`,
          )
        return Promise.resolve(active)
      }
      if (startPromise) return startPromise
      startPromise = (async () => {
        const { session, start } = createConsumerSession({ context, schema, transport })
        // Drop the cached session on close so the next `start()` is fresh.
        session.onClose(() => {
          active = undefined
        })
        await start(options)
        active = session
        return session
      })().finally(() => {
        startPromise = undefined
      })
      return startPromise
    },
  }
}

function createConsumerSession<
  const schema extends Schema.Schema | undefined,
  const transport extends Transport.Any<'consumer'>,
  const context extends Schema.Context | undefined,
>(parameters: {
  context: context
  schema: schema
  transport: transport
}): {
  session: Session.Session<schema, transport, Session.RequestContextOf<context>>
  start: (options?: Transport.StartOptionsOf<transport>) => Promise<void>
} {
  const { context, schema, transport } = parameters

  const emitter =
    Events.create<
      Session.ConsumerEventMap<
        schema,
        Session.RequestContextOf<context>,
        Session.ConsumerPromptEvent<transport>
      >
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
  // Most-recent pairing prompt, captured from the transport's `'prompt'`
  // event during `start()`. Exposed as `session.prompt` and replayed to
  // late `onPrompt` subscribers (the event fires before the session
  // handle is handed back to the caller).
  let lastPrompt: Session.ConsumerPromptEvent<transport> | undefined
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
    } as Session.ConsumerEventMap<schema, Session.RequestContextOf<context>>['notification']
    emitter.emit(
      'notification',
      ...([payload] as Events.EventArgs<
        Session.ConsumerEventMap<schema, Session.RequestContextOf<context>>['notification']
      >),
    )
  }

  function emitEnvelope(
    envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' | 'rpc-responses' }>,
    direction: Session.EnvelopeMeta['direction'],
  ): void {
    emitter.emit(
      'envelope',
      envelope as unknown as Session.ObservedEnvelope<schema, Session.RequestContextOf<context>>,
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
    lastPrompt = {
      ...(prompt as object),
      transport: transport.name,
    } as Session.ConsumerPromptEvent<transport>
    emitPrompt('prompt', lastPrompt as object)
  })

  async function start(options?: Transport.StartOptionsOf<transport>): Promise<void> {
    if (state.started) return
    if (startPromise) return startPromise
    startPromise = (async (): Promise<void> => {
      try {
        await (
          transport.start as (options?: Transport.StartOptionsOf<transport>) => Promise<unknown>
        )(options)
        state.started = true
      } finally {
        startPromise = undefined
      }
    })()
    return startPromise
  }

  const subscribers = Events.subscribers(emitter, consumerEventNames)
  const session: Session.Session<schema, transport, Session.RequestContextOf<context>> = {
    // Hoist transport-specific extras (e.g. `mobileLink`'s `handleUrl`)
    // first so the wrapped session members below always win on any clash.
    ...transportExtras(transport),
    // Spread the generated `onX` / `offX` surface before the explicit
    // members so the `onPrompt` override below wins.
    ...subscribers,
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
    onPrompt(listener) {
      // Replay the current prompt to late subscribers — it was produced
      // during `start()`, before this session was handed to the caller.
      if (lastPrompt !== undefined)
        (listener as (payload: Session.ConsumerPromptEvent<transport>) => unknown)(lastPrompt)
      return subscribers.onPrompt(listener)
    },
    get prompt() {
      return lastPrompt
    },
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

      const deferred = new Promise<Session.SendResult<unknown>>((resolve, reject) => {
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
    transport,
  }
  return { session, start }
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

function assertUniqueTransportNames(transports: readonly Transport.Any[]): void {
  const seen = new Set<string>()
  for (const transport of transports) {
    if (seen.has(transport.name))
      throw new Errors.BaseError(`duplicate transport name \`${transport.name}\``)
    seen.add(transport.name)
  }
}

function collectCallbackUrls(transports: readonly Transport.Any[]): readonly string[] {
  const urls = new Set<string>()
  for (const transport of transports) for (const url of transport.callbackUrls ?? []) urls.add(url)
  return Array.from(urls)
}

function collectPublicKey(transports: readonly Transport.Any[]): string | undefined {
  let publicKey: string | undefined
  for (const transport of transports) {
    if (!transport.publicKey) continue
    if (publicKey && publicKey !== transport.publicKey)
      throw new Errors.BaseError('configured transports expose conflicting public keys')
    publicKey = transport.publicKey
  }
  return publicKey
}

/**
 * Own members of a transport beyond the base {@link Transport} contract
 * (e.g. `mobileLink`'s `handleUrl`), filtered by {@link Transport.baseKeys}.
 * Hoisted onto the wrapping consumer session so `wata.<name>.handleUrl`
 * works directly.
 */
function transportExtras<transport extends Transport.Any>(
  transport: transport,
): Transport.Extras<transport> {
  const baseKeys = new Set<string>(Transport.baseKeys)
  return Object.fromEntries(
    Object.entries(transport).filter(([key]) => !baseKeys.has(key)),
  ) as Transport.Extras<transport>
}

function isHttpServer<transport extends Transport.Any>(
  transport: transport,
): transport is transport & Http.RoutedServer {
  const candidate = transport as Partial<Http.RoutedServer>
  return typeof candidate.fetch === 'function'
}

type Pending = {
  reject: (error: Error) => void
  resolve: (result: Session.SendResult<unknown>) => void
}
