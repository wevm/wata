/**
 * Additional Authenticated Data (AAD) construction for the uRPC AEAD layer.
 *
 * Per [uRPC `core.md` §6](https://github.com/tempoxyz/urpc/blob/main/specs/core.md#encrypted-message-envelope-aead),
 * every sealed frame binds a deterministic AAD blob to the ciphertext so the
 * recipient can detect cross-session, cross-direction, or cross-version
 * replay attempts even if the attacker has the right key.
 *
 * Wire layout (40 bytes total):
 *
 * ```diagram
 * ╭─────────────┬─────────────────────────────┬───────╮
 * │  "urpc/v1"  │  pubkey_consumer (32 bytes) │ role  │
 * │   7 bytes   │    raw X25519 public key    │ 1 byte│
 * ╰─────────────┴─────────────────────────────┴───────╯
 * ```
 *
 * - `"urpc/v1"` — ASCII version prefix, pinned for the v1 protocol.
 * - `publicKey`       — the spec's `pubkey_consumer`: raw 32-byte X25519
 *                    public key, the session anchor (spec §4). Identical
 *                    for both directions of the same session.
 * - `role`         — sender role byte: `0x01` consumer, `0x02` host.
 *                    Mirrors the `from` discriminator on the encrypted
 *                    envelope.
 *
 * Anti-replay across frames is handled by the per-direction nonce counter
 * (see {@link "./Nonce"}), so the AAD itself does not vary per frame.
 */

import { Bytes, Hex } from 'ox'

import * as Errors from './Errors.js'

/** ASCII version prefix bound to every AAD blob. */
export const prefix = 'urpc/v1'

/** Length of the version prefix in bytes. */
export const prefixSize = 7

/** Length of the `publicKey` (= spec's `pubkey_consumer`) field in bytes. */
export const publicKeySize = 32

/** Total AAD length in bytes (`prefixSize + publicKeySize + 1`). */
export const size = 40

/** Allowed values for the trailing `role` byte. */
export const role = {
  /** Consumer-originated frame. */
  consumer: 0x01,
  /** Host-originated frame. */
  host: 0x02,
} as const

/** Sender-role discriminant for {@link encode} and {@link decode}. */
export type Role = (typeof role)[keyof typeof role]

const prefixBytes = new TextEncoder().encode(prefix)

/**
 * Encode a structured AAD record into its 43-byte wire form.
 *
 * @example
 * ```ts
 * import { Aad } from 'wata'
 *
 * Aad.encode({
 *   publicKey: '0x...32-byte-X25519-public-key...',
 *   role: Aad.role.consumer,
 * })
 * ```
 */
export function encode(options: encode.Options): Hex.Hex {
  const publicKey = Bytes.from(options.publicKey)
  if (publicKey.length !== publicKeySize)
    throw new Errors.ProtocolError('publicKey must be 32 bytes', {
      details: `received ${publicKey.length} bytes`,
    })
  const out = new Uint8Array(size)
  out.set(prefixBytes, 0)
  out.set(publicKey, prefixSize)
  out[prefixSize + publicKeySize] = options.role
  return Hex.fromBytes(out)
}

export declare namespace encode {
  /** Options for {@link encode}. */
  type Options = {
    /**
     * Raw 32-byte X25519 public key — the session anchor (spec calls this
     * `pubkey_consumer`, §4). Always the consumer's key, regardless of
     * which side is sealing.
     */
    publicKey: Hex.Hex | Bytes.Bytes
    /** Sender role byte; use {@link role}. */
    role: Role
  }
}

/**
 * Parse a 43-byte AAD blob back into its structured fields. Throws
 * {@link Errors.ProtocolError} on malformed inputs (wrong length, wrong
 * prefix, invalid role byte).
 *
 * @example
 * ```ts
 * import { Aad } from 'wata'
 *
 * const fields = Aad.decode(aad)
 * ```
 */
export function decode(aad: Hex.Hex | Bytes.Bytes): decode.ReturnType {
  const bytes = Bytes.from(aad)
  if (bytes.length !== size)
    throw new Errors.ProtocolError('aad must be exactly 40 bytes', {
      details: `received ${bytes.length} bytes`,
    })
  for (let i = 0; i < prefixSize; i++)
    if (bytes[i] !== prefixBytes[i])
      throw new Errors.ProtocolError('aad version prefix mismatch', {
        details: `expected "${prefix}"`,
      })
  const roleByte = bytes[prefixSize + publicKeySize]!
  if (roleByte !== role.consumer && roleByte !== role.host)
    throw new Errors.ProtocolError('aad role byte invalid', {
      details: `received 0x${roleByte.toString(16).padStart(2, '0')}`,
    })
  return {
    publicKey: Hex.fromBytes(bytes.slice(prefixSize, prefixSize + publicKeySize)),
    role: roleByte,
  }
}

export declare namespace decode {
  /** Result of {@link decode}. */
  type ReturnType = {
    /** Raw 32-byte X25519 public key (spec's `pubkey_consumer`) as `0x`-prefixed hex. */
    publicKey: Hex.Hex
    /** Sender role byte (see {@link role}). */
    role: Role
  }
}
