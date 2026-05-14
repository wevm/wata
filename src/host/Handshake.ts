/**
 * `handshakes/host` `Handshake` namespace — the host-side public surface.
 *
 * `Handshake.create` here always returns a {@link Host}. To create a
 * consumer, import from `handshakes` instead. Shared types
 * (`SendResult`, `Listener`, `LifecycleEventMap`, `BootstrapRequiredError`)
 * live on the consumer-side `Handshake` namespace at `handshakes`; reach
 * for them there when you need to type both sides in the same module.
 *
 * Host-only types ({@link RequestEvent}, {@link NotificationEvent},
 * {@link Host}, {@link HostEventMap}) live in this file so they don't
 * pollute the consumer namespace.
 */

import * as Envelope from '../core/Envelope.js'
import * as Errors from '../core/Errors.js'
import * as Events from '../core/Events.js'
import * as Rpc from '../core/Rpc.js'
import * as Schema from '../core/Schema.js'
import * as Transport from '../core/Transport.js'
import * as Handshake from '../Handshake.js'

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
  /** Method name. Top-level discriminator for schema-narrowed listeners. */
  method: method
  /** Method params. */
  params: params
  /** Id of the JSON-RPC request being answered. */
  id: Rpc.Id
  /** The full JSON-RPC request envelope as parsed off the wire. */
  request: Rpc.Request<method, params>
  /**
   * Sugar for `handshake.respond(event.id, result)`. Settles the request
   * synchronously from inside the listener; idempotent across
   * `event.respond` / `event.reject` / `handshake.respond` / `handshake.reject`.
   */
  respond: (result: result) => void
  /** Sugar for `handshake.reject(event.id, error)`. Idempotent. */
  reject: (error: { code: number; message: string; data?: unknown }) => void
}

/** Event payload delivered to host `'notification'` listeners. */
export type NotificationEvent<
  method extends string = string,
  params extends Rpc.Params = Rpc.Params,
