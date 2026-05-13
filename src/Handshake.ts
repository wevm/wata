/**
 * `handshakes` `Handshake` namespace — the consumer-side public surface
 * plus the shared types both sides re-export.
 *
 * `Handshake.create` here always returns a {@link Consumer}. To create a
 * host, import from `handshakes/host` (where `Handshake.create` returns a
 * {@link Host}). Splitting per-side keeps the return type a literal
 * narrowing rather than a `transport['role'] extends 'consumer' ?
 * Consumer : Host` conditional, which gives editors and type-error
 * messages the right shape immediately.
 *
 * Shared types (lifecycle event map, listener signature, send result) live
 * in this file and are re-exported verbatim from
 * {@link "./host/Handshake"} so user code can reach them from either side.
 *
 * Phase 1 ships the minimum vertical slice — enough to drive the `window`
 * transport end-to-end through real `postMessage`. AEAD, batched requests,
 * and discovery-aware bootstrap land in later phases (see `tasks/PLAN.md`).
 */

import * as Envelope from './core/Envelope.js'
import * as Errors from './core/Errors.js'
import * as Rpc from './core/Rpc.js'
import * as Schema from './core/Schema.js'
import * as Transport from './core/Transport.js'

/**
 * Result of a single {@link Consumer.send} call. We return `{ id, result }`
 * (rather than the bare `result`) so callers can correlate with logs and
 * future batch/trace tooling without losing the JSON-RPC identity.
 */
export type SendResult<result> = {
  /** Id of the JSON-RPC request that produced this response. */
  id: Rpc.Id
  /** Decoded `result` payload from the host's success response. */
  result: result
}

/**
 * Listener supplied to {@link Consumer.on} (and to {@link "./host/Handshake".Host.on}).
 * Receives the typed payload for the subscribed event.
 */
export type Listener<payload> = (payload: payload) => unknown

/** Lifecycle events emitted on every `Handshake` (consumer + host). */
export type LifecycleEventMap = {
  /** Emitted after `bootstrap()` (consumer) / `connect()` (host) completes. */
  open: void
  /** Emitted exactly once when the session closes, cleanly or with cause. */
  close: Error | undefined
  /** Emitted when the transport surfaces an error (network, parse, AEAD). */
  error: Error
}

/**
 * Consumer-side `Handshake`. Returned by {@link create}.
 */
export type Consumer<schema extends Schema.Schema | undefined = undefined> = {
  /** Side of the protocol this handshake speaks for. */
  role: 'consumer'
  /** The wrapped transport. */
  transport: Transport.Transport<'consumer'>
  /** Optional method-registry schema flowed through `send` / `notify`. */
  schema: schema
  /**
   * Bring the session up. Starts the transport and resolves once it is
   * ready to send and receive frames. Emits `'open'` on success.
   */
  bootstrap: () => Promise<void>
  /**
   * Send a typed JSON-RPC request. Resolves with the host's `result` (or
   * rejects with {@link Rpc.RpcError} if the host returned an error
   * response).
   */
  send: <
    const method extends Consumer.MethodName<schema>,
    const params extends Consumer.ParamsOf<schema, method>,
  >(
    options: Consumer.SendOptions<method, params>,
  ) => Promise<SendResult<Consumer.ResultOf<schema, method>>>
  /** Send a typed JSON-RPC notification (no response expected). */
  notify: <
    const method extends Consumer.MethodName<schema>,
    const params extends Consumer.ParamsOf<schema, method>,
  >(
    options: Consumer.NotifyOptions<method, params>,
  ) => Promise<void>
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /** Subscribe to a lifecycle event. Returns an `AbortController`. */
  on: <type extends keyof LifecycleEventMap>(
    type: type,
    listener: Listener<LifecycleEventMap[type]>,
  ) => AbortController
  /** Remove a previously subscribed listener. */
  off: <type extends keyof LifecycleEventMap>(
    type: type,
    listener: Listener<LifecycleEventMap[type]>,
  ) => void
}

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
    /** Method name. Narrowed against the schema when one was supplied. */
    method: method
    /** Method params. Narrowed against the schema when one was supplied. */
    params: params
    /** Optional explicit request id. Defaults to a monotonically-increasing number. */
    id?: Rpc.Id | undefined
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
 * Create a consumer-side {@link Consumer} `Handshake` around a transport.
 *
 * @example
 * ```ts
 * import { Handshake, loopback } from 'handshakes'
 *
 * const { consumer } = loopback()
 * const handshake = Handshake.create({ transport: consumer })
 *
 * await handshake.bootstrap()
 * const { result } = await handshake.send({ method: 'ping', params: [] })
 * ```
 */
