/**
 * JSON-RPC 2.0 message constructors and parser.
 *
 * The uRPC transport layer carries JSON-RPC 2.0 messages inside every
 * frame (encrypted or plain). This module:
 *
 * - constructs the four message variants (`request`, `notification`,
 *   `success` response, `error` response),
 * - provides {@link parse} that validates an inbound JSON value and narrows
 *   it to the correct shape,
 * - is fully generic on `method`, `params`, and `result`, so {@link Schema}
 *   can flow inferred types through to `Wata.send` and friends.
 */

import { z } from 'zod/mini'

import * as Errors from './Errors.js'

/** JSON-RPC version literal. */
export const version = '2.0'

/**
 * JSON-RPC request id. The spec allows `string | number | null`; we forbid
 * `null` for outbound traffic (it's reserved for "could not be detected"
 * error responses) and accept it on inbound responses only.
 */
export type Id = string | number

/**
 * JSON-RPC `params` slot. Spec says "structured value, either array or
 * object"; we keep the inferred shape flexible so {@link Schema} can narrow
 * it via generics.
 */
export type Params = readonly unknown[] | Record<string, unknown>

/**
 * Default per-request context metadata. `account` and `chainId` are
 * session selectors; app-specific context schemas may add more fields.
 */
export type RequestContext = {
  /** Active account for request handling, when the RPC relies on one. */
  account?: string | undefined
  /** Active chain id for request handling, when the RPC relies on one. */
  chainId?: number | undefined
}

/**
 * A typed JSON-RPC request.
 *
 * @example
 * ```ts
 * import { Rpc } from 'wata'
 *
 * const message = Rpc.request({
 *   context: { chainId: 1 },
 *   id: 1,
 *   method: 'eth_blockNumber',
 *   params: [],
 * })
 * ```
 */
export type Request<
  method extends string = string,
  params extends Params = Params,
  context extends RequestContext = RequestContext,
> = {
  /** Optional per-request context metadata. */
  context?: context | undefined
  /** JSON-RPC request id. */
  id: Id
  /** JSON-RPC version. */
  jsonrpc: typeof version
  /** Method name. */
  method: method
  /** Method params. */
  params: params
}

/** A typed JSON-RPC notification (no `id`). */
export type Notification<method extends string = string, params extends Params = Params> = {
  jsonrpc: typeof version
  method: method
  params: params
}

/** A typed JSON-RPC success response. */
export type Success<result = unknown> = {
  id: Id | null
  jsonrpc: typeof version
  result: result
}

/** A typed JSON-RPC error response. */
export type ErrorResponse<data = unknown> = {
  error: {
    code: number
    data?: data
    message: string
  }
  id: Id | null
  jsonrpc: typeof version
}

/** Either flavour of JSON-RPC response. */
export type Response<result = unknown, data = unknown> = Success<result> | ErrorResponse<data>

/** Discriminated union of every shape {@link parse} can return. */
export type Envelope = Request | Notification | Success | ErrorResponse

/**
 * Construct a typed JSON-RPC request.
 *
 * @example
 * ```ts
 * Rpc.request({ id: 1, method: 'ping', params: [] })
 * ```
 */
export function request<
  const method extends string,
  const params extends Params,
  const context extends RequestContext = RequestContext,
>(options: request.Options<method, params, context>): Request<method, params, context> {
  const { context, id, method, params } = options
  return {
    id,
    jsonrpc: version,
    method,
    params,
    ...(context === undefined ? {} : { context }),
  }
}

export declare namespace request {
  /** Options for {@link request}. */
  type Options<
    method extends string,
    params extends Params,
    context extends RequestContext = RequestContext,
  > = {
    /** Optional per-request context metadata. */
    context?: context | undefined
    /** Request id (string or number). Must be unique within the session. */
    id: Id
    /** Method name. */
    method: method
    /** Method params (positional array or named object). */
    params: params
  }
}

/**
 * Construct a typed JSON-RPC notification.
 *
 * @example
 * ```ts
 * Rpc.notification({ method: 'ping', params: [] })
 * ```
 */
export function notification<const method extends string, const params extends Params>(
  options: notification.Options<method, params>,
): Notification<method, params> {
  const { method, params } = options
  return { jsonrpc: version, method, params }
}

export declare namespace notification {
  /** Options for {@link notification}. */
  type Options<method extends string, params extends Params> = {
    /** Method name. */
    method: method
    /** Method params (positional array or named object). */
    params: params
  }
}

/**
 * Construct a typed JSON-RPC success response.
 *
 * @example
 * ```ts
 * Rpc.success({ id: 1, result: { blockNumber: '0x1' } })
 * ```
 */
export function success<const result>(options: success.Options<result>): Success<result> {
  const { id, result } = options
  return { id, jsonrpc: version, result }
}

