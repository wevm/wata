/**
 * `wata/host` `Wata` namespace: the host-side public surface.
 *
 * `Wata.create` here always returns a {@link Host}. To create a
 * consumer, import from `wata` instead. Cross-side session primitives
 * (`Listener`, `LifecycleEventMap`, `EnvelopeMeta`, `RequestContextOf`)
 * live in {@link "../core/Session"}; the host session surface
 * (`RequestEvent`, host `NotificationEvent`, `HostEventMap`,
 * `HostListeners`, the live `Session.Session` + `compose`) lives in
 * {@link "./Session"}. This file owns the host config + `create` factory.
 */

import * as Discovery from '../core/Discovery.js'
import * as Envelope from '../core/Envelope.js'
import * as Errors from '../core/Errors.js'
import * as Events from '../core/Events.js'
import * as Http from '../core/Http.js'
import * as Rpc from '../core/Rpc.js'
import * as Schema from '../core/Schema.js'
import * as SchemaRuntime from '../core/SchemaRuntime.js'
import type * as core_Session from '../core/Session.js'
import * as Transport from '../core/Transport.js'
import * as Wellknown from '../core/Wellknown.js'
import type * as Session from './Session.js'

/** Host transport accepted by {@link create}. */
export type HostTransport = Transport.Transport<
  'host',
  string,
  { meta: Transport.MessageMeta; sendValue: unknown }
>

/**
 * Host lifecycle/notification event names, used to derive the `onX` /
 * `offX` surface. `'request'` is handled separately by
 * {@link Host.onRequest} (method overloads + return-to-answer).
 */
const hostEventNames = ['close', 'envelope', 'error', 'notification', 'ready'] as const

/** Metadata delivered to host request and notification listeners. */
export type HostEventMeta<transport extends HostTransport = HostTransport> =
  Transport.MessageMetaOf<transport> & {
    /** SDK-facing name of the transport that delivered this event. */
    transport: transport['name']
  }

/** Non-empty tuple of host transports accepted by {@link create}. */
export type HostTransports = readonly [HostTransport, ...HostTransport[]]

/**
 * Per-transport handle exposed on the host config (e.g. `wata.relay`).
 * Call {@link start} to open the {@link Session.Session} — the live object
 * that carries `onRequest` / `respond` / `notify` and the `onX` event
 * surface.
 */
export type HostHandle<
  schema extends Schema.Schema | undefined,
  transport extends HostTransport,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /**
   * Open the session for this transport and return it synchronously. The
   * transport handshake runs in the background — await `session.ready` or
   * subscribe to the `'ready'` event to observe when it completes (and to
   * surface start failures). Idempotent while the session is active: repeat
   * calls return the same session. Once the session closes, a fresh
   * `start()` opens a new one.
   *
   * Forwards any start options the wrapped transport accepts (e.g. the
   * relay transport's `{ uri }`). The options parameter follows
   * {@link Transport.SyncStartFn} — required when the transport defers a
   * mandatory value to start, optional otherwise. Passing options to an
   * already-started handle throws — close the session first to restart
   * with new options.
   */
  start: Transport.SyncStartFn<
    Transport.StartOptionsOf<transport>,
    Session.Session<schema, transport, context>
  >
}

/** Transport handles keyed by each transport's SDK-facing name. */
export type HostHandleMap<
  schema extends Schema.Schema | undefined,
  transports extends HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  [transport in transports[number] as string extends transport['name']
    ? never
    : transport['name']]: HostHandle<schema, transport, context>
}

/**
 * Host-side `Wata` config. Returned by {@link create}. Defines the
 * configuration only — no live request handlers. Every transport is
 * exposed as a named handle (e.g. `wata.relay`) whose
 * {@link HostHandle.start} opens the live {@link Session.Session}. A single
 * transport additionally lifts `start` to the top level for ergonomics
 * (`wata.start()`).
 */
