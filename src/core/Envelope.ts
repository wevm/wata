/**
 * Wire envelope used by every TempoCP frame.
 *
 * Per [TempoCP `core.md` §7](https://github.com/tempoxyz/tempocp/blob/main/specs/core.md#message-format-json-rpc-framing),
 * every wire frame is a tagged JSON object:
 *
 * ```json
 * { "type": "<type>", "payload": <type-specific> }
 * ```
 *
 * v1 defines five envelope types:
 *
 * | Type             | Direction           | Payload                                                 |
 * |------------------|---------------------|---------------------------------------------------------|
 * | `rpc-requests`   | either              | Array of JSON-RPC 2.0 request / notification objects.   |
 * | `rpc-responses`  | either              | Array of JSON-RPC 2.0 response objects.                 |
 * | `ready`          | either              | `{}` or transport-defined readiness metadata.           |
 * | `encrypted`      | either              | AEAD-sealed envelope `{v, from, nonce, ct}`.            |
 * | `hello`          | host → consumer     | Transport-defined handshake metadata.                   |
 *
 * Encrypted variant wire shape:
 *
 * ```json
 * {
 *   "type": "encrypted",
 *   "payload": {
 *     "v":     1,
 *     "from":  "consumer" | "host",
 *     "nonce": "<base64url 12 bytes>",
 *     "ct":    "<base64url ciphertext‖tag>"
 *   }
 * }
 * ```
 *
 * Once AEAD keys exist, every inbound message MUST be `type="encrypted"`;
 * any plaintext after key derivation is rejected with JSON-RPC `-32600`
 * + teardown (mode discipline; tracked separately).
 */

import { Base64, Bytes, Hex } from 'ox'
import { z } from 'zod'

import * as Errors from './Errors.js'
import * as Rpc from './Rpc.js'

/** Envelope schema-level constants. */
export const version = 1

/** `from` discriminator on the encrypted envelope payload. */
export const from = {
  /** Consumer-originated frame. */
  consumer: 'consumer',
  /** Host-originated frame. */
  host: 'host',
} as const

/** Sender role discriminant. */
export type From = (typeof from)[keyof typeof from]

/** Zod schemas for the on-the-wire envelope shapes. */
export namespace schema {
  /** Base64url-encoded byte string (RFC 4648 §5; padding optional). */
  export const base64url = z.string().regex(/^[A-Za-z0-9_-]*={0,2}$/, {
    message: 'expected base64url-encoded string',
  })

  /** Sender-role discriminator on encrypted envelopes. */
  export const fromField = z.enum([from.consumer, from.host])

  /** `rpc-requests` envelope payload — an array of JSON-RPC requests/notifications. */
  export const rpcRequestsPayload = z.array(z.union([Rpc.schema.request, Rpc.schema.notification]))

  /** `rpc-responses` envelope payload — an array of JSON-RPC responses. */
  export const rpcResponsesPayload = z.array(
    z.union([Rpc.schema.success, Rpc.schema.errorResponse]),
  )

  /** `ready` / `hello` envelope payload — transport-defined metadata bag. */
  export const metadataPayload = z.record(z.string(), z.unknown())

  /** `encrypted` envelope inner payload. */
  export const encryptedPayload = z.object({
    v: z.literal(version),
    from: fromField,
    nonce: base64url,
    ct: base64url,
  })

  /** `rpc-requests` envelope. */
  export const rpcRequests = z.object({
    type: z.literal('rpc-requests'),
    payload: rpcRequestsPayload,
  })

  /** `rpc-responses` envelope. */
  export const rpcResponses = z.object({
    type: z.literal('rpc-responses'),
    payload: rpcResponsesPayload,
  })

  /** `ready` envelope. */
  export const ready = z.object({
    type: z.literal('ready'),
    payload: metadataPayload,
  })

  /** `hello` envelope. */
  export const hello = z.object({
    type: z.literal('hello'),
    payload: metadataPayload,
  })

  /** `encrypted` envelope. */
  export const encrypted = z.object({
    type: z.literal('encrypted'),
    payload: encryptedPayload,
  })

  /** Discriminated union of every envelope variant. */
  export const envelope = z.discriminatedUnion('type', [
    rpcRequests,
    rpcResponses,
    ready,
    hello,
    encrypted,
  ])
}

