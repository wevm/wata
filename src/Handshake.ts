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
import * as Events from './core/Events.js'
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
 * Receives the typed payload for the subscribed event directly — the
 * underlying `rettime` `TypedEvent` is unwrapped to keep call sites
 * focused on the data they care about.
 */
export type Listener<payload> = (payload: payload) => unknown

/** Lifecycle events emitted on every `Handshake` (consumer + host). */
export type LifecycleEventMap = {
  /** Emitted after `start()` completes (both consumer and host). */
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
   * Explicitly bring the session up — starts the transport and resolves
   * once it is ready to send and receive frames. Emits `'open'` on success.
   *
   * Optional: {@link Consumer.send} and {@link Consumer.notify} call
   * `start` internally on first use, so most callers can skip it.
   * Reach for it when the open handshake should overlap other work, or
   * when a UI wants to surface the connecting state before any traffic.
   */
  start: () => Promise<void>
  /**
   * Send a typed JSON-RPC request. Auto-{@link Consumer.start}s on
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
   * Send a typed JSON-RPC notification (no response expected).
   * Auto-{@link Consumer.start}s on first use.
   */
  notify: <
    const method extends Consumer.MethodName<schema>,
    const params extends Consumer.ParamsOf<schema, method>,
  >(
    options: Consumer.NotifyOptions<method, params>,
  ) => Promise<void>
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Subscribe to a lifecycle event. Returns an `AbortController` so the
   * subscription can be cancelled (or composed with an external signal).
   */
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
 * await handshake.start()
 * const { result } = await handshake.send({ method: 'ping', params: [] })
 * ```
 */
export function create<const schema extends Schema.Schema | undefined = undefined>(
  options: create.Options<schema>,
): Consumer<schema> {
  const { transport } = options
  const schema = options.schema as schema

  const emitter = Events.create<LifecycleEventMap>()

  const pending = new Map<Rpc.Id, Pending>()
  const methodById = new Map<Rpc.Id, string>()
  // `started` = currently in an active session. After close, drops back
  // to `false`, and the next `send()` / `notify()` lazily re-starts the
  // transport — popups closing externally is a normal end-of-session
  // event, not a permanent handshake failure.
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
      const { code, message: text, data } = message.error
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
            Rpc.error({ id: null, code: -32600, message: 'invalid request', data: reason }),
          ]),
        )
      } catch {
        // Peer may already be unreachable; the teardown below is what matters.
      }
      try {
        await transport.close(error)
      } catch {
        // Same — surface via the local `error` event below regardless.
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
    // Keyed phase: the inverse — any plaintext envelope is rejected
    // because the spec forbids mixing plaintext and ciphertext after
    // keying. Reachable once the AEAD wiring lands; harmless dead code
    // until then because nothing flips `state.phase` to `keyed` yet.
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
    rejectPending(cause ?? new Transport.ClosedError('handshake transport closed'))
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
    role: 'consumer',
    transport,
    schema,
    start,
    async send(opts) {
      if (!state.started) await start()

      const id = opts.id ?? nextId++
      if (schema) validateParamsIfKnown(schema, opts.method, opts.params)

      const deferred = new Promise<SendResult<unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
      methodById.set(id, opts.method)

      try {
        await transport.send(
          Envelope.rpcRequests([Rpc.request({ id, method: opts.method, params: opts.params })]),
        )
      } catch (cause) {
        pending.delete(id)
        methodById.delete(id)
        throw cause
      }

      return (await deferred) as SendResult<Consumer.ResultOf<schema, typeof opts.method>>
    },
    async notify(opts) {
      if (!state.started) await start()
      if (schema) validateParamsIfKnown(schema, opts.method, opts.params)
      await transport.send(
        Envelope.rpcRequests([Rpc.notification({ method: opts.method, params: opts.params })]),
      )
    },
    async close(cause) {
      if (!state.started) return
      state.started = false
      rejectPending(cause ?? new Transport.ClosedError('handshake closed locally'))
      await transport.close(cause)
      emitter.emit('close', cause)
    },
    on(type, listener) {
      const controller = new AbortController()
      emitter.on(type, listener, { signal: controller.signal })
      return controller
    },
    off: emitter.off,
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