export type Host<
  schema extends Schema.Schema | undefined = undefined,
  transports extends HostTransports = HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = HostHandleMap<schema, transports, context> & {
  /** Close every started session. Idempotent. */
  close: (cause?: Error) => Promise<void>
  /**
   * Web-standard fetch handler forwarded from the transport when
   * present. HTTP-shaped transports (`deviceCode`, `webhookCallback`,
   * …) expose the standard {@link Http.Server} signature that drops
   * onto Cloudflare Workers, Bun, Deno, Vercel Edge, etc. Non-HTTP
   * transports (`postMessage`, `loopback`, …) leave it `undefined`.
   * Inbound traffic only reaches listeners once the relevant transport's
   * session has been opened with {@link HostHandle.start}.
   */
  fetch: Http.HandlersForTransports<transports>['fetch']
  /** Side of the protocol this wata speaks for. */
  role: 'host'
  /** Optional method-registry schema flowed through `'request'` / `'notification'` events. */
  schema: schema
  /** Configured transports, in user-supplied order. */
  transports: transports
} & (transports extends readonly [infer transport extends HostTransport]
    ? Pick<HostHandle<schema, transport, context>, 'start'>
    : {})

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
 * `create` returns config only; call `start()` to open the live
 * {@link Session.Session} that carries `onRequest` / `respond` / `notify` and
 * the event surface. A single-transport config lifts `start` to the top
 * level (`wata.start()`); multi-transport configs expose a handle per
 * transport (`wata.<name>.start()`).
 *
 * @example
 * Synchronous answer from inside the listener.
 * ```ts
 * import { Wata, postMessage } from 'wata/host'
 *
 * const session = await Wata.create({
 *   transports: [postMessage()],
 * }).start()
 *
 * session.onRequest(async (event) => {
 *   if (event.method === 'ping') await event.respond({ ok: true })
 * })
 * ```
 *
 * @example
 * Late answer by id (UI / approval flows). Store `event.id` and settle it
 * later with `session.respond(id, ...)`.
 * ```ts
 * import { Wata, postMessage } from 'wata/host'
 *
 * const session = await Wata.create({
 *   transports: [postMessage()],
 * }).start()
 *
 * let id: string | number | undefined
 *
 * session.onRequest((event) => {
 *   id = event.id
 * })
 *
 * // Later, when the user clicks "approve":
 * if (id !== undefined) await session.respond(id, { ok: true })
 * ```
 */
export function create<
  const schema extends Schema.Schema | undefined = undefined,
  const transports extends HostTransports = HostTransports,
  const context extends Schema.Context | undefined = undefined,
>(
  options: create.Options<schema, transports, context>,
): Host<schema, transports, core_Session.RequestContextOf<context>> {
  const transports = options.transports as transports
  const schema = options.schema as schema
  const context = options.context as context
  const { baseUrl, identity, meta } = options

  if (meta && !baseUrl)
    throw new Errors.BaseError('`baseUrl` is required when `meta` is set', {
      details: 'host_id and transport bindings need a fully-qualified origin',
    })
  if (meta && !identity)
    throw new Errors.BaseError('`identity` is required when `meta` is set', {
      details: 'host.json publishes the long-term Ed25519 identity public key',
    })
  assertUniqueTransportNames(transports)

  // Lazy-inject parent app context into the transports so HTTP-server-
  // shaped adapters can populate verification URIs and sign responses
  // from one app-wide config.
  for (const transport of transports) transport.bind?.({ baseUrl, identity, meta })

  const handles = transports.map((transport) => createHostHandle({ context, schema, transport }))

  const routed = Http.composeRouted(transports.filter(isHttpServer))

  // When `meta` + `baseUrl` are both set, wrap routed transport fetch so
  // GET `/.well-known/urpc/host.json`
  // serves the auto-built document and every other request falls
  // through to the underlying transport routes. Transports without
  // `.fetch` can still publish a well-known (the wrapper exposes
  // its own `.fetch` even when nothing else is mounted).
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

  // Surface each transport's handle by name (e.g. `wata.relay`) so callers
  // open a specific session with `wata.<name>.start()`.
  const byName: Record<string, unknown> = {}
  transports.forEach((transport, index) => {
    byName[transport.name] = handles[index]
  })

  const host = {
    async close(cause?: Error) {
      await Promise.all(handles.map((handle) => handle.close(cause)))
    },
    fetch: httpFetch as Host<schema, transports, core_Session.RequestContextOf<context>>['fetch'],
    role: 'host' as const,
    schema,
    transports,
    ...byName,
    // Single-transport sugar: lift `start` so `wata.start()` opens the
    // lone session without reaching through `wata.<name>`.
    ...(handles.length === 1 ? { start: handles[0]!.start } : {}),
  }
  return host as unknown as Host<schema, transports, core_Session.RequestContextOf<context>>
}

