/**
 * AEAD (Authenticated Encryption with Associated Data) primitives used by
 * the uRPC transport layer.
 *
 * Pinned to **ChaCha20-Poly1305** (RFC 8439): 32-byte key, 12-byte nonce,
 * 16-byte authentication tag appended to the ciphertext. The protocol does
 * not negotiate cipher suites — every peer speaks this one.
 *
 * Higher-level concerns:
 * - Nonce derivation lives in {@link "./Nonce"} (per-direction counter).
 * - AAD construction lives in {@link "./Aad"} (binds the protocol version,
 *   `pubkey_consumer`, and sender role to the ciphertext).
 * - Wire framing lives in {@link "./Envelope"}.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { Bytes, Hex } from 'ox'

import * as Errors from './Errors.js'

/** Length of the ChaCha20-Poly1305 key in bytes. */
export const keySize = 32

/** Length of the ChaCha20-Poly1305 nonce in bytes (RFC 8439 §2.8 IETF variant). */
export const nonceSize = 12

/** Length of the Poly1305 authentication tag appended to each ciphertext. */
export const tagSize = 16

/**
 * Encrypt `plaintext` under `key` and `nonce`, optionally binding `aad`
 * to the ciphertext via the Poly1305 tag.
 *
 * Returns the ciphertext with the 16-byte tag appended (RFC 8439 §2.8).
 *
 * @example
 * ```ts
 * import { Aead } from 'handshakes'
 *
 * const ciphertext = Aead.seal({
 *   key: '0x...32-byte-key...',
 *   nonce: '0x...12-byte-nonce...',
 *   aad: '0x...session-bound-context...',
 *   plaintext: '0xdeadbeef',
 * })
 * ```
 */
export function seal(options: seal.Options): Hex.Hex {
  const { key, nonce, aad, plaintext } = options
  const cipher = chacha20poly1305(
    Bytes.from(key),
    Bytes.from(nonce),
    aad === undefined ? undefined : Bytes.from(aad),
  )
  return Hex.fromBytes(cipher.encrypt(Bytes.from(plaintext)))
}

export declare namespace seal {
  /** Options for {@link seal}. */
  type Options = {
    /**
     * Additional authenticated data to bind to the ciphertext via the
     * Poly1305 tag. Not encrypted — both peers must agree on this value.
     */
    aad?: Hex.Hex | Bytes.Bytes | undefined
    /** ChaCha20-Poly1305 32-byte key. */
    key: Hex.Hex | Bytes.Bytes
    /** ChaCha20-Poly1305 12-byte nonce. */
    nonce: Hex.Hex | Bytes.Bytes
    /** Plaintext bytes to encrypt. */
    plaintext: Hex.Hex | Bytes.Bytes
  }
}

/**
 * Decrypt and authenticate `ciphertext` under `key` and `nonce`. The trailing
 * 16-byte tag is verified against `aad` (if any) and rejected as
 * {@link OpenError} on mismatch.
 *
 * @example
 * ```ts
 * import { Aead } from 'handshakes'
 *
 * const plaintext = Aead.open({
 *   key: '0x...',
 *   nonce: '0x...',
 *   aad: '0x...',
 *   ciphertext: '0x...ciphertext-plus-16-byte-tag...',
 * })
 * ```
 */
export function open(options: open.Options): Hex.Hex {
  const { key, nonce, aad, ciphertext } = options
  const cipher = chacha20poly1305(
    Bytes.from(key),
    Bytes.from(nonce),
    aad === undefined ? undefined : Bytes.from(aad),
  )
  try {
    return Hex.fromBytes(cipher.decrypt(Bytes.from(ciphertext)))
  } catch (cause) {
    throw new OpenError('AEAD authentication failed', { cause: cause as Error })
  }
}

export declare namespace open {
  /** Options for {@link open}. */
  type Options = {
    /** AAD that was bound by {@link seal}; must match exactly or decryption fails. */
    aad?: Hex.Hex | Bytes.Bytes | undefined
    /** Ciphertext (with 16-byte tag appended) to decrypt and verify. */
    ciphertext: Hex.Hex | Bytes.Bytes
    /** ChaCha20-Poly1305 32-byte key. */
    key: Hex.Hex | Bytes.Bytes
    /** ChaCha20-Poly1305 12-byte nonce, matching the value used by {@link seal}. */
    nonce: Hex.Hex | Bytes.Bytes
  }
}

/**
 * Thrown when AEAD decryption fails (tag mismatch, truncated ciphertext, or
 * wrong key). Always indicates either tampered traffic or a key/nonce
 * desynchronization between peers.
 */
export class OpenError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'Aead.OpenError'
}
