/**
 * HKDF key-derivation primitives used by the TempoCP transport layer.
 *
 * Wraps `@noble/hashes/hkdf` (HKDF-SHA256, RFC 5869) with a `Hex.Hex`-shaped
 * surface that matches the rest of `core/*`. We only ship the SHA-256 variant
 * — the protocol pins it.
 *
 * The underlying primitives:
 * - `extract` performs `HKDF-Extract(IKM, salt) -> PRK` (RFC 5869 §2.2).
 * - `expand` performs `HKDF-Expand(PRK, info, L) -> OKM` (RFC 5869 §2.3).
 * - `derive` is the convenience composite: `extract` then `expand`.
 */

import { extract as hkdf_extract, expand as hkdf_expand } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Bytes, Hex } from 'ox'

/**
 * Run the HKDF-Extract step (RFC 5869 §2.2): mix initial keying material
 * with an optional salt to produce a 32-byte pseudorandom key.
 *
 * @example
 * ```ts
 * import { Kdf } from 'handshakes'
 *
 * const prk = Kdf.extract({ ikm: '0x0b0b0b...', salt: '0x000102...' })
 * ```
 */
export function extract(options: extract.Options): Hex.Hex {
  const { ikm, salt } = options
  const prk = hkdf_extract(
    sha256,
    Bytes.from(ikm),
    salt === undefined ? undefined : Bytes.from(salt),
  )
  return Hex.fromBytes(prk)
}

export declare namespace extract {
  /** Options for {@link extract}. */
  type Options = {
    /** Input keying material (typically a Diffie-Hellman shared secret). */
    ikm: Hex.Hex | Bytes.Bytes
    /** Optional salt; treated as `HashLen` zero bytes when omitted (RFC 5869 §2.2). */
    salt?: Hex.Hex | Bytes.Bytes | undefined
  }
}

/**
 * Run the HKDF-Expand step (RFC 5869 §2.3): expand a pseudorandom key into
 * `length` bytes of output keying material under an optional `info` label.
 *
 * @example
 * ```ts
 * import { Kdf } from 'handshakes'
 *
 * const okm = Kdf.expand({ prk: '0x...', info: '0xf0f1f2...', length: 42 })
 * ```
 */
export function expand(options: expand.Options): Hex.Hex {
  const { prk, info, length } = options
  const okm = hkdf_expand(
    sha256,
    Bytes.from(prk),
    info === undefined ? undefined : Bytes.from(info),
    length,
  )
  return Hex.fromBytes(okm)
}

export declare namespace expand {
  /** Options for {@link expand}. */
  type Options = {
    /** Pseudorandom key produced by {@link extract}. */
    prk: Hex.Hex | Bytes.Bytes
    /** Optional context/application-specific label (RFC 5869 §2.3). */
    info?: Hex.Hex | Bytes.Bytes | undefined
    /** Output length in bytes. RFC 5869 §2.3 caps this at `255 * HashLen` (8160 for SHA-256). */
    length: number
  }
}

/**
 * Convenience wrapper: derive `length` bytes of output keying material from
 * an initial input in a single call (`extract` then `expand`).
 *
 * @example
 * ```ts
 * import { Kdf } from 'handshakes'
 *
 * const sessionKey = Kdf.derive({
 *   ikm: shared,
 *   salt: '0x...',
 *   info: '0x...',
 *   length: 32,
 * })
 * ```
 */
export function derive(options: derive.Options): Hex.Hex {
  return expand({ prk: extract({ ikm: options.ikm, salt: options.salt }), ...options })
}

export declare namespace derive {
  /** Options for {@link derive}. */
  type Options = extract.Options & Omit<expand.Options, 'prk'>
}