/**
 * Per-transport handle backing `wata.<name>`. Lazily creates and opens a
 * {@link Session.Session} on {@link HostHandle.start}, caches it while active,
 * and invalidates the cache when the session closes so a fresh `start()`
 * opens a new session.
 */
function createHostHandle<
  const schema extends Schema.Schema | undefined,
  const transport extends HostTransport,
  const context extends Schema.Context | undefined,
>(parameters: {
  context: context
  schema: schema
  transport: transport
}): HostHandle<schema, transport, core_Session.RequestContextOf<context>> & {
  close: (cause?: Error) => Promise<void>
} {
  const { context, schema, transport } = parameters
  type HostSession = Session.Session<schema, transport, core_Session.RequestContextOf<context>>
  let active: HostSession | undefined

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
        return active
      }
      const { session, start } = createHostSession({ context, schema, transport })
      active = session
      // Drop the cached session on close so the next `start()` is fresh.
      session.onClose(() => {
        active = undefined
      })
      // Kick off the transport handshake in the background; failures surface
      // via `session.ready`, the `'ready'`/`'error'` events, and (for a
      // relay host blocked on pairing) `handle.close()` can tear down the
      // pending start. A failed start emits no `close`, so clear the cache
      // here to avoid stranding a dead session.
      void start(options).catch(() => {
        active = undefined
      })
      return session
    },
  }
}

function transportExtras<transport extends HostTransport>(
  transport: transport,
): Transport.Extras<transport> {
  const baseKeys = new Set<string>(Transport.baseKeys)
  return Object.fromEntries(
    Object.entries(transport).filter(([key]) => !baseKeys.has(key)),
  ) as Transport.Extras<transport>
}

/**
 * Build a single live {@link Session.Session} around one host transport. All
 * request/notification dispatch, pending tracking, and response helpers
 * are scoped to this transport — there is no cross-transport fan-out, so
 * a pending id is always unambiguous.
 */
function createHostSession<
  const schema extends Schema.Schema | undefined,
  const transport extends HostTransport,
  const context extends Schema.Context | undefined,
