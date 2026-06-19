/**
 * Shared session primitives.
 *
 * The cross-side session vocabulary both `Wata` surfaces build on: the
 * listener signature, the envelope observability tap ({@link EnvelopeMeta},
 * {@link ObservedEnvelope} + payloads), the {@link LifecycleEventMap} every
 * session emits, and {@link RequestContextOf}. These depend only on the
 * core wire types (no `Wata` import), so consumer ({@link "../consumer/Session"})
 * and host ({@link "../host/Session"}) can both layer their side-specific
 * surfaces on top.
 */

import type * as Events from './Events.js'
import type * as Rpc from './Rpc.js'
import type * as Schema from './Schema.js'

/** Listener supplied to an `onX` subscriber method. */
export type Listener<payload> = Events.Listener<payload>

/** Direction + transport metadata for an observed {@link ObservedEnvelope}. */
export type EnvelopeMeta = {
  /** Direction relative to the local `Wata` instance. */
  direction: 'incoming' | 'outgoing'
  /** SDK-facing transport name that carried this envelope. */
  transport: string
}

type RpcRequestMessageOf<
  schema extends Schema.Schema | undefined,
  context extends Rpc.RequestContext,
> = schema extends Schema.Schema
  ? {
      [method in Schema.MethodName<schema>]:
        | Rpc.Notification<method, Rpc.Params & Schema.ParamsOf<schema, method>>
        | Rpc.Request<method, Rpc.Params & Schema.ParamsOf<schema, method>, context>
    }[Schema.MethodName<schema>]
  : Rpc.Request<string, Rpc.Params, context> | Rpc.Notification

type RpcResponseMessageOf<schema extends Schema.Schema | undefined> = Rpc.Response<
  RpcResponseResultOf<schema>
>

type RpcResponseResultOf<schema extends Schema.Schema | undefined> = schema extends Schema.Schema
  ? {
      [method in Schema.MethodName<schema>]: Schema.ResultOf<schema, method>
    }[Schema.MethodName<schema>]
  : unknown

/** Decoded payload of an observed `rpc-requests` envelope. */
export type RpcRequestsPayload<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = readonly RpcRequestMessageOf<schema, context>[]

/** Decoded payload of an observed `rpc-responses` envelope. */
export type RpcResponsesPayload<schema extends Schema.Schema | undefined = undefined> =
  readonly RpcResponseMessageOf<schema>[]

/**
 * A uRPC envelope surfaced through the `'envelope'` observability tap:
 * either an `rpc-requests` or `rpc-responses` envelope, with its decoded
 * payload. Discriminate on `type` to narrow `payload`. Handshake /
 * transport frames (`hello`, `ready`, `encrypted`) are never surfaced.
 */
export type ObservedEnvelope<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> =
  | {
      /** JSON-RPC request / notification payloads carried by the envelope. */
      payload: RpcRequestsPayload<schema, context>
      /** Envelope type discriminator. */
      type: 'rpc-requests'
    }
  | {
      /** JSON-RPC response payloads carried by the envelope. */
      payload: RpcResponsesPayload<schema>
      /** Envelope type discriminator. */
      type: 'rpc-responses'
    }

/** Lifecycle events emitted on every `Wata` (consumer + host). */
export type LifecycleEventMap<
  schema extends Schema.Schema | undefined = undefined,
  context extends Rpc.RequestContext = Rpc.RequestContext,
> = {
  /** Emitted exactly once when the session closes, cleanly or with cause. */
  close: Error | undefined
  /**
   * Observed uRPC envelope crossing the wire (read-only tap), in either
   * direction. Fires for `rpc-requests` and `rpc-responses` envelopes
   * only; discriminate on `envelope.type` to narrow the payload.
   */
  envelope: [
    /** The observed envelope with its decoded payload. */
    envelope: ObservedEnvelope<schema, context>,
    /** Direction and transport metadata for the envelope. */
    meta: EnvelopeMeta,
  ]
  /** Emitted when the transport surfaces an error (network, parse, AEAD). */
  error: Error
  /**
   * Emitted exactly once when the session's transport has started — the
   * point the awaited {@link ready} promise resolves. Fires after the
   * connection is established for eager / connected transports.
   */
  ready: undefined
}

/** Request context value inferred from an optional Wata-wide context schema. */
export type RequestContextOf<context extends Schema.Context | undefined> =
  context extends Schema.Context ? Schema.ContextOf<context> : Rpc.RequestContext