export declare namespace success {
  /** Options for {@link success}. */
  type Options<result> = {
    /** Id of the request being answered (or `null` if the request id couldn't be parsed). */
    id: Id | null
    /** Result payload. */
    result: result
  }
}

/**
 * Construct a typed JSON-RPC error response.
 *
 * @example
 * ```ts
 * Rpc.error({ id: 1, code: -32601, message: 'method not found' })
 * ```
 */
export function error<const data = undefined>(options: error.Options<data>): ErrorResponse<data> {
  const { code, data, id, message } = options
  return {
    error: data === undefined ? { code, message } : { code, data, message },
    id,
    jsonrpc: version,
  }
}

export declare namespace error {
  /** Options for {@link error}. */
  type Options<data> = {
    /** JSON-RPC error code. */
    code: number
    /** Optional opaque error data. */
    data?: data
    /** Id of the request being answered (or `null` if the request id couldn't be parsed). */
    id: Id | null
    /** Human-readable error message. */
    message: string
  }
}

/** Zod schemas for the on-the-wire JSON-RPC 2.0 message variants. */
export namespace schema {
  /** Request id (string or number). */
  export const id = z.union([z.string(), z.number()])

  /** Params slot — positional array or named object. */
  export const params = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())])

  /** `jsonrpc` discriminator literal. */
  export const jsonrpc = z.literal('2.0')

  /** Per-request context metadata. Reserved keys are typed, extras are preserved. */
  export const requestContext = z.looseObject({
    account: z.optional(z.string()),
    chainId: z.optional(z.number()),
  })

  /** JSON-RPC 2.0 request. */
  export const request = z.object({
    context: z.optional(requestContext),
    id,
    jsonrpc,
    method: z.string(),
    params,
  })

  /** JSON-RPC 2.0 notification (no `id`). */
  export const notification = z.object({
    jsonrpc,
    method: z.string(),
    params,
  })

  /** JSON-RPC 2.0 success response. */
  export const success = z.object({
    id: z.nullable(id),
    jsonrpc,
    result: z.unknown(),
  })

  /** JSON-RPC 2.0 error response. */
  export const errorResponse = z.object({
    error: z.object({
      code: z.number(),
      data: z.optional(z.unknown()),
      message: z.string(),
    }),
    id: z.nullable(id),
    jsonrpc,
  })
}

/**
 * Parse and narrow an inbound JSON value into one of the four envelope
 * variants. Throws {@link ProtocolError} on malformed inputs.
 *
 * Discrimination rules (in order):
 * 1. Has `error` field → {@link ErrorResponse}.
 * 2. Has `result` field → {@link Success}.
 * 3. Has `id` field → {@link Request}.
 * 4. Otherwise → {@link Notification}.
 *
 * @example
 * ```ts
 * import { Rpc } from 'wata'
 *
 * const message = Rpc.parse(JSON.parse(text))
 * if ('result' in message) console.log(message.result)
 * ```
 */
export function parse(value: unknown): Envelope {
  if (typeof value !== 'object' || value === null)
    throw new Errors.ProtocolError('JSON-RPC message must be an object')
  if ('error' in value)
    return assertParse(schema.errorResponse, value, 'error response') as ErrorResponse
  if ('result' in value) return assertParse(schema.success, value, 'success response') as Success
  if ('id' in value) return assertParse(schema.request, value, 'request') as Request
  return assertParse(schema.notification, value, 'notification') as Notification
}

function assertParse<schema extends z.ZodMiniType>(
  schema: schema,
  value: unknown,
  label: string,
): z.output<schema> {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new Errors.ProtocolError(`invalid ${label}`, {
      details: result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    })
  return result.data
}

/**
 * Thrown when a JSON-RPC peer returns an error response. `code` and `data`
 * mirror the JSON-RPC error object so callers can branch on standard codes
 * (e.g. `-32601` method not found) without parsing the message.
 */
export class RpcError extends Errors.BaseError {
  override name = 'Rpc.RpcError'

  /** JSON-RPC error code (per [JSON-RPC 2.0 §5.1](https://www.jsonrpc.org/specification#error_object)). */
  code: number

  /** Optional JSON-RPC error `data` payload, opaque to the transport layer. */
  data: unknown

  constructor(message: string, options: RpcError.Options) {
    super(message, { details: options.details, metaMessages: options.metaMessages })
    this.code = options.code
    this.data = options.data
  }
}

export declare namespace RpcError {
  /** Options for {@link RpcError}. */
  type Options = Errors.BaseError.Options<undefined> & {
    /** JSON-RPC error code returned by the peer. */
    code: number
    /** JSON-RPC error `data` payload returned by the peer (opaque). */
    data?: unknown
  }
}