>(parameters: {
  context: context
  schema: schema
  transport: transport
}): {
  session: Session.Session<schema, transport, core_Session.RequestContextOf<context>>
  start: (options?: Transport.StartOptionsOf<transport>) => Promise<void>
} {
  const { context, schema, transport } = parameters

  const emitter =
    Events.create<
      Session.HostEventMap<schema, readonly [transport], core_Session.RequestContextOf<context>>
    >()

  // User-supplied `request` listeners, in registration order. The
  // `request` dispatch loop iterates these directly so it can capture
  // each listener's return value (and thrown error) for the
  // first-non-undefined-wins resolution semantics. Tracked here rather
  // than via `emitter.on('request', ...)` because the wrapper swallows
  // listener errors and never surfaces return values back to the caller.
  type RequestPayload = Session.HostEventMap<
    schema,
    readonly [transport],
    core_Session.RequestContextOf<context>
  >['request']
  type RequestListener = (payload: RequestPayload) => unknown
  type RequestListenerEntry = {
    listener: RequestListener
    method?: string | undefined
    source: object
  }
  const requestListeners = new Set<RequestListenerEntry>()
  function addRequestListener(
    listener: RequestListener,
    source: object,
    method?: string | undefined,
  ): RequestListenerEntry {
    const entry: RequestListenerEntry = {
      listener,
      source,
      ...(method === undefined ? {} : { method }),
    }
    requestListeners.add(entry)
    return entry
  }

  function removeRequestListener(source: object, method?: string | undefined): void {
    for (const entry of requestListeners)
      if (entry.source === source && entry.method === method) requestListeners.delete(entry)
  }

  type State = { phase: 'pre-key' | 'keyed'; started: boolean }
  const state: State = { phase: 'pre-key', started: false }
  let startPromise: Promise<void> | undefined
  // Resolves once the transport has started; surfaced as `session.ready`
  // and the `'ready'` event. `start` settles it on its first run; the
  // internal `catch` keeps an unawaited `ready` from raising an unhandled
  // rejection while still letting callers observe the failure.
  let resolveReady!: () => void
  let rejectReady!: (cause: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  void readyPromise.catch(() => {})
  // Tracks whether the transport has started so late `onReady` subscribers
  // are notified immediately (the `'ready'` event fires during `start()`,
  // before this session is handed to the caller).
  let isReady = false
  const invalid_context = Symbol('invalid context')
  const pending = new Map<Rpc.Id, Rpc.Request>()

  /**
   * Returns the in-flight send Promise so callers that need to know the
   * response actually flushed (popup hosts closing the window, worker
   * hosts terminating, etc.) can `await` it. Resolves with `false` when
   * no pending request matched `id`.
   */
  function settle(id: Rpc.Id, response: Rpc.Response): Promise<boolean> {
    if (!pending.has(id)) return Promise.resolve(false)
    pending.delete(id)
    return sendResponses([response]).then(() => true)
  }

  function success(id: Rpc.Id, method: string, result: unknown): Rpc.Success {
    const value = schema ? SchemaRuntime.validateResultForMethod(schema, method, result) : result
    return Rpc.success({ id, result: value })
  }

  function settleInternalError(id: Rpc.Id, cause: unknown): Promise<boolean> {
    const error = cause instanceof Error ? cause : new Errors.BaseError(String(cause))
    emitter.emit('error', error)
    return settle(
      id,
      Rpc.error({
        code: -32603,
        data: error.message,
        id,
        message: 'internal error',
      }),
    )
  }

  function settleSuccess(id: Rpc.Id, method: string, result: unknown): Promise<boolean> {
    return settle(id, success(id, method, result))
  }

  async function respond(id: Rpc.Id, result: unknown): Promise<void> {
    const request = pending.get(id)
    const ok = request ? await settle(id, success(id, request.method, result)) : false
    if (!ok) throw new UnknownRequestError(id)
  }

  async function reject(id: Rpc.Id, error: reject.Error): Promise<void> {
    const { code, data, message } = error
    const ok = pending.has(id) ? await settle(id, Rpc.error({ code, data, id, message })) : false
    if (!ok) throw new UnknownRequestError(id)
  }

  async function start(options?: Transport.StartOptionsOf<transport>): Promise<void> {
    if (state.started) return
    if (startPromise) return startPromise
    startPromise = (async (): Promise<void> => {
      try {
        await (
          transport.start as (options?: Transport.StartOptionsOf<transport>) => Promise<unknown>
        )(options)
        state.started = true
        isReady = true
        resolveReady()
        emitter.emit('ready', undefined)
      } catch (cause) {
        rejectReady(cause as Error)
        throw cause
      } finally {
        startPromise = undefined
      }
    })()
    return startPromise
  }

  async function sendResponses(responses: ReadonlyArray<Rpc.Response>): Promise<void> {
    const envelope = Envelope.rpcResponses(responses)
    emitEnvelope(envelope, 'outgoing')
    try {
      await transport.send(envelope)
    } catch {
      // The transport surfaces its own error to listeners; swallow here so
      // the host loop doesn't blow up after a peer disconnect.
    }
  }

  function emitEnvelope(
    envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' | 'rpc-responses' }>,
    direction: core_Session.EnvelopeMeta['direction'],
  ): void {
    emitter.emit(
      'envelope',
      envelope as unknown as core_Session.ObservedEnvelope<
        schema,
        core_Session.RequestContextOf<context>
      >,
      { direction, transport: transport.name },
    )
  }

  async function dispatchRequest(
    request: Rpc.Request,
    metadata?: Transport.MessageMeta | undefined,
  ) {
    const context_value = await (async () => {
      if (request.context === undefined) return undefined
      try {
        return (
          context
            ? Schema.validate(context, request.context)
            : Schema.validate(Rpc.schema.requestContext, request.context)
        ) as core_Session.RequestContextOf<context>
      } catch (cause) {
        await sendResponses([
          Rpc.error({
            code: -32600,
            data: (cause as Error).message,
            id: request.id,
            message: 'invalid context',
          }),
        ])
        return invalid_context
      }
    })()
    if (context_value === invalid_context) return
    const request_value = {
      id: request.id,
      jsonrpc: request.jsonrpc,
      method: request.method,
      params: request.params,
      ...(context_value === undefined ? {} : { context: context_value }),
    }
    if (schema) {
      try {
        SchemaRuntime.validateParamsForMethod(schema, request_value.method, request_value.params)
      } catch (cause) {
        await sendResponses([
          Rpc.error({
            code: -32602,
            data: (cause as Error).message,
            id: request_value.id,
            message: 'invalid params',
          }),
        ])
        return
      }
    }

    const snapshot = Array.from(requestListeners).filter(
      (entry) => entry.method === undefined || entry.method === request_value.method,
    )

    // No matching listener has any chance of answering this request. Fall
    // through to JSON-RPC `method not found` so the consumer doesn't hang.
    if (snapshot.length === 0) {
      await sendResponses([
        Rpc.error({
          code: -32601,
          data: request_value.method,
          id: request_value.id,
          message: 'method not found',
        }),
      ])
      return
    }

    // Track the request so `event.respond` / `event.reject` and the
    // session's `respond` / `reject` can all settle by id. The entry stays
    // in `pending` until a listener answers (now or later) or the session
    // closes.
    pending.set(request_value.id, request_value)

    const payload = {
      context: context_value,
      id: request_value.id,
      meta: hostEventMeta(transport, metadata),
      method: request_value.method,
      params: request_value.params,
      reject: (rpcError: { code: number; data?: unknown; message: string }) =>
        settle(
          request_value.id,
          Rpc.error({
            code: rpcError.code,
            data: rpcError.data,
            id: request_value.id,
            message: rpcError.message,
          }),
        ).then(() => undefined),
      request: request_value,
      respond: async (result: unknown) => {
        try {
          await settleSuccess(request_value.id, request_value.method, result)
        } catch (cause) {
          await settleInternalError(request_value.id, cause)
          throw cause
        }
      },
      transport: transport.name,
    } as RequestPayload

    // Iterate the user-registered listeners directly so we can capture
    // each one's outcome (return value or thrown error). Snapshot first
    // because a listener may unsubscribe siblings during dispatch.
    let firstError: Error | undefined
    for (const entry of snapshot) {
      if (!pending.has(request_value.id)) break
      let value: unknown
      try {
        value = entry.listener(payload)
      } catch (cause) {
        firstError ??= cause as Error
        continue
      }
      try {
        const resolved = await Promise.resolve(value)
        if (entry.method !== undefined && resolved !== undefined) {
          try {
            await settleSuccess(request_value.id, request_value.method, resolved)
          } catch (cause) {
            await settleInternalError(request_value.id, cause)
          }
          break
        }
      } catch (cause) {
        firstError ??= cause as Error
      }
    }

    if (pending.has(request_value.id) && firstError) {
      if (firstError instanceof Rpc.RpcError)
        await settle(
          request_value.id,
          Rpc.error({
            code: firstError.code,
            data: firstError.data,
            id: request_value.id,
            message: firstError.message,
          }),
        )
      else
        await settle(
          request_value.id,
          Rpc.error({
            code: -32603,
            data: firstError.message,
            id: request_value.id,
            message: 'internal error',
          }),
        )
    }

    // Otherwise: the request stays pending. A listener acknowledged it by
    // being registered, so the host trusts the application to settle later
    // via `session.respond(id, ...)` / `session.reject(id, ...)`.
  }

  function dispatchNotification(
    message: Rpc.Notification,
    metadata?: Transport.MessageMeta | undefined,
  ) {
    if (schema) {
      try {
        SchemaRuntime.validateParamsForMethod(schema, message.method, message.params)
      } catch (cause) {
        emitter.emit('error', cause as Error)
        return
      }
    }
    const payload = {
      meta: hostEventMeta(transport, metadata),
      method: message.method,
      notification: message,
      params: message.params,
      transport: transport.name,
    } as Session.HostEventMap<
      schema,
      readonly [transport],
      core_Session.RequestContextOf<context>
    >['notification']
    emitter.emit(
      'notification',
      ...([payload] as Events.EventArgs<
        Session.HostEventMap<
          schema,
          readonly [transport],
          core_Session.RequestContextOf<context>
        >['notification']
      >),
    )
  }

  /**
   * Spec §7 mode-discipline rejection. Sends the peer an unsolicited
   * JSON-RPC `-32600` error (`id: null`, since we have no request to
   * correlate against), tears the transport down, and surfaces the cause
   * to local listeners.
   */
  function rejectModeViolation(reason: string): void {
    const error = new Errors.ProtocolError(reason)
    void (async () => {
      await sendResponses([
        Rpc.error({ code: -32600, data: reason, id: null, message: 'invalid request' }),
      ])
      try {
        await transport.close(error)
      } catch {
        // Surface via the local `error` event regardless.
      }
      emitter.emit('error', error)
    })()
  }

  transport.on('message', async (envelope, metadata) => {
    if (state.phase === 'pre-key' && envelope.type === 'encrypted') {
      rejectModeViolation('encrypted envelope received before key derivation')
      return
    }
    if (state.phase === 'keyed' && envelope.type !== 'encrypted') {
      rejectModeViolation('plaintext envelope received after key derivation')
      return
    }
    if (envelope.type === 'rpc-requests') {
      emitEnvelope(envelope, 'incoming')
      for (const message of envelope.payload) {
        if ('id' in message) await dispatchRequest(message, metadata)
        else dispatchNotification(message, metadata)
      }
    }
  })

  transport.on('close', (cause) => {
    if (!state.started) return
    state.started = false
    pending.clear()
    emitter.emit('close', cause)
  })

  transport.on('error', (error) => {
    emitter.emit('error', error)
  })

  async function notify(
    options: Host.NotifyOptions<schema, Host.MethodName<schema>>,
  ): Promise<void> {
    if (!transport.capabilities.notifications.host)
      throw new Transport.UnsupportedError(
        `transport \`${transport.name}\` does not support host notifications`,
      )
    if (!state.started) await start()
    if (schema) SchemaRuntime.validateParamsForMethod(schema, options.method, options.params)
    const envelope = Envelope.rpcRequests([
      Rpc.notification({ method: options.method, params: options.params }),
    ])
    emitEnvelope(envelope, 'outgoing')
    await transport.send(envelope)
  }

  const subscribers = Events.subscribers(emitter, hostEventNames)
  const session: Session.Session<schema, transport, core_Session.RequestContextOf<context>> = {
    // Hoist transport-specific extras (e.g. `mobileLink`'s `handleUrl`)
    // first so the wrapped session members below always win on any clash.
    ...transportExtras(transport),
    ...subscribers,
    async close(cause) {
      if (!state.started && !startPromise) return
      state.started = false
      pending.clear()
      await transport.close(cause)
      emitter.emit('close', cause)
    },
    notify,
    offRequest(methodOrListener: string | object, listener?: unknown) {
      const isMethod = typeof methodOrListener === 'string'
      removeRequestListener(
        (isMethod ? (listener as object) : methodOrListener) as object,
        isMethod ? methodOrListener : undefined,
      )
    },
    onRequest(methodOrListener: string | RequestListener, listener?: unknown) {
      const isMethod = typeof methodOrListener === 'string'
      const source = (isMethod ? (listener as object) : methodOrListener) as object
      const entry = addRequestListener(
        (isMethod ? listener : methodOrListener) as RequestListener,
        source,
        isMethod ? methodOrListener : undefined,
      )
      const controller = new AbortController()
      controller.signal.addEventListener(
        'abort',
        () => {
          requestListeners.delete(entry)
        },
        { once: true },
      )
      return controller
    },
    onReady(listener) {
      // Replay to late subscribers — `'ready'` fires during `start()`,
      // before this session is handed to the caller.
      if (isReady) (listener as () => unknown)()
      return subscribers.onReady(listener)
    },
    ready: readyPromise,
    reject,
    respond,
    role: 'host',
    schema,
    transport,
  }
  return { session, start }
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
     * {@link baseUrl} and {@link identity}, `Wata` auto-publishes
     * a `/.well-known/urpc/host.json` off the transport's existing
     * `.fetch`. No separate mount required. The
     * published doc's `transports` map is auto-built from the
     * transport's {@link Transport.Transport.discovery} binding.
     * Lazy-injected into transports that opt into
     * {@link Transport.Transport.bind}.
     */
    meta?: Discovery.Meta | undefined
    /**
     * Signer-backed host identity. Required with {@link meta}; also
     * lazy-injected into transports that sign as the host.
     */
    identity?: Transport.Identity | undefined
    /** Optional method-registry schema (typed `'request'` / `'notification'` payloads). */
    schema?: schema | undefined
    /** Host-role transports this wata wraps. */
    transports: transports
  }
}

function hostEventMeta(
  transport: HostTransport,
  metadata?: Transport.MessageMeta | undefined,
): HostEventMeta {
  return { ...metadata, transport: transport.name }
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
 * Thrown by {@link Session.Session.respond} / {@link Session.Session.reject} when
 * no inbound request with the supplied id is currently pending. Means the
 * request was already settled, never received, or the session has closed.
 */
export class UnknownRequestError extends Errors.BaseError {
  override name = 'Wata.UnknownRequestError'

  constructor(id: Rpc.Id) {
    super(`no pending request with id \`${String(id)}\``)
  }
}