/**
 * Discriminated union of the five v1 envelope variants. Use the
 * per-variant builders ({@link rpcRequests}, {@link rpcResponses},
 * {@link ready}, {@link hello}, {@link encrypted}) to construct
 * values; {@link parse} to validate inbound frames.
 */
export type Envelope = z.output<typeof schema.envelope>

/** RPC message that may travel inside an `rpc-requests` envelope. */
export type RpcRequestMessage = Rpc.Request | Rpc.Notification

/** Construct an `rpc-requests` envelope around one or more JSON-RPC messages. */
export function rpcRequests(
  messages: ReadonlyArray<RpcRequestMessage>,
): Extract<Envelope, { type: 'rpc-requests' }> {
  return { type: 'rpc-requests', payload: [...messages] as never }
}

/** Construct an `rpc-responses` envelope around one or more JSON-RPC responses. */
export function rpcResponses(
  messages: ReadonlyArray<Rpc.Response>,
): Extract<Envelope, { type: 'rpc-responses' }> {
  return { type: 'rpc-responses', payload: [...messages] as never }
}

/** Construct a `ready` envelope (optionally carrying transport-defined metadata). */
export function ready(
  payload: Record<string, unknown> = {},
): Extract<Envelope, { type: 'ready' }> {
  return { type: 'ready', payload }
}

/** Construct a `hello` envelope (host → consumer). */
export function hello(
  payload: Record<string, unknown> = {},
): Extract<Envelope, { type: 'hello' }> {
  return { type: 'hello', payload }
}

/**
 * Construct an `encrypted` envelope. `nonce` and `ciphertext` are
 * accepted as `Hex.Hex` / `Bytes.Bytes` and re-encoded as base64url
 * (no padding) for the wire.
 */
export function encrypted(options: encrypted.Options): Extract<Envelope, { type: 'encrypted' }> {
  return {
    type: 'encrypted',
    payload: {
      v: version,
      from: options.from,
      nonce: Base64.fromBytes(Bytes.from(options.nonce), { url: true, pad: false }),
      ct: Base64.fromBytes(Bytes.from(options.ciphertext), { url: true, pad: false }),
    },
  }
}

export declare namespace encrypted {
  /** Options for {@link encrypted}. */
  type Options = {
    /** Sender role; mirrors the AAD `role` byte. */
    from: From
    /** AEAD nonce (12 bytes). */
    nonce: Hex.Hex | Bytes.Bytes
    /** AEAD ciphertext with the 16-byte Poly1305 tag appended. */
    ciphertext: Hex.Hex | Bytes.Bytes
  }
}

/**
 * Validate an inbound JSON value and narrow it to {@link Envelope}.
 * Throws {@link Errors.ProtocolError} on shape errors so callers can map
 * straight to a protocol-level rejection.
 *
 * @example
 * ```ts
 * import { Envelope } from 'handshakes'
 *
 * const envelope = Envelope.parse(JSON.parse(text))
 * ```
 */
export function parse(value: unknown): Envelope {
  const result = schema.envelope.safeParse(value)
  if (!result.success)
    throw new Errors.ProtocolError('invalid envelope', {
      details: result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    })
  return result.data
}

/**
 * Decode the base64url `nonce` / `ct` fields of an encrypted envelope
 * back into hex form for use with {@link "./Aead".open}.
 *
 * @example
 * ```ts
 * import { Aead, Envelope } from 'handshakes'
 *
 * const { nonce, ciphertext, from } = Envelope.toEncrypted(envelope)
 * const plaintext = Aead.open({ key, nonce, aad, ciphertext })
 * ```
 */
export function toEncrypted(
  envelope: Extract<Envelope, { type: 'encrypted' }>,
): toEncrypted.ReturnType {
  return {
    from: envelope.payload.from,
    nonce: Base64.toHex(envelope.payload.nonce),
    ciphertext: Base64.toHex(envelope.payload.ct),
  }
}

export declare namespace toEncrypted {
  /** Result of {@link toEncrypted}. */
  type ReturnType = {
    /** Sender role taken from the envelope's `from` field. */
    from: From
    /** Decoded 12-byte AEAD nonce as `0x`-prefixed hex. */
    nonce: Hex.Hex
    /** Decoded ciphertext (with appended 16-byte tag) as `0x`-prefixed hex. */
    ciphertext: Hex.Hex
  }
}