export function create<const schema extends Schema.Schema | undefined = undefined>(
  options: create.Options<schema>,
): Consumer<schema> {
  const { transport } = options
  const schema = options.schema as schema

  const bus = createBus<LifecycleEventMap>()
  const pending = new Map<Rpc.Id, Pending>()
  const methodById = new Map<Rpc.Id, string>()
  const state = { started: false, closed: false }
  let nextId = 1

  function rejectPending(cause: Error) {
    for (const [, deferred] of pending) deferred.reject(cause)
    pending.clear()
    methodById.clear()
  }

  transport.onMessage((envelope) => {
    if (envelope.type !== 'plain') {
      bus.emit(
        'error',
        new Errors.ProtocolError('consumer received an encrypted envelope on a plain transport'),
      )
      return
    }
    let message: Rpc.Envelope
    try {
      message = Rpc.parse(envelope.payload)
    } catch (cause) {
      bus.emit('error', cause as Error)
      return
    }
    if ('error' in message) {
      const id = message.id
      if (id === null) return
      const deferred = pending.get(id)
      if (!deferred) return
      pending.delete(id)
      methodById.delete(id)
      const { code, message: text, data } = message.error
      deferred.reject(new Rpc.RpcError(text, { code, data }))
      return
    }
    if ('result' in message) {
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
  })

  transport.onClose((cause) => {
    if (state.closed) return
    state.closed = true
    rejectPending(cause ?? new Transport.ClosedError('handshake transport closed'))
    bus.emit('close', cause)
  })

  transport.onError((error) => {
    bus.emit('error', error)
  })

  return {
    role: 'consumer',
    transport,
    schema,
    async bootstrap() {
      if (state.closed) throw new Transport.ClosedError('handshake already closed')
      if (state.started) return
      state.started = true
      await transport.start()
      bus.emit('open', undefined)
    },
    async send(opts) {
      if (state.closed) throw new Transport.ClosedError('handshake already closed')
      if (!state.started) throw new BootstrapRequiredError('call `bootstrap()` before `send()`')

      const id = opts.id ?? nextId++
      if (schema) validateParamsIfKnown(schema, opts.method, opts.params)

      const deferred = new Promise<SendResult<unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
      methodById.set(id, opts.method)

      try {
        await transport.send(
          Envelope.plain(Rpc.request({ id, method: opts.method, params: opts.params })),
        )
      } catch (cause) {
        pending.delete(id)
        methodById.delete(id)
        throw cause
      }

      return (await deferred) as SendResult<Consumer.ResultOf<schema, typeof opts.method>>
    },
    async notify(opts) {
      if (state.closed) throw new Transport.ClosedError('handshake already closed')
      if (!state.started) throw new BootstrapRequiredError('call `bootstrap()` before `notify()`')
      if (schema) validateParamsIfKnown(schema, opts.method, opts.params)
      await transport.send(
        Envelope.plain(Rpc.notification({ method: opts.method, params: opts.params })),
      )
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
      rejectPending(cause ?? new Transport.ClosedError('handshake closed locally'))
      await transport.close(cause)
      bus.emit('close', cause)
    },
    on: bus.on,
    off: bus.off,
  }
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<schema extends Schema.Schema | undefined> = {
    /** Consumer-role transport this handshake wraps. */
    transport: Transport.Transport<'consumer'>
    /** Optional method-registry schema (typed `send` / `notify` payloads). */
    schema?: schema | undefined
  }
}

type Pending = {
  resolve: (result: SendResult<unknown>) => void
  reject: (error: Error) => void
}

/**
 * Outcome of a single listener invocation — value when it returned, error
 * when it threw. Used by both consumer and host event loops to decide
 * ordering (the host's "first non-`undefined` listener wins" dispatch
 * loop relies on this).
 */
export type ListenerOutcome = { kind: 'value'; value: unknown } | { kind: 'error'; error: Error }

/** Event-bus contract used internally by both consumer and host handshakes. */
export type EventBus<map> = {
  on: <type extends keyof map>(type: type, listener: Listener<map[type]>) => AbortController
  off: <type extends keyof map>(type: type, listener: Listener<map[type]>) => void
  /**
   * Invoke every listener for `type` synchronously. Each listener's
   * return value (or thrown `Error`) is captured into a
   * {@link ListenerOutcome} so the caller can decide ordering.
   */
  emit: <type extends keyof map>(type: type, payload: map[type]) => readonly ListenerOutcome[]
}

/**
 * Create a typed event bus. Re-used by both consumer and host handshakes;
 * exported so the host module in `src/host/Handshake.ts` can build its
 * own bus without duplicating the implementation.
 *
 * @internal
 */
export function createBus<map extends Record<string, unknown>>(): EventBus<map> {
  const listeners = new Map<keyof map, Set<Listener<unknown>>>()
  return {
    on(type, listener) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener as Listener<unknown>)
      const controller = new AbortController()
      controller.signal.addEventListener(
        'abort',
        () => {
          listeners.get(type)?.delete(listener as Listener<unknown>)
        },
        { once: true },
      )
      return controller
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener as Listener<unknown>)
    },
    emit(type, payload) {
      const set = listeners.get(type)
      if (!set || set.size === 0) return []
      const outcomes: ListenerOutcome[] = []
      // Snapshot via Array.from so listeners that unsubscribe (or subscribe
      // siblings) during dispatch don't mutate the iterator under us.
      for (const listener of Array.from(set)) {
        try {
          outcomes.push({ kind: 'value', value: listener(payload) })
        } catch (error) {
          outcomes.push({ kind: 'error', error: error as Error })
        }
      }
      return outcomes
    },
  }
}

/**
 * Validate inbound `params` against the schema entry for `method` if one
 * exists. Used by both sides — consumer validates outbound calls before
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

/**
 * Thrown when a {@link Consumer.send} or {@link Consumer.notify} call is
 * made before {@link Consumer.bootstrap} has resolved. The transport is
 * not started yet, so there's no wire to write to.
 */
export class BootstrapRequiredError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'Handshake.BootstrapRequiredError'
}
