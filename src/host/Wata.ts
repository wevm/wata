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

import { Base64, Bytes, Ed25519, type Hex } from 'ox'

import * as Discovery from '../core/Discovery.js'
import * as Envelope from '../core/Envelope.js'
import * as Errors from '../core/Errors.js'
import * as Events from '../core/Events.js'
import * as Http from '../core/Http.js'
import * as Rpc from '../core/Rpc.js'
import * as Schema from '../core/Schema.js'
import * as Transport from '../core/Transport.js'
import * as Wellknown from '../core/Wellknown.js'
import * as Wata from '../Wata.js'

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
> = {
  /** Id of the JSON-RPC request being answered. */
  id: Rpc.Id
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
  request: Rpc.Request<method, params>
  /**
   * Sugar for `wata.respond(event.id, result)`. Resolves once the
   * success response has flushed to the transport (so popup hosts can
   * `await` delivery before calling `window.close()`). Idempotent
   * across `event.respond` / `event.reject` / `wata.respond` /
   * `wata.reject`.
   */
  respond: (result: result) => Promise<void>
  /** SDK-facing name of the transport that delivered this request. */
  transport: string
}

/** Event payload delivered to host `'notification'` listeners. */
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

/**
 * Distribute over the schema's method names so the `request` payload is a
 * proper discriminated union. Narrowing on `event.method` narrows
 * `event.respond`'s argument and `event.params` together.
 */
type DistributeRequest<schema extends Schema.Schema, name extends string> =
  name extends Schema.MethodName<schema>
    ? Schema.ParamsOf<schema, name> extends infer params
      ? params extends Rpc.Params
        ? RequestEvent<name, params, Schema.ResultOf<schema, name>>
        : never
      : never
    : never

/** Same shape as {@link DistributeRequest}, but for notifications. */
type DistributeNotification<schema extends Schema.Schema, name extends string> =
  name extends Schema.MethodName<schema>
    ? Schema.ParamsOf<schema, name> extends infer params
      ? params extends Rpc.Params
        ? NotificationEvent<name, params>
        : never
      : never
    : never

/**
 * Helper conditional that maps a {@link Schema} method name to the typed
 * `RequestEvent` payload host listeners receive.
 */
export type SchemaRequestEvent<schema extends Schema.Schema | undefined> =
  schema extends Schema.Schema ? DistributeRequest<schema, Schema.MethodName<schema>> : RequestEvent

/** Helper conditional mapping a schema to the typed `NotificationEvent`. */
export type SchemaNotificationEvent<schema extends Schema.Schema | undefined> =
  schema extends Schema.Schema
    ? DistributeNotification<schema, Schema.MethodName<schema>>
    : NotificationEvent

/** Host-side event map (lifecycle + request/notification dispatch). */
export type HostEventMap<schema extends Schema.Schema | undefined> =
  Wata.LifecycleEventMap<schema> & {
    /** Inbound JSON-RPC notification. Fire-and-forget. */
    notification: SchemaNotificationEvent<schema>
    /** Inbound JSON-RPC request. First non-`undefined` listener return wins. */
    request: SchemaRequestEvent<schema>
  }

/** Non-empty tuple of host transports accepted by {@link create}. */
export type HostTransports = readonly [
  Transport.Transport<'host', string>,
  ...Transport.Transport<'host', string>[],
]

/** Host-side `Wata`. Returned by {@link create}. */
export type Host<
  schema extends Schema.Schema | undefined = undefined,
  transports extends HostTransports = HostTransports,
