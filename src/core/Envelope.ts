/**
 * Wire envelope used by every TempoCP frame.
 *
 * An envelope is a tagged JSON object the transport layer hands to and from
 * the wire. Two variants in v1:
 *
 * - `plain`     — clear-text payload. Used during bootstrap and on transports
 *                 whose underlying medium is already authenticated (e.g.
 *                 `window` postMessage with origin pinning).
 * - `encrypted` — AEAD-sealed payload, `counter` matches the sealing nonce
 *                 and the AAD record (see {@link "./Aad"}).
 *
 * The discriminator is the `type` field. Counters are JSON strings so
 * 96-bit nonce values survive `JSON.parse` without precision loss.
 */

import type { Hex } from 'ox'
import { z } from 'zod'

import * as Errors from './Errors.js'

/** Zod schemas for the on-the-wire envelope shapes. */
export namespace schema {
  /** Hex-encoded byte string (`0x` followed by an even-length run of hex chars). */
  export const hex = z.templateLiteral(
    ['0x', z.string().regex(/^([0-9a-fA-F]{2})*$/)],
    'expected 0x-prefixed even-length hex',
  )

  /** Decimal-string AEAD counter (preserves 96-bit values across `JSON.parse`). */
  export const counter = z
    .string()
    .regex(/^\d+$/, { message: 'counter must be a non-negative decimal string' })

  /** Plain (cleartext) envelope variant. */
  export const plain = z.object({
    type: z.literal('plain'),
    payload: z.unknown(),
  })

  /** Encrypted envelope variant. */
  export const encrypted = z.object({
    type: z.literal('encrypted'),
    counter,
    ciphertext: hex,
  })

  /** Discriminated union of every envelope variant. */
  export const envelope = z.discriminatedUnion('type', [plain, encrypted])
}

/**
 * Discriminated union of the two v1 envelope variants. Use {@link plain}
 * and {@link encrypted} to construct values; {@link parse} to validate
 * inbound frames.
 */
export type Envelope = z.output<typeof schema.envelope>

/** Construct a `plain` envelope around an arbitrary JSON-serializable payload. */
export function plain(payload: unknown): Extract<Envelope, { type: 'plain' }> {
  return { type: 'plain', payload }
}

/**
 * Construct an `encrypted` envelope. `counter` is normalized to its decimal
 * string form so JSON consumers don't need `BigInt` support.
 */
export function encrypted(options: encrypted.Options): Extract<Envelope, { type: 'encrypted' }> {
  return {
    type: 'encrypted',
    counter: options.counter.toString(10),
    ciphertext: options.ciphertext,
  }
}

export declare namespace encrypted {
  /** Options for {@link encrypted}. */
  type Options = {
    /** Frame counter (matches the AEAD nonce counter). */
    counter: bigint
    /** AEAD ciphertext (with the 16-byte tag appended). */
    ciphertext: Hex.Hex
  }
}

/**
 * Validate an inbound JSON value and narrow it to {@link Envelope}. Throws
 * {@link Errors.ProtocolError} on shape errors so callers can map straight to a
 * protocol-level rejection.
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
      details: result.error.issues.map((issue) => issue.message).join('; '),
    })
  return result.data
}

/**
 * Read the counter back out of an `encrypted` envelope as a `bigint`. Helper
 * because consumers always need this when calling {@link "./Aead".open}.
 */
export function counterOf(envelope: Extract<Envelope, { type: 'encrypted' }>): bigint {
  return BigInt(envelope.counter)
}
