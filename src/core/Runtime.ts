/**
 * Runtime-only WATA sessions.
 *
 * `Runtime.create` owns the protocol session machinery: transport
 * lifecycle, JSON-RPC request/response dispatch, schema validation, and
 * event fan-out. It deliberately does not bind app metadata, publish
 * discovery, compose HTTP routes, or expose Node/server adapters.
 */

import type * as HostWata from '../host/Wata.js'
import type * as Wata from '../Wata.js'
import * as Envelope from './Envelope.js'
import * as Errors from './Errors.js'
import * as Events from './Events.js'
import * as Rpc from './Rpc.js'
import * as Schema from './Schema.js'
import * as SchemaRuntime from './SchemaRuntime.js'
import * as Transport from './Transport.js'

/** Consumer runtime without high-level HTTP/discovery handlers. */
export type Consumer<
  schema extends Schema.Schema | undefined = undefined,
  transports extends Wata.ConsumerTransports = Wata.SingleConsumerTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = ConsumerBase<schema, transports, context> &
  (transports extends readonly [
    infer transport extends Transport.Transport<'consumer', string, unknown>,
  ]
    ? Wata.ConsumerSession<schema, transport, context>
    : Wata.ConsumerChildMap<schema, transports, context>)

/** Consumer runtime surface shared by single and multi-transport instances. */
export type ConsumerBase<
  schema extends Schema.Schema | undefined,
  transports extends Wata.ConsumerTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = Omit<Wata.ConsumerBase<schema, transports, context>, 'fetch'>

/** Host runtime without high-level HTTP/discovery handlers. */
export type Host<
  schema extends Schema.Schema | undefined = undefined,
  transports extends HostWata.HostTransports = HostWata.HostTransports,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = Omit<HostWata.Host<schema, transports, context>, 'fetch'>

/** Create a runtime-only consumer or host session. */
export function create<
  const schema extends Schema.Schema | undefined = undefined,
  const transports extends Wata.ConsumerTransports = Wata.SingleConsumerTransports,
  const context extends Schema.Context | undefined = undefined,
>(
  options: create.ConsumerOptions<schema, transports, context>,
): Consumer<schema, transports, Wata.RequestContextOf<context>>
export function create<
  const schema extends Schema.Schema | undefined = undefined,
  const transports extends HostWata.HostTransports = HostWata.HostTransports,
  const context extends Schema.Context | undefined = undefined,
>(
  options: create.HostOptions<schema, transports, context>,
): Host<schema, transports, Wata.RequestContextOf<context>>
export function create(options: create.Options): unknown {
  const [transport] = options.transports
  if (transport.role === 'consumer')
    return createConsumer(options as create.ConsumerOptions) as unknown as Consumer<
      Schema.Schema | undefined,
      Wata.ConsumerTransports
    >
  return createHost(options as create.HostOptions)
}

export declare namespace create {
  /** Options for a consumer runtime. */
  type ConsumerOptions<
    schema extends Schema.Schema | undefined = Schema.Schema | undefined,
    transports extends Wata.ConsumerTransports = Wata.ConsumerTransports,
    context extends Schema.Context | undefined = Schema.Context | undefined,
  > = {
    /** Optional Wata-wide schema for per-request context metadata. */
    context?: context | undefined
    /** Optional method-registry schema (typed `send` / `notify` payloads). */
    schema?: schema | undefined
    /** Consumer-role transports this runtime wraps. */
    transports: transports
  }

  /** Options for a host runtime. */
  type HostOptions<
    schema extends Schema.Schema | undefined = Schema.Schema | undefined,
    transports extends HostWata.HostTransports = HostWata.HostTransports,
    context extends Schema.Context | undefined = Schema.Context | undefined,
  > = {
    /** Optional Wata-wide schema for per-request context metadata. */
    context?: context | undefined
    /** Optional method-registry schema (typed `'request'` / `'notification'` payloads). */
    schema?: schema | undefined
    /** Host-role transports this runtime wraps. */
    transports: transports
  }

  /** Runtime options for either side. */
  type Options = ConsumerOptions | HostOptions
}

function createConsumer<
  const schema extends Schema.Schema | undefined = undefined,
  const transports extends Wata.ConsumerTransports = Wata.SingleConsumerTransports,
  const context extends Schema.Context | undefined = undefined,
