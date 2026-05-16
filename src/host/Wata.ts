/**
 * `wata/host` `Wata` namespace — the host-side public surface.
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
}

/**
 * Distribute over the schema's method names so the `request` payload is a
 * proper discriminated union — narrowing on `event.method` narrows
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
export type HostEventMap<schema extends Schema.Schema | undefined> = Wata.LifecycleEventMap & {
  /** Inbound JSON-RPC notification — fire-and-forget. */
  notification: SchemaNotificationEvent<schema>
  /** Inbound JSON-RPC request — first non-`undefined` listener return wins. */
  request: SchemaRequestEvent<schema>
}

/** Host-side `Wata`. Returned by {@link create}. */
export type Host<
  schema extends Schema.Schema | undefined = undefined,
  transport extends Transport.Transport<'host'> = Transport.Transport<'host'>,
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
  fetch: Http.Handlers<transport>['fetch']
  /** See {@link fetch}. */
  listener: Http.Handlers<transport>['listener']
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
   * Mirror of {@link Host.respond} — resolves once the error response
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
   * Pair with `wata.on('request', (event) => setPending((p) => [...p, event]))`
   * for UI flows where the response is gathered asynchronously (approval
   * dialogs, late confirmations, …) — no need for per-request closures
   * or to return a Promise from the listener.
   *
   * Throws {@link UnknownRequestError} if no request with that id is
   * currently pending (already responded, never received, or the
   * wata is closed).
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
   * Explicitly bring the session up — starts the transport and resolves
   * once it is ready to send and receive frames. Emits `'open'` on success.
   *
   * Optional: {@link Host.on} (and {@link Host.respond} / {@link Host.reject})
   * trigger `start` internally on first use, so most hosts can skip it.
   * Reach for it when a UI wants to surface the connecting state before
   * any request lands, or when start-time errors should reject up-front.
   */
  start: () => Promise<void>
  /** The wrapped transport. */
  transport: transport
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
 * Create a host-side {@link Host} `Wata` around a transport.
 *
 * @example
 * Synchronous answer from inside the listener.
 * ```ts
 * import { Wata } from 'wata/host'
 *
 * const wata = Wata.create({ transport })
 * await wata.start()
 * wata.on('request', (event) => {
 *   if (event.method === 'ping') event.respond({ ok: true })
 * })
 * ```
 *
 * @example
 * Late answer by id (UI / approval flows). `Wata.on` lazy-connects
 * the transport on first call, so an explicit `start()` is optional.
 * ```ts
 * const wata = Wata.create({ transport })
 *
 * wata.on('request', (event) => {
 *   setPending((prev) => [...prev, event])
 * })
 *
 * // Later, when the user clicks "approve":
 * wata.respond(event.id, { ok: true })
 * ```
 */
export function create<
  const schema extends Schema.Schema | undefined = undefined,
  const transport extends Transport.Transport<'host'> = Transport.Transport<'host'>,