> = {
  /** Method name. Top-level discriminator for schema-narrowed listeners. */
  method: method
  /** Notification params. */
  params: params
  /** The full JSON-RPC notification envelope as parsed off the wire. */
  notification: Rpc.Notification<method, params>
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
export type HostEventMap<schema extends Schema.Schema | undefined> = Handshake.LifecycleEventMap & {
  /** Inbound JSON-RPC request — first non-`undefined` listener return wins. */
  request: SchemaRequestEvent<schema>
  /** Inbound JSON-RPC notification — fire-and-forget. */
  notification: SchemaNotificationEvent<schema>
}

/** Host-side `Handshake`. Returned by {@link create}. */
export type Host<schema extends Schema.Schema | undefined = undefined> = {
  /** Side of the protocol this handshake speaks for. */
  role: 'host'
  /** The wrapped transport. */
  transport: Transport.Transport<'host'>
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
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Settle a still-pending inbound request by id with a JSON-RPC `result`.
   *
   * Pair with `handshake.on('request', (event) => setPending((p) => [...p, event]))`
   * for UI flows where the response is gathered asynchronously (approval
   * dialogs, late confirmations, …) — no need for per-request closures
   * or to return a Promise from the listener.
   *
   * Throws {@link UnknownRequestError} if no request with that id is
   * currently pending (already responded, never received, or the
   * handshake is closed).
   *
   * @param id - Id of the pending request to settle.
   * @param result - Success `result` payload to send.
   */
  respond: <result = unknown>(id: Rpc.Id, result: result) => void
  /**
   * Settle a still-pending inbound request by id with a JSON-RPC error.
   * Mirror of {@link Host.respond}.
   *
   * @param id - Id of the pending request to settle.
   * @param error - JSON-RPC error envelope (`code` + `message`, optional `data`).
   */
  reject: (id: Rpc.Id, error: reject.Error) => void
  /**
   * Subscribe to a host event. Returns an `AbortController` so the
   * subscription can be cancelled (or composed with an external signal).
   *
   * Lazy-connects the transport on first call, so most hosts never need
   * to call {@link Host.start} explicitly.
   */
  on: <type extends keyof HostEventMap<schema>>(
    type: type,
    listener: Handshake.Listener<HostEventMap<schema>[type]>,
  ) => AbortController
  /** Remove a previously subscribed listener. */
  off: <type extends keyof HostEventMap<schema>>(
    type: type,
    listener: Handshake.Listener<HostEventMap<schema>[type]>,
  ) => void
}

export declare namespace reject {
  /** Error payload accepted by {@link Host.reject} / `event.reject`. */
  type Error = {
    /** JSON-RPC error code. */
    code: number
    /** JSON-RPC error message. */
    message: string
    /** Optional JSON-RPC error `data` payload. */
    data?: unknown | undefined
  }
}

/**
 * Create a host-side {@link Host} `Handshake` around a transport.
 *
 * @example
 * Synchronous answer from inside the listener.
 * ```ts
 * import { Handshake } from 'handshakes/host'
 *
 * const handshake = Handshake.create({ transport })
 * await handshake.start()
 * handshake.on('request', (event) => {
 *   if (event.method === 'ping') event.respond({ ok: true })
 * })
 * ```
 *
 * @example
 * Late answer by id (UI / approval flows). `Handshake.on` lazy-connects
 * the transport on first call, so an explicit `start()` is optional.
 * ```ts
 * const handshake = Handshake.create({ transport })
 *
 * handshake.on('request', (event) => {
 *   setPending((prev) => [...prev, event])
 * })
 *
 * // Later, when the user clicks "approve":
 * handshake.respond(event.id, { ok: true })
 * ```
 */
export function create<const schema extends Schema.Schema | undefined = undefined>(
  options: create.Options<schema>,
): Host<schema> {
  const { transport } = options
  const schema = options.schema as schema

  const emitter = Events.create<HostEventMap<schema>>()
  // User-supplied `request` listeners, in registration order. The
  // `request` dispatch loop iterates these directly so it can capture
  // each listener's return value (and thrown error) for the
  // first-non-undefined-wins resolution semantics. Tracked here rather
  // than via `emitter.on('request', ...)` because the wrapper swallows
  // listener errors and never surfaces return values back to the caller.
  const requestListeners = new Set<Handshake.Listener<HostEventMap<schema>['request']>>()

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
  const state: { started: boolean; phase: 'pre-key' | 'keyed' } = {
    started: false,
    phase: 'pre-key',
  }
  const pending = new Map<Rpc.Id, PendingRequest>()

  function settle(id: Rpc.Id, response: Rpc.Response): boolean {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    void safeSend(transport, [response])
    return true
  }

  function respond(id: Rpc.Id, result: unknown): void {
    const ok = settle(id, Rpc.success({ id, result }))
    if (!ok) throw new UnknownRequestError(id)
  }

  function reject(id: Rpc.Id, error: reject.Error): void {
    const { code, message, data } = error
    const ok = settle(id, Rpc.error({ id, code, message, data }))
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
        Handshake.validateParamsIfKnown(schema, request.method, request.params)
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
          id: request.id,
          code: -32601,
          message: 'method not found',
          data: request.method,
        }),
      ])
      return
    }

    // Track the request so `event.respond` / `event.reject` and the
    // top-level `handshake.respond` / `handshake.reject` can all settle
    // by id. The entry stays in `pending` until a listener answers
    // (now or later) or the handshake closes.
    pending.set(request.id, { request })

    const payload = {
      method: request.method,
      params: request.params,
      id: request.id,
      request,
      respond: (result: unknown) => {
        settle(request.id, Rpc.success({ id: request.id, result }))
      },
      reject: (rpcError: { code: number; message: string; data?: unknown }) => {
        settle(
          request.id,
          Rpc.error({
            id: request.id,
            code: rpcError.code,
            message: rpcError.message,
            data: rpcError.data,
          }),
        )
      },
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
          settle(request.id, Rpc.success({ id: request.id, result: resolved }))
          break
        }
      } catch (cause) {
        firstError ??= cause as Error
      }
    }

    if (pending.has(request.id) && firstError) {
      if (firstError instanceof Rpc.RpcError)
        settle(
          request.id,
          Rpc.error({
            id: request.id,
            code: firstError.code,
            message: firstError.message,
            data: firstError.data,
          }),
        )
      else
        settle(
          request.id,
          Rpc.error({
            id: request.id,
            code: -32603,
            message: 'internal error',
            data: firstError.message,
          }),
        )
    }

    // Otherwise: the request stays pending. A listener acknowledged it
    // by being registered, so the host trusts the application to settle
    // later via `handshake.respond(id, ...)` / `handshake.reject(id, ...)`.
  }

  function dispatchNotification(message: Rpc.Notification) {
    if (schema) {
      try {
        Handshake.validateParamsIfKnown(schema, message.method, message.params)
      } catch (cause) {
        emitter.emit('error', cause as Error)
        return
      }
    }
    emitter.emit('notification', {
      method: message.method,
      params: message.params,
      notification: message,
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
        Rpc.error({ id: null, code: -32600, message: 'invalid request', data: reason }),
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

  return {
    role: 'host',
    transport,
    schema,
    start,
    async close(cause) {
      if (!state.started) return
      state.started = false
      pending.clear()
      await transport.close(cause)
      emitter.emit('close', cause)
    },
    respond,
    reject,
    on(type, listener) {
      lazyConnect()
      const controller = new AbortController()
      if (type === 'request') {
        requestListeners.add(listener as Handshake.Listener<HostEventMap<schema>['request']>)
        controller.signal.addEventListener(
          'abort',
          () => {
            requestListeners.delete(
              listener as Handshake.Listener<HostEventMap<schema>['request']>,
            )
          },
          { once: true },
        )
        return controller
      }
      emitter.on(type, listener, { signal: controller.signal })
      return controller
    },
    off(type, listener) {
      if (type === 'request') {
        requestListeners.delete(listener as Handshake.Listener<HostEventMap<schema>['request']>)
        return
      }
      emitter.off(type, listener)
    },
  }
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<schema extends Schema.Schema | undefined> = {
    /** Host-role transport this handshake wraps. */
    transport: Transport.Transport<'host'>
    /** Optional method-registry schema (typed `'request'` / `'notification'` payloads). */
    schema?: schema | undefined
  }
}

type PendingRequest = {
  request: Rpc.Request
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
 * was already settled, never received, or the handshake has closed.
 */
export class UnknownRequestError extends Errors.BaseError {
  override name = 'Handshake.UnknownRequestError'

  constructor(id: Rpc.Id) {
    super(`no pending request with id \`${String(id)}\``)
  }
}