> = {
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Web-standard fetch handler + Node `http.RequestListener` pair
   * forwarded from the transport when present. HTTP-shaped transports
   * (`deviceCode`, `webhookCallback`, …) expose the standard
   * {@link Http.Server} signatures that drop onto Cloudflare Workers,
   * Bun, Deno, Vercel Edge, `node:http`, etc. Non-HTTP transports
   * (`postMessage`, `loopback`, …) leave both `undefined`.
   */
  fetch: Http.HandlersForTransports<transports>['fetch']
  /** See {@link fetch}. */
  listener: Http.HandlersForTransports<transports>['listener']
  /**
   * Send a typed JSON-RPC notification from the host to the consumer.
   * Auto-starts transports that support host-origin notifications.
   */
  notify: <
    const method extends Host.MethodName<schema>,
    const params extends Host.ParamsOf<schema, method>,
  >(
    options: Host.NotifyOptions<method, params>,
  ) => Promise<void>
  /** Remove a previously subscribed listener. */
  off: <type extends keyof HostEventMap<schema>>(
    type: type,
    listener: Wata.Listener<HostEventMap<schema>[type]>,
  ) => void
  /**
   * Subscribe to a host event. Returns an `AbortController` so the
   * subscription can be cancelled (or composed with an external signal).
   *
   * Lazy-connects the transport on first call, so most hosts never need
   * to call {@link Host.start} explicitly.
   */
  on: <type extends keyof HostEventMap<schema>>(
    type: type,
    listener: Wata.Listener<HostEventMap<schema>[type]>,
  ) => AbortController
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
  type NotifyOptions<method extends string, params extends Rpc.Params> = {
    /** Method name. Narrowed against the schema when one was supplied. */
    method: method
    /** Method params. Narrowed against the schema when one was supplied. */
    params: params
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
>(options: create.Options<schema, transports>): Host<schema, transports> {
  const transports = options.transports as transports
  const schema = options.schema as schema
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

  const emitter = Events.create<HostEventMap<schema>>()
  // User-supplied `request` listeners, in registration order. The
  // `request` dispatch loop iterates these directly so it can capture
  // each listener's return value (and thrown error) for the
  // first-non-undefined-wins resolution semantics. Tracked here rather
  // than via `emitter.on('request', ...)` because the wrapper swallows
  // listener errors and never surfaces return values back to the caller.
  const requestListeners = new Set<(payload: HostEventMap<schema>['request']) => unknown>()

  type Runtime = {
    phase: 'pre-key' | 'keyed'
    started: boolean
    startPromise: Promise<void> | undefined
    transport: Transport.Transport<'host', string>
  }
  const runtimes: Runtime[] = transports.map((transport) => ({
    phase: 'pre-key',
    started: false,
    startPromise: undefined,
    transport,
  }))
  const pending = new Map<string, PendingRequest>()
  let startPromise: Promise<void> | undefined

  /**
   * Returns the in-flight send Promise so callers that need to know
   * the response actually flushed (popup hosts closing the window,
   * worker hosts terminating, etc.) can `await` it. Resolves with
   * `false` when no pending request matched `id`.
   */
  function settle(
    transport: Transport.Transport<'host', string>,
    id: Rpc.Id,
    response: Rpc.Response,
  ): Promise<boolean> {
    const key = pendingKey(transport, id)
    const entry = pending.get(key)
    if (!entry) return Promise.resolve(false)
    pending.delete(key)
    return sendResponses(transport, [response]).then(() => true)
  }

  function resolvePending(id: Rpc.Id): PendingRequest | undefined {
    const matches = Array.from(pending.values()).filter((entry) => entry.request.id === id)
    if (matches.length === 0) return undefined
    if (matches.length > 1)
      throw new AmbiguousRequestError(
        id,
        matches.map((entry) => entry.transport.name),
      )
    return matches[0]
  }

  function clearPending(transport: Transport.Transport<'host', string>): void {
    for (const [key, entry] of pending) if (entry.transport === transport) pending.delete(key)
  }

  async function respond(id: Rpc.Id, result: unknown): Promise<void> {
    const entry = resolvePending(id)
    const ok = entry ? await settle(entry.transport, id, Rpc.success({ id, result })) : false
    if (!ok) throw new UnknownRequestError(id)
  }

  async function reject(id: Rpc.Id, error: reject.Error): Promise<void> {
    const { code, data, message } = error
    const entry = resolvePending(id)
    const ok = entry
      ? await settle(entry.transport, id, Rpc.error({ code, data, id, message }))
      : false
    if (!ok) throw new UnknownRequestError(id)
  }

  function startRuntime(runtime: Runtime): Promise<void> {
    if (runtime.started) return Promise.resolve()
    if (!runtime.startPromise) {
      runtime.startPromise = runtime.transport
        .start()
        .then(() => {
          runtime.started = true
        })
        .finally(() => {
          runtime.startPromise = undefined
        })
    }
    return runtime.startPromise
  }

  async function start(): Promise<void> {
    if (startPromise) return startPromise
    if (runtimes.every((runtime) => runtime.started)) return
    startPromise = Promise.all(runtimes.map(startRuntime))
      .then(() => {
        emitter.emit('open', undefined)
      })
      .finally(() => {
        startPromise = undefined
      })
    return startPromise
  }

  function lazyConnect(): void {
    void start().catch((error: Error) => emitter.emit('error', error))
  }

  async function sendResponses(
    transport: Transport.Transport<'host', string>,
    responses: ReadonlyArray<Rpc.Response>,
  ): Promise<void> {
    const envelope = Envelope.rpcResponses(responses)
    emitter.emit('rpc-responses', envelope.payload as Wata.RpcResponsesPayload<schema>, {
      direction: 'outgoing',
      transport: transport.name,
      type: 'rpc-responses',
    })
    try {
      await transport.send(envelope)
    } catch {
      // The transport surfaces its own error to listeners; swallow here so
      // the host loop doesn't blow up after a peer disconnect.
    }
  }

  function emitRpcRequests(
    transport: Transport.Transport<'host', string>,
    envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' }>,
    direction: Wata.RpcEnvelopeMeta['direction'],
  ): void {
    emitter.emit('rpc-requests', envelope.payload as unknown as Wata.RpcRequestsPayload<schema>, {
      direction,
      transport: transport.name,
      type: 'rpc-requests',
    })
  }

  async function dispatchRequest(runtime: Runtime, request: Rpc.Request) {
    if (schema) {
      try {
        Wata.validateParamsIfKnown(schema, request.method, request.params)
      } catch (cause) {
        await sendResponses(runtime.transport, [
          Rpc.error({
            code: -32602,
            data: (cause as Error).message,
            id: request.id,
            message: 'invalid params',
          }),
        ])
        return
      }
    }

    // No listener has any chance of answering this request. Fall through
    // to JSON-RPC `method not found` so the consumer doesn't hang.
    if (requestListeners.size === 0) {
      await sendResponses(runtime.transport, [
        Rpc.error({
          code: -32601,
          data: request.method,
          id: request.id,
          message: 'method not found',
        }),
      ])
      return
    }

    // Track the request so `event.respond` / `event.reject` and the
    // top-level `wata.respond` / `wata.reject` can all settle
    // by id. The entry stays in `pending` until a listener answers
    // (now or later) or the wata closes.
    const key = pendingKey(runtime.transport, request.id)
    pending.set(key, { request, transport: runtime.transport })

    const payload = {
      id: request.id,
      method: request.method,
      params: request.params,
      reject: (rpcError: { code: number; data?: unknown; message: string }) =>
        settle(
          runtime.transport,
          request.id,
          Rpc.error({
            code: rpcError.code,
            data: rpcError.data,
            id: request.id,
            message: rpcError.message,
          }),
        ).then(() => undefined),
      request,
      respond: (result: unknown) =>
        settle(runtime.transport, request.id, Rpc.success({ id: request.id, result })).then(
          () => undefined,
        ),
      transport: runtime.transport.name,
    } as HostEventMap<schema>['request']

    // Iterate the user-registered listeners directly so we can capture
    // each one's outcome (return value or thrown error). Snapshot first
    // because a listener may unsubscribe siblings during dispatch.
    const snapshot = Array.from(requestListeners)
    let firstError: Error | undefined
    for (const listener of snapshot) {
      if (!pending.has(key)) break
      let value: unknown
      try {
        value = listener(payload)
      } catch (cause) {
        firstError ??= cause as Error
        continue
      }
      try {
        const resolved = await Promise.resolve(value)
        if (resolved !== undefined) {
          await settle(
            runtime.transport,
            request.id,
            Rpc.success({ id: request.id, result: resolved }),
          )
          break
        }
      } catch (cause) {
        firstError ??= cause as Error
      }
    }

    if (pending.has(key) && firstError) {
      if (firstError instanceof Rpc.RpcError)
        await settle(
          runtime.transport,
          request.id,
          Rpc.error({
            code: firstError.code,
            data: firstError.data,
            id: request.id,
            message: firstError.message,
          }),
        )
      else
        await settle(
          runtime.transport,
          request.id,
          Rpc.error({
            code: -32603,
            data: firstError.message,
            id: request.id,
            message: 'internal error',
          }),
        )
    }

    // Otherwise: the request stays pending. A listener acknowledged it
    // by being registered, so the host trusts the application to settle
    // later via `wata.respond(id, ...)` / `wata.reject(id, ...)`.
  }

  function dispatchNotification(runtime: Runtime, message: Rpc.Notification) {
    if (schema) {
      try {
        Wata.validateParamsIfKnown(schema, message.method, message.params)
      } catch (cause) {
        emitter.emit('error', cause as Error)
        return
      }
    }
    const payload = {
      method: message.method,
      notification: message,
      params: message.params,
      transport: runtime.transport.name,
    } as HostEventMap<schema>['notification']
    emitter.emit(
      'notification',
      ...([payload] as Events.EventArgs<HostEventMap<schema>['notification']>),
    )
  }

  /**
   * Spec §7 mode-discipline rejection. Sends the peer an unsolicited
   * JSON-RPC `-32600` error (`id: null`, since we have no request to
   * correlate against), tears the transport down, and surfaces the
   * cause to local listeners.
   */
  function rejectModeViolation(runtime: Runtime, reason: string): void {
    const error = new Errors.ProtocolError(reason)
    void (async () => {
      await sendResponses(runtime.transport, [
        Rpc.error({ code: -32600, data: reason, id: null, message: 'invalid request' }),
      ])
      try {
        await runtime.transport.close(error)
      } catch {
        // Surface via the local `error` event regardless.
      }
      emitter.emit('error', error)
    })()
  }

  for (const runtime of runtimes) {
    runtime.transport.on('message', async (envelope) => {
      if (runtime.phase === 'pre-key' && envelope.type === 'encrypted') {
        rejectModeViolation(runtime, 'encrypted envelope received before key derivation')
        return
      }
      if (runtime.phase === 'keyed' && envelope.type !== 'encrypted') {
        rejectModeViolation(runtime, 'plaintext envelope received after key derivation')
        return
      }
      if (envelope.type === 'rpc-requests') {
        emitRpcRequests(runtime.transport, envelope, 'incoming')
        for (const message of envelope.payload) {
          if ('id' in message) await dispatchRequest(runtime, message)
          else dispatchNotification(runtime, message)
        }
      }
    })

    runtime.transport.on('close', (cause) => {
      if (!runtime.started) return
      runtime.started = false
      clearPending(runtime.transport)
      emitter.emit('close', cause)
    })

    runtime.transport.on('error', (error) => {
      emitter.emit('error', error)
    })
  }

  const routed = Http.composeRouted(transports.filter(isHttpServer))

  async function notify(options: Host.NotifyOptions<string, Rpc.Params>): Promise<void> {
    const targets = runtimes.filter((runtime) => runtime.transport.capabilities.notifications.host)
    if (targets.length === 0)
      throw new Transport.UnsupportedError('no configured transport supports host notifications')
    if (schema) Wata.validateParamsIfKnown(schema, options.method, options.params)
    const envelope = Envelope.rpcRequests([
      Rpc.notification({ method: options.method, params: options.params }),
    ])
    await Promise.all(
      targets.map(async (runtime) => {
        await startRuntime(runtime)
        emitRpcRequests(runtime.transport, envelope, 'outgoing')
        await runtime.transport.send(envelope)
      }),
    )
  }

  // When `meta` + `baseUrl` are both set, wrap routed transport fetch so
  // GET `/.well-known/urpc/host.json`
  // serves the auto-built document and every other request falls
  // through to the underlying transport routes. Transports without
  // `.fetch` can still publish a well-known (the wrapper exposes
  // its own `.fetch` / `.listener` even when nothing else is mounted).
  let httpFetch = routed?.fetch
  let httpListener = routed?.listener
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
    httpListener = wrapped.listener
  }

  return {
    async close(cause) {
      pending.clear()
      for (const runtime of runtimes) runtime.started = false
      await Promise.all(transports.map((transport) => transport.close(cause)))
      emitter.emit('close', cause)
    },
    fetch: httpFetch as Host<schema, transports>['fetch'],
    listener: httpListener as Host<schema, transports>['listener'],
    notify,
    off(type, listener) {
      if (type === 'request') {
        requestListeners.delete(listener as (payload: HostEventMap<schema>['request']) => unknown)
        return
      }
      emitter.off(type, listener)
    },
    on(type, listener) {
      const controller = new AbortController()
      if (type === 'request') {
        requestListeners.add(listener as (payload: HostEventMap<schema>['request']) => unknown)
        controller.signal.addEventListener(
          'abort',
          () => {
            requestListeners.delete(
              listener as (payload: HostEventMap<schema>['request']) => unknown,
            )
          },
          { once: true },
        )
        lazyConnect()
        return controller
      }
      emitter.on(type, listener, { signal: controller.signal })
      lazyConnect()
      return controller
    },
    reject,
    respond,
    role: 'host',
    schema,
    start,
    transports,
  }
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<
    schema extends Schema.Schema | undefined,
    transports extends HostTransports = HostTransports,
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
     * Optional human-facing app metadata. When set together with
     * {@link baseUrl} and {@link privateKey}, `Wata` auto-publishes
     * a `/.well-known/urpc/host.json` off the transport's existing
     * `.fetch` / `.listener`. No separate mount required. The
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

type PendingRequest = {
  request: Rpc.Request
  transport: Transport.Transport<'host', string>
}

function identityFromPrivateKey(privateKey: Hex.Hex): Transport.Identity {
  const publicKey = Base64.fromBytes(Bytes.from(Ed25519.getPublicKey({ privateKey })), {
    pad: false,
    url: true,
  })
  return { privateKey, publicKey }
}

function assertUniqueTransportNames(transports: readonly Transport.Transport[]): void {
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
  transports: readonly Transport.Transport[],
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

function pendingKey(transport: Transport.Transport<'host', string>, id: Rpc.Id): string {
  return JSON.stringify([transport.name, id])
}

function isHttpServer<transport extends Transport.Transport>(
  transport: transport,
): transport is transport & Http.RoutedServer {
  const candidate = transport as Partial<Http.RoutedServer>
  return typeof candidate.fetch === 'function' && typeof candidate.listener === 'function'
}

/**
 * Thrown by {@link Host.respond} / {@link Host.reject} when more than one
 * transport has a pending request with the supplied id. Use the request
 * event's `respond` / `reject` helpers to target the delivering transport.
 */
export class AmbiguousRequestError extends Errors.BaseError {
  override name = 'Wata.AmbiguousRequestError'

  constructor(id: Rpc.Id, transports: readonly string[]) {
    super(`multiple pending requests with id \`${String(id)}\``, {
      details: `matching transports: ${transports.join(', ')}`,
    })
  }
}

/**
 * Thrown by {@link Host.respond} / {@link Host.reject} when no inbound
 * request with the supplied id is currently pending. Means the request
 * was already settled, never received, or the wata has closed.
 */
export class UnknownRequestError extends Errors.BaseError {
  override name = 'Wata.UnknownRequestError'

  constructor(id: Rpc.Id) {
    super(`no pending request with id \`${String(id)}\``)
  }
}
