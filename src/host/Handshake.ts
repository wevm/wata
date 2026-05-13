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
   * Resolve the request with `result`. If no listener calls `respond` (or
   * returns a non-`undefined` value) the host emits a JSON-RPC
   * `method not found` error.
   */
  respond: (result: result) => void
  /** Reject the request with a JSON-RPC error response. */
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
   * Bring the session up. Starts the transport and resolves once it is
   * ready to send and receive frames. Emits `'open'` on success.
   */
  connect: () => Promise<void>
  /** Close the session. Idempotent. Emits `'close'`. */
  close: (cause?: Error) => Promise<void>
  /**
   * Subscribe to a host event. Returns an `AbortController` so the
   * subscription can be cancelled (or composed with an external signal).
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

/**
 * Create a host-side {@link Host} `Handshake` around a transport.
 *
 * @example
 * ```ts
 * import { Handshake } from 'handshakes/host'
 *
 * const handshake = Handshake.create({ transport })
 * await handshake.connect()
 * handshake.on('request', (event) => {
 *   if (event.method === 'ping') event.respond({ ok: true })
 * })
 * ```
 */
export function create<const schema extends Schema.Schema | undefined = undefined>(
  options: create.Options<schema>,
): Host<schema> {
  const { transport } = options
  const schema = options.schema as schema

  const bus = Handshake.createBus<HostEventMap<schema>>()
  const state = { started: false, closed: false }

  transport.onMessage(async (envelope) => {
    if (envelope.type !== 'plain') {
      bus.emit(
        'error',
        new Errors.ProtocolError('host received an encrypted envelope on a plain transport'),
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

    if ('result' in message || 'error' in message) {
      // Hosts don't currently send requests; ignore stray responses.
      return
    }

    if ('id' in message) {
      const request = message as Rpc.Request
      if (schema) {
        try {
          Handshake.validateParamsIfKnown(schema, request.method, request.params)
        } catch (cause) {
          await safeSend(
            transport,
            Rpc.error({
              id: request.id,
              code: -32602,
              message: 'invalid params',
              data: (cause as Error).message,
            }),
          )
          return
        }
      }

      let settled = false
      const event = {
        method: request.method,
        params: request.params,
        id: request.id,
        request,
        respond: (result: unknown) => {
          if (settled) return
          settled = true
          void safeSend(transport, Rpc.success({ id: request.id, result }))
        },
        reject: (rpcError: { code: number; message: string; data?: unknown }) => {
          if (settled) return
          settled = true
          void safeSend(
            transport,
            Rpc.error({
              id: request.id,
              code: rpcError.code,
              message: rpcError.message,
              data: rpcError.data,
            }),
          )
        },
      }

      const outcomes = bus.emit('request', event as HostEventMap<schema>['request'])

      let firstError: Error | undefined
      for (const outcome of outcomes) {
        if (settled) break
        if (outcome.kind === 'error') {
          firstError ??= outcome.error
          continue
        }
        try {
          const resolved = await Promise.resolve(outcome.value)
          if (resolved !== undefined) {
            settled = true
            await safeSend(transport, Rpc.success({ id: request.id, result: resolved }))
            break
          }
        } catch (cause) {
          firstError ??= cause as Error
        }
      }

      if (!settled && firstError) {
        settled = true
        if (firstError instanceof Rpc.RpcError) {
          await safeSend(
            transport,
            Rpc.error({
              id: request.id,
              code: firstError.code,
              message: firstError.message,
              data: firstError.data,
            }),
          )
        } else {
          await safeSend(
            transport,
            Rpc.error({
              id: request.id,
              code: -32603,
              message: 'internal error',
              data: firstError.message,
            }),
          )
        }
      }

      if (!settled) {
        await safeSend(
          transport,
          Rpc.error({
            id: request.id,
            code: -32601,
            message: 'method not found',
            data: request.method,
          }),
        )
      }
      return
    }

    // Notification — fire and forget.
    if (schema) {
      try {
        Handshake.validateParamsIfKnown(schema, message.method, message.params)
      } catch (cause) {
        bus.emit('error', cause as Error)
        return
      }
    }
    bus.emit('notification', {
      method: message.method,
      params: message.params,
      notification: message,
    } as HostEventMap<schema>['notification'])
  })

  transport.onClose((cause) => {
    if (state.closed) return
    state.closed = true
    bus.emit('close', cause)
  })

  transport.onError((error) => {
    bus.emit('error', error)
  })

  return {
    role: 'host',
    transport,
    schema,
    async connect() {
      if (state.closed) throw new Transport.ClosedError('handshake already closed')
      if (state.started) return
      state.started = true
      await transport.start()
      bus.emit('open', undefined)
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
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
    /** Host-role transport this handshake wraps. */
    transport: Transport.Transport<'host'>
    /** Optional method-registry schema (typed `'request'` / `'notification'` payloads). */
    schema?: schema | undefined
  }
}

async function safeSend(transport: Transport.Transport, payload: unknown): Promise<void> {
  try {
    await transport.send(Envelope.plain(payload))
  } catch {
    // The transport surfaces its own error to listeners; swallow here so
    // the host loop doesn't blow up after a peer disconnect.
  }
}
