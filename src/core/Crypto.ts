/**
 * Low-level crypto primitives used by the TempoCP transport layer.
 *
 * - `randomKeypair` generates a fresh X25519 session keypair (used by every
 *   peer at session bootstrap).
 *
 * Higher-level concerns (HKDF derivation, AEAD wrap/unwrap, nonce discipline)
 * live in `Kdf`, `Aead`, and `Nonce` so each module stays single-purpose and
 * tree-shakeable.
 */

import { Hex, X25519 } from 'ox'

/**
 * Generate a fresh X25519 session keypair.
 *
 * Both peers create one of these at session bootstrap; the public halves are
 * exchanged inside the bootstrap envelope and the private halves stay local
 * for the lifetime of the session.
 *
 * @example
 * ```ts
 * import { Crypto } from 'handshakes'
 *
 * const { publicKey, privateKey } = Crypto.randomKeypair()
 * ```
 */
export function randomKeypair(): randomKeypair.ReturnType {
  return X25519.createKeyPair()
}

export declare namespace randomKeypair {
  /** Result of {@link randomKeypair}. */
  type ReturnType = {
    /** X25519 public key (32 bytes), encoded as `0x`-prefixed hex. */
    publicKey: Hex.Hex
    /** X25519 private scalar (32 bytes), encoded as `0x`-prefixed hex. */
    privateKey: Hex.Hex
  }
}