>(options: create.Options<schema, transport>): Host<schema, transport> {
  const transport = options.transport as transport
  const schema = options.schema as schema
  const { baseUrl, meta, identity_pubkey } = options

  if (meta && !baseUrl)
    throw new Errors.BaseError('`baseUrl` is required when `meta` is set', {
      details: 'host_id and transport bindings need a fully-qualified origin',
    })
  if (meta && !identity_pubkey)
    throw new Errors.BaseError('`identity_pubkey` is required when `meta` is set', {
      details:
        'host.json publishes the long-term Ed25519 identity pubkey (unpadded base64url, 43 chars)',
    })
  // Lazy-inject the parent baseUrl / meta into the transport so
  // HTTP-server-shaped adapters (e.g. host `deviceCode`) can
  // populate `verification_uri` from a single app-wide value.
  if (baseUrl) transport.bindBaseUrl?.(baseUrl)
  if (meta) transport.bindMeta?.(meta)

  const emitter = Events.create<HostEventMap<schema>>()
  // User-supplied `request` listeners, in registration order. The
  // `request` dispatch loop iterates these directly so it can capture
  // each listener's return value (and thrown error) for the
  // first-non-undefined-wins resolution semantics. Tracked here rather
  // than via `emitter.on('request', ...)` because the wrapper swallows
  // listener errors and never surfaces return values back to the caller.
  const requestListeners = new Set<Wata.Listener<HostEventMap<schema>['request']>>()

  // `started` = currently in an active session. After close (peer popup
  // closes, transport tears down, …) drops back to `false`, and the
  // next `lazyConnect()` / `start()` re-acquires the transport.
  //
  // `phase` enforces the spec §7 mode-discipline gate: while `pre-key`,
  // any inbound `encrypted` envelope is rejected with JSON-RPC `-32600`
  // and the session is torn down. Once the AEAD layer flips it to
  // `keyed` (future commit, when key derivation lands), the inverse
  // rule kicks in — any inbound plaintext envelope is rejected the same
  // way. The transition is one-way; never reverts.
  type State = { phase: 'pre-key' | 'keyed'; started: boolean }
  const state: State = {
    phase: 'pre-key',
    started: false,
  }
  const pending = new Map<Rpc.Id, PendingRequest>()

  /**
   * Returns the in-flight send Promise so callers that need to know
   * the response actually flushed (popup hosts closing the window,
   * worker hosts terminating, etc.) can `await` it. Resolves with
   * `false` when no pending request matched `id`.
   */
  function settle(id: Rpc.Id, response: Rpc.Response): Promise<boolean> {
    const entry = pending.get(id)
    if (!entry) return Promise.resolve(false)
    pending.delete(id)
    return safeSend(transport, [response]).then(() => true)
  }

  async function respond(id: Rpc.Id, result: unknown): Promise<void> {
    const ok = await settle(id, Rpc.success({ id, result }))
    if (!ok) throw new UnknownRequestError(id)
  }

  async function reject(id: Rpc.Id, error: reject.Error): Promise<void> {
    const { code, message, data } = error
    const ok = await settle(id, Rpc.error({ id, code, message, data }))
    if (!ok) throw new UnknownRequestError(id)
  }

  let startPromise: Promise<void> | undefined

  function start(): Promise<void> {
    if (state.started) return Promise.resolve()
    if (!startPromise) {
      startPromise = transport
        .start()
        .then(() => {
          state.started = true
          emitter.emit('open', undefined)
        })
        .finally(() => {
          startPromise = undefined
        })
    }
    return startPromise
  }

  function lazyConnect(): void {
    if (state.started) return
    void start().catch((error: Error) => emitter.emit('error', error))
  }

  async function dispatchRequest(request: Rpc.Request) {
    if (schema) {
      try {
        Wata.validateParamsIfKnown(schema, request.method, request.params)
      } catch (cause) {
        await safeSend(transport, [
          Rpc.error({
            id: request.id,
            code: -32602,
            message: 'invalid params',
            data: (cause as Error).message,
          }),
        ])
        return
      }
    }

    // No listener has any chance of answering this request — fall through
    // to JSON-RPC `method not found` so the consumer doesn't hang.
    if (requestListeners.size === 0) {
      await safeSend(transport, [
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
    pending.set(request.id, { request })

    const payload = {
      id: request.id,
      method: request.method,
      params: request.params,
      reject: (rpcError: { code: number; data?: unknown; message: string }) =>
        settle(
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
        settle(request.id, Rpc.success({ id: request.id, result })).then(() => undefined),
    } as HostEventMap<schema>['request']

    // Iterate the user-registered listeners directly so we can capture
    // each one's outcome (return value or thrown error). Snapshot first
    // because a listener may unsubscribe siblings during dispatch.
    const snapshot = Array.from(requestListeners)
    let firstError: Error | undefined
    for (const listener of snapshot) {
      if (!pending.has(request.id)) break
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
          await settle(request.id, Rpc.success({ id: request.id, result: resolved }))
          break
        }
      } catch (cause) {
        firstError ??= cause as Error
      }
    }

    if (pending.has(request.id) && firstError) {
      if (firstError instanceof Rpc.RpcError)
        await settle(
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

  function dispatchNotification(message: Rpc.Notification) {
    if (schema) {
      try {
        Wata.validateParamsIfKnown(schema, message.method, message.params)
      } catch (cause) {
        emitter.emit('error', cause as Error)
        return
      }
    }
    emitter.emit('notification', {
      method: message.method,
      notification: message,
      params: message.params,
    } as HostEventMap<schema>['notification'])
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
      await safeSend(transport, [
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

  transport.on('message', async (envelope) => {
    // Pre-key phase: encrypted frames are not yet allowed (the AEAD
    // layer has not derived keys for this session). Spec §7 mandates
    // a JSON-RPC `-32600` response and immediate teardown.
    if (state.phase === 'pre-key' && envelope.type === 'encrypted') {
      rejectModeViolation('encrypted envelope received before key derivation')
      return
    }
    // Keyed phase: the inverse — any plaintext envelope is rejected
    // because the spec forbids mixing plaintext and ciphertext after
    // keying. Reachable once the AEAD wiring lands; harmless dead code
    // until then because nothing flips `state.phase` to `keyed` yet.
    if (state.phase === 'keyed' && envelope.type !== 'encrypted') {
      rejectModeViolation('plaintext envelope received after key derivation')
      return
    }
    if (envelope.type === 'rpc-requests') {
      for (const message of envelope.payload) {
        if ('id' in message) await dispatchRequest(message)
        else dispatchNotification(message)
      }
      return
    }
    // `rpc-responses`, `ready`, `hello` are not currently routed into
    // the host-side surface; ignored.
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

  // HTTP-shaped transports (e.g. `deviceCode`) augment the base
  // `Transport.Transport<'host'>` with `.fetch` / `.listener` so the
  // host can be served directly. Forward those references onto the
  // `Wata` instance so callers can write `createServer(wata.listener)`
  // instead of reaching through `wata.transport.listener`. The
  // conditional `Host` type collapses these to `undefined` when the
  // wrapped transport doesn't carry them.
  type HttpHandlers = {
    fetch?: (request: Request) => Promise<Response>
    listener?: (req: unknown, res: unknown) => void
  }
  const http = transport as HttpHandlers

  // When `meta` + `baseUrl` are both set, wrap `transport.fetch` /
  // `transport.listener` so GET `/.well-known/urpc/host.json`
  // serves the auto-built document and every other request falls
  // through to the underlying transport routes. Transports without
  // `.fetch` can still publish a well-known (the wrapper exposes
  // its own `.fetch` / `.listener` even when nothing else is mounted).
  let httpFetch = http.fetch
  let httpListener = http.listener
  if (meta && baseUrl && identity_pubkey) {
    const document = Wellknown.buildHostDocument({
      baseUrl,
      identity_pubkey,
      meta,
      transports: collectTransports(transport, baseUrl),
    })
    const wrapped = Wellknown.wrapFetch({
      base: http.fetch
        ? { fetch: http.fetch.bind(http) as (request: Request) => Promise<Response> }
        : undefined,
      document,
      wellknownPath: Wellknown.hostPath,
    })
    httpFetch = wrapped.fetch
    httpListener = wrapped.listener
  }

  return {
    async close(cause) {
      if (!state.started) return
      state.started = false
      pending.clear()
      await transport.close(cause)
      emitter.emit('close', cause)
    },
    fetch: httpFetch as Host<schema, transport>['fetch'],
    listener: httpListener as Host<schema, transport>['listener'],
    off(type, listener) {
      if (type === 'request') {
        requestListeners.delete(listener as Wata.Listener<HostEventMap<schema>['request']>)
        return
      }
      emitter.off(type, listener)
    },
    on(type, listener) {
      lazyConnect()
      const controller = new AbortController()
      if (type === 'request') {
        requestListeners.add(listener as Wata.Listener<HostEventMap<schema>['request']>)
        controller.signal.addEventListener(
          'abort',
          () => {
            requestListeners.delete(listener as Wata.Listener<HostEventMap<schema>['request']>)
          },
          { once: true },
        )
        return controller
      }
      emitter.on(type, listener, { signal: controller.signal })
      return controller
    },
    reject,
    respond,
    role: 'host',
    schema,
    start,
    transport,
  }
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<
    schema extends Schema.Schema | undefined,
    transport extends Transport.Transport<'host'> = Transport.Transport<'host'>,
  > = {
    /**
     * Public origin of the host (e.g. `https://wallet.example`).
     * Lifted to the `Wata.create` root because it's an app-wide
     * concept — every transport on this `Wata` shares the same origin.
     * Lazy-injected into transports that need it via
     * {@link Transport.Transport.bindBaseUrl}.
     *
     * REQUIRED when {@link meta} is supplied (we need it to build
     * `host_id` and the transport bindings in the published
     * `host.json`). Optional otherwise.
     */
    baseUrl?: string | undefined
    /**
     * Host's long-term Ed25519 identity public key, **unpadded base64url**
     * (32 raw bytes → 43 characters). REQUIRED per [uRPC `discovery.md`
     * §2.2](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md)
     * whenever {@link meta} + {@link baseUrl} are set (i.e. whenever
     * `Wata` auto-publishes `/.well-known/urpc/host.json`).
     */
    identity_pubkey?: string | undefined
    /**
     * Optional human-facing app metadata. When set together with
     * {@link baseUrl} and {@link identity_pubkey}, `Wata` auto-publishes
     * a `/.well-known/urpc/host.json` off the transport's existing
     * `.fetch` / `.listener` — no separate mount required. The
     * published doc's `transports` map is auto-built from the
     * transport's {@link Transport.Transport.discovery} binding.
     * Lazy-injected into transports that opt into
     * {@link Transport.Transport.bindMeta}.
     */
    meta?: Discovery.Meta | undefined
    /** Optional method-registry schema (typed `'request'` / `'notification'` payloads). */
    schema?: schema | undefined
    /** Host-role transport this wata wraps. */
    transport: transport
  }
}

type PendingRequest = {
  request: Rpc.Request
}

/**
 * Collect the per-transport `transports` map entries the wrapping
 * `Wata.create({ baseUrl, meta })` publishes in `host.json`. Walks
 * the single bound transport (and any nested HTTP-shaped sub-transports
 * a future composite adapter might expose) and asks each one to
 * contribute its discovery binding for `baseUrl`.
 *
 * @internal
 */
export function collectTransports(
  transport: Transport.Transport,
  baseUrl: string,
): Record<string, unknown> {
  const transports: Record<string, unknown> = {}
  const discovery = transport.discovery
  if (discovery) transports[discovery.id] = discovery.binding(baseUrl)
  return transports
}

async function safeSend(
  transport: Transport.Transport,
  responses: ReadonlyArray<Rpc.Response>,
): Promise<void> {
  try {
    await transport.send(Envelope.rpcResponses(responses))
  } catch {
    // The transport surfaces its own error to listeners; swallow here so
    // the host loop doesn't blow up after a peer disconnect.
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