>(
  options: create.ConsumerOptions<schema, transports, context>,
): Consumer<schema, transports, Wata.RequestContextOf<context>> {
  const transports = options.transports as transports
  const schema = options.schema as schema
  const context = options.context as context

  assertUniqueTransportNames(transports)

  const sessions = transports.map((transport) =>
    createConsumerSession({ context, schema, transport }),
  )

  if (sessions.length === 1) {
    const session = sessions[0]!
    return {
      ...session,
      transports,
    } as unknown as Consumer<schema, transports, Wata.RequestContextOf<context>>
  }

  const emitter = Events.create<Wata.ConsumerEventMap<schema, Wata.RequestContextOf<context>>>()
  for (const session of sessions) {
    session.on('error', (error) => emitter.emit('error', error))
    session.on('notification', (...payload) => emitter.emit('notification', ...payload))
    session.on('rpc-requests', (payload, meta) => emitter.emit('rpc-requests', payload, meta))
    session.on('rpc-responses', (payload, meta) => emitter.emit('rpc-responses', payload, meta))
  }
  const consumer = {
    async close(cause?: Error) {
      await Promise.all(sessions.map((session) => session.close(cause)))
      emitter.emit('close', cause)
    },
    off: emitter.off,
    on(
      type: keyof Wata.ConsumerEventMap<schema, Wata.RequestContextOf<context>>,
      listener: Wata.Listener<
        Wata.ConsumerEventMap<schema, Wata.RequestContextOf<context>>[typeof type]
      >,
    ) {
      const controller = new AbortController()
      emitter.on(type, listener as never, { signal: controller.signal })
      return controller
    },
    role: 'consumer' as const,
    schema,
    transports,
  }
  for (const session of sessions) Object.assign(consumer, { [session.transport.name]: session })
  return consumer as unknown as Consumer<schema, transports, Wata.RequestContextOf<context>>
}

function createConsumerSession<
  const schema extends Schema.Schema | undefined,
  const transport extends Transport.Transport<'consumer', string, unknown>,
  const context extends Schema.Context | undefined,
>(parameters: {
  context: context
  schema: schema
  transport: transport
}): Wata.ConsumerSession<schema, transport, Wata.RequestContextOf<context>> {
  const { context, schema, transport } = parameters

  const emitter = Events.create<Wata.ConsumerEventMap<schema, Wata.RequestContextOf<context>>>()
  const pending = new Map<Rpc.Id, Pending>()
  const methodById = new Map<Rpc.Id, string>()
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
    } as Wata.ConsumerEventMap<schema, Wata.RequestContextOf<context>>['notification']
    emitter.emit(
      'notification',
      ...([payload] as Events.EventArgs<
        Wata.ConsumerEventMap<schema, Wata.RequestContextOf<context>>['notification']
      >),
    )
  }

  function emitRpcResponses(
    envelope: Extract<Envelope.Envelope, { type: 'rpc-responses' }>,
    direction: Wata.RpcEnvelopeMeta['direction'],
  ): void {
    emitter.emit('rpc-responses', envelope.payload as Wata.RpcResponsesPayload<schema>, {
      direction,
      transport: transport.name,
      type: 'rpc-responses',
    })
  }

  function emitRpcRequests(
    envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' }>,
    direction: Wata.RpcEnvelopeMeta['direction'],
  ): void {
    emitter.emit(
      'rpc-requests',
      envelope.payload as unknown as Wata.RpcRequestsPayload<
        schema,
        Wata.RequestContextOf<context>
      >,
      {
        direction,
        transport: transport.name,
        type: 'rpc-requests',
      },
    )
  }

  function rejectModeViolation(reason: string): void {
    const error = new Errors.ProtocolError(reason)
    void (async () => {
      try {
        const envelope = Envelope.rpcResponses([
          Rpc.error({ code: -32600, data: reason, id: null, message: 'invalid request' }),
        ])
        emitRpcResponses(envelope, 'outgoing')
        await transport.send(envelope)
      } catch {
        // Peer may already be unreachable; teardown below is what matters.
      }
      try {
        await transport.close(error)
      } catch {
        // Surface via the local `error` event below regardless.
      }
      emitter.emit('error', error)
    })()
  }

  transport.on('message', (envelope) => {
    if (state.phase === 'pre-key' && envelope.type === 'encrypted') {
      rejectModeViolation('encrypted envelope received before key derivation')
      return
    }
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
      emitRpcResponses(envelope_validated, 'incoming')
      for (const message of envelope_validated.payload) handleResponse(message, { validated: true })
      return
    }
    if (envelope.type === 'rpc-requests') {
      emitRpcRequests(envelope, 'incoming')
      for (const message of envelope.payload) if (!('id' in message)) dispatchNotification(message)
    }
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
    async close(cause) {
      if (!state.started) return
      state.started = false
      rejectPending(cause ?? new Transport.ClosedError('wata closed locally'))
      await transport.close(cause)
      emitter.emit('close', cause)
    },
    async notify(options) {
      if (!transport.capabilities.notifications.consumer)
        throw new Transport.UnsupportedError(
          `transport \`${transport.name}\` does not support consumer notifications`,
        )
      if (!state.started) await start()
      if (schema) SchemaRuntime.validateParamsForMethod(schema, options.method, options.params)
      const envelope = Envelope.rpcRequests([
        Rpc.notification({ method: options.method, params: options.params }),
      ])
      emitRpcRequests(envelope, 'outgoing')
      await transport.send(envelope)
    },
    off: emitter.off,
    on(type, listener) {
      const controller = new AbortController()
      emitter.on(type, listener, { signal: controller.signal })
      return controller
    },
    role: 'consumer',
    schema,
    async send(options) {
      if (!state.started) await start()

      const id = options.id ?? nextId++
      if (schema) SchemaRuntime.validateParamsForMethod(schema, options.method, options.params)
      const context_value =
        options.context === undefined
          ? undefined
          : context
            ? Schema.validate(context, options.context)
            : Schema.validate(Rpc.schema.requestContext, options.context)

      const deferred = new Promise<Wata.SendResult<unknown>>((resolve, reject) => {
        pending.set(id, { reject, resolve })
      })
      methodById.set(id, options.method)

      try {
        const envelope = Envelope.rpcRequests([
          Rpc.request({
            context: context_value,
            id,
            method: options.method,
            params: options.params,
          }),
        ])
        emitRpcRequests(envelope, 'outgoing')
        const metadata = await transport.send(envelope)
        if (metadata !== undefined) {
          void deferred.catch(() => undefined)
          return metadata as Wata.Consumer.SendReturn<schema, transport, typeof options.method>
        }
      } catch (cause) {
        pending.delete(id)
        methodById.delete(id)
        throw cause
      }

      return (await deferred) as Wata.Consumer.SendReturn<schema, transport, typeof options.method>
    },
    start,
    transport,
  }
}

function createHost<
  const schema extends Schema.Schema | undefined = undefined,
  const transports extends HostWata.HostTransports = HostWata.HostTransports,
  const context extends Schema.Context | undefined = undefined,
>(
  options: create.HostOptions<schema, transports, context>,
): Host<schema, transports, Wata.RequestContextOf<context>> {
  const transports = options.transports as transports
  const schema = options.schema as schema
  const context = options.context as context

  assertUniqueTransportNames(transports)

  const emitter =
    Events.create<HostWata.HostEventMap<schema, transports, Wata.RequestContextOf<context>>>()
  type RequestPayload = HostWata.HostEventMap<
    schema,
    transports,
    Wata.RequestContextOf<context>
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

  type RuntimeState = {
    phase: 'pre-key' | 'keyed'
    started: boolean
    startPromise: Promise<void> | undefined
    transport: HostWata.HostTransport
  }
  const runtimes: RuntimeState[] = transports.map((transport) => ({
    phase: 'pre-key',
    started: false,
    startPromise: undefined,
    transport,
  }))
  const invalid_context = Symbol('invalid context')
  const pending = new Map<string, PendingRequest>()
  let startPromise: Promise<void> | undefined

  function settle(
    transport: HostWata.HostTransport,
    id: Rpc.Id,
    response: Rpc.Response,
  ): Promise<boolean> {
    const key = pendingKey(transport, id)
    const entry = pending.get(key)
    if (!entry) return Promise.resolve(false)
    pending.delete(key)
    return sendResponses(transport, [response]).then(() => true)
  }

  function success(id: Rpc.Id, method: string, result: unknown): Rpc.Success {
    const value = schema ? SchemaRuntime.validateResultForMethod(schema, method, result) : result
    return Rpc.success({ id, result: value })
  }

  function settleInternalError(
    transport: HostWata.HostTransport,
    id: Rpc.Id,
    cause: unknown,
  ): Promise<boolean> {
    const error = cause instanceof Error ? cause : new Errors.BaseError(String(cause))
    emitter.emit('error', error)
    return settle(
      transport,
      id,
      Rpc.error({
        code: -32603,
        data: error.message,
        id,
        message: 'internal error',
      }),
    )
  }

  function settleSuccess(
    transport: HostWata.HostTransport,
    id: Rpc.Id,
    method: string,
    result: unknown,
  ): Promise<boolean> {
    const response = success(id, method, result)
    return settle(transport, id, response)
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

  function clearPending(transport: HostWata.HostTransport): void {
    for (const [key, entry] of pending) if (entry.transport === transport) pending.delete(key)
  }

  async function respond(id: Rpc.Id, result: unknown): Promise<void> {
    const entry = resolvePending(id)
    const ok = entry
      ? await settle(entry.transport, id, success(id, entry.request.method, result))
      : false
    if (!ok) throw new UnknownRequestError(id)
  }

  async function reject(id: Rpc.Id, error: HostWata.reject.Error): Promise<void> {
    const { code, data, message } = error
    const entry = resolvePending(id)
    const ok = entry
      ? await settle(entry.transport, id, Rpc.error({ code, data, id, message }))
      : false
    if (!ok) throw new UnknownRequestError(id)
  }

  function startRuntime(runtime: RuntimeState): Promise<void> {
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
    transport: HostWata.HostTransport,
    responses: readonly Rpc.Response[],
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
      // The transport surfaces its own error to listeners.
    }
  }

  function emitRpcRequests(
    transport: HostWata.HostTransport,
    envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' }>,
    direction: Wata.RpcEnvelopeMeta['direction'],
  ): void {
    emitter.emit(
      'rpc-requests',
      envelope.payload as unknown as Wata.RpcRequestsPayload<
        schema,
        Wata.RequestContextOf<context>
      >,
      {
        direction,
        transport: transport.name,
        type: 'rpc-requests',
      },
    )
  }

  async function dispatchRequest(
    runtime: RuntimeState,
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
        ) as Wata.RequestContextOf<context>
      } catch (cause) {
        await sendResponses(runtime.transport, [
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
        await sendResponses(runtime.transport, [
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

    if (snapshot.length === 0) {
      await sendResponses(runtime.transport, [
        Rpc.error({
          code: -32601,
          data: request_value.method,
          id: request_value.id,
          message: 'method not found',
        }),
      ])
      return
    }

    const key = pendingKey(runtime.transport, request_value.id)
    pending.set(key, { request: request_value, transport: runtime.transport })

    const payload = {
      context: context_value,
      id: request_value.id,
      meta: hostEventMeta(runtime.transport, metadata),
      method: request_value.method,
      params: request_value.params,
      reject: (rpcError: { code: number; data?: unknown; message: string }) =>
        settle(
          runtime.transport,
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
          await settleSuccess(runtime.transport, request_value.id, request_value.method, result)
        } catch (cause) {
          await settleInternalError(runtime.transport, request_value.id, cause)
          throw cause
        }
      },
      transport: runtime.transport.name,
    } as HostWata.HostEventMap<schema, transports, Wata.RequestContextOf<context>>['request']

    let firstError: Error | undefined
    for (const entry of snapshot) {
      if (!pending.has(key)) break
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
            await settleSuccess(runtime.transport, request_value.id, request_value.method, resolved)
          } catch (cause) {
            await settleInternalError(runtime.transport, request_value.id, cause)
          }
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
          runtime.transport,
          request_value.id,
          Rpc.error({
            code: -32603,
            data: firstError.message,
            id: request_value.id,
            message: 'internal error',
          }),
        )
    }
  }

  function dispatchNotification(
    runtime: RuntimeState,
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
      meta: hostEventMeta(runtime.transport, metadata),
      method: message.method,
      notification: message,
      params: message.params,
      transport: runtime.transport.name,
    } as HostWata.HostEventMap<schema, transports, Wata.RequestContextOf<context>>['notification']
    emitter.emit(
      'notification',
      ...([payload] as Events.EventArgs<
        HostWata.HostEventMap<schema, transports, Wata.RequestContextOf<context>>['notification']
      >),
    )
  }

  function rejectModeViolation(runtime: RuntimeState, reason: string): void {
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
    runtime.transport.on('message', async (envelope, metadata) => {
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
          if ('id' in message) await dispatchRequest(runtime, message, metadata)
          else dispatchNotification(runtime, message, metadata)
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

  async function notify(
    options: HostWata.Host.NotifyOptions<schema, HostWata.Host.MethodName<schema>>,
  ): Promise<void> {
    const targets = runtimes.filter((runtime) => runtime.transport.capabilities.notifications.host)
    if (targets.length === 0)
      throw new Transport.UnsupportedError('no configured transport supports host notifications')
    if (schema) SchemaRuntime.validateParamsForMethod(schema, options.method, options.params)
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

  return {
    async close(cause) {
      pending.clear()
      for (const runtime of runtimes) runtime.started = false
      await Promise.all(transports.map((transport) => transport.close(cause)))
      emitter.emit('close', cause)
    },
    notify,
    off(
      type: keyof HostWata.HostEventMap<schema, transports, Wata.RequestContextOf<context>>,
      method_or_listener:
        | string
        | HostWata.HostRequestDispatchListener<schema, transports, Wata.RequestContextOf<context>>
        | Wata.Listener<
            HostWata.HostEventMap<schema, transports, Wata.RequestContextOf<context>>[typeof type]
          >,
      listener?: unknown,
    ) {
      if (type === 'request') {
        removeRequestListener(
          typeof method_or_listener === 'string'
            ? (listener as object)
            : (method_or_listener as object),
          typeof method_or_listener === 'string' ? method_or_listener : undefined,
        )
        return
      }
      emitter.off(type, method_or_listener as never)
    },
    on(
      type: keyof HostWata.HostEventMap<schema, transports, Wata.RequestContextOf<context>>,
      method_or_listener:
        | string
        | HostWata.HostRequestDispatchListener<schema, transports, Wata.RequestContextOf<context>>
        | Wata.Listener<
            HostWata.HostEventMap<schema, transports, Wata.RequestContextOf<context>>[typeof type]
          >,
      listener?: unknown,
    ) {
      const controller = new AbortController()
      if (type === 'request') {
        const source =
          typeof method_or_listener === 'string'
            ? (listener as object)
            : (method_or_listener as object)
        const entry = addRequestListener(
          (typeof method_or_listener === 'string'
            ? listener
            : method_or_listener) as RequestListener,
          source,
          typeof method_or_listener === 'string' ? method_or_listener : undefined,
        )
        controller.signal.addEventListener(
          'abort',
          () => {
            requestListeners.delete(entry)
          },
          { once: true },
        )
        lazyConnect()
        return controller
      }
      emitter.on(type, method_or_listener as never, { signal: controller.signal })
      lazyConnect()
      return controller
    },
    reject,
    respond,
    role: 'host',
    schema,
    start,
    transports,
  } as Host<schema, transports, Wata.RequestContextOf<context>>
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

function hostEventMeta(
  transport: HostWata.HostTransport,
  metadata?: Transport.MessageMeta | undefined,
): HostWata.HostEventMeta {
  return { ...metadata, transport: transport.name }
}

function pendingKey(transport: HostWata.HostTransport, id: Rpc.Id): string {
  return JSON.stringify([transport.name, id])
}

type Pending = {
  reject: (error: Error) => void
  resolve: (result: Wata.SendResult<unknown>) => void
}

type PendingRequest = {
  request: Rpc.Request
  transport: HostWata.HostTransport
}

/**
 * Thrown by host runtimes when more than one transport has a pending
 * request with the supplied id.
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
 * Thrown by host runtimes when no inbound request with the supplied id is
 * currently pending.
 */
export class UnknownRequestError extends Errors.BaseError {
  override name = 'Wata.UnknownRequestError'

  constructor(id: Rpc.Id) {
    super(`no pending request with id \`${String(id)}\``)
  }
}
