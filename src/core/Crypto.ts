/**
 * Low-level crypto primitives used by the uRPC transport layer.
 *
 * Per [uRPC `core.md` §3–4](https://github.com/tempoxyz/urpc/blob/main/specs/core.md),
 * each peer generates **one ephemeral Ed25519 keypair per session**. The same
 * keypair signs transport-level proofs (relay RFC 9421 auth, mobile-link
 * `identity_sig`, …) AND, converted to Montgomery form via the standard
 * birational map, drives X25519 key agreement.
 *
 * Surface:
 *
 * - {@link randomKeypair} — fresh Ed25519 keypair plus its derived X25519
 *   form. The X25519 public key is the canonical session anchor
 *   (`pubkey_consumer` in spec terms).
 * - {@link toX25519} — convert any Ed25519 keypair (or just a public key)
 *   into its X25519 counterpart. Useful for re-deriving the on-the-wire
 *   form of a peer's identity key after fetching `host.json` /
 *   `consumer.json`.
 *
 * Higher-level concerns (HKDF derivation, AEAD wrap/unwrap, nonce discipline)
 * live in `Kdf`, `Aead`, and `Nonce` so each module stays single-purpose and
 * tree-shakeable.
 */

import { Ed25519, Hex } from 'ox'

/**
 * X25519 keypair derived from an Ed25519 keypair.
 *
 * Every {@link Keypair} carries one of these. The public key is the raw
 * 32-byte Montgomery-form key the spec refers to as `pubkey_consumer`
 * (or `pubkey_host`); the private scalar feeds the X25519 ECDH step.
 */
export type X25519Keypair = {
  /** Raw 32-byte X25519 public key (`pubkey_consumer` per TempoCP §4). */
  publicKey: Hex.Hex
  /** X25519 scalar (32 bytes hex). Input to the X25519 ECDH step. */
  privateKey: Hex.Hex
}

/**
 * Session keypair. The Ed25519 halves are the protocol's canonical
 * identity for signing; the {@link x25519} halves are the on-the-wire
 * form used for key agreement.
 */
export type Keypair = {
  /** Ed25519 public key (32 bytes hex). Used to verify signatures from this peer. */
  publicKey: Hex.Hex
  /** Ed25519 private seed (32 bytes hex). Used to sign and to derive {@link x25519}. */
  privateKey: Hex.Hex
  /** Derived X25519 keypair for ECDH. */
  x25519: X25519Keypair
}

/**
 * Generate a fresh ephemeral session keypair.
 *
 * Both peers create one of these at session bootstrap. The Ed25519 halves
 * are used for transport-level signatures (relay, mobile-link); the
 * derived X25519 halves are exchanged inside the bootstrap envelope and
 * fed into the HKDF / AEAD layer.
 *
 * @example
 * ```ts
 * import { Crypto } from 'handshakes'
 *
 * const keypair = Crypto.randomKeypair()
 * keypair.publicKey       // Ed25519 public key
 * keypair.privateKey      // Ed25519 private seed
 * keypair.x25519.publicKey  // raw X25519 public key (= pubkey_consumer)
 * keypair.x25519.privateKey // X25519 scalar
 * ```
 */
export function randomKeypair(): Keypair {
  const ed = Ed25519.createKeyPair()
  return { ...ed, x25519: toX25519(ed) }
}

/**
 * Convert an Ed25519 keypair (or just a public key) into its X25519
 * Montgomery-form counterpart via the standard birational map.
 *
 * Pass `{ publicKey }` to convert a peer's identity key (e.g. after
 * fetching `host.json`) into the form needed for ECDH. Pass
 * `{ publicKey, privateKey }` to convert a local keypair.
 *
 * @example
 * ```ts
 * import { Crypto } from 'handshakes'
 *
 * // peer key, public-only
 * const peer = Crypto.toX25519({ publicKey: '0x...' })
 *
 * // local keypair
 * const self = Crypto.toX25519({ publicKey: '0x...', privateKey: '0x...' })
 * ```
 */
export function toX25519(
  options: toX25519.Options & { privateKey: Hex.Hex },
): X25519Keypair
export function toX25519(options: toX25519.Options): { publicKey: Hex.Hex }
export function toX25519(options: toX25519.Options): {
  publicKey: Hex.Hex
  privateKey?: Hex.Hex
} {
  const publicKey = Ed25519.toX25519PublicKey({ publicKey: options.publicKey })
  if (options.privateKey === undefined) return { publicKey }
  const privateKey = Ed25519.toX25519PrivateKey({ privateKey: options.privateKey })
  return { publicKey, privateKey }
}

export declare namespace toX25519 {
  /** Options for {@link toX25519}. */
  type Options = {
    /** Ed25519 public key (32 bytes hex). */
    publicKey: Hex.Hex
    /** Optional Ed25519 private seed (32 bytes hex). */
    privateKey?: Hex.Hex | undefined
  }
}
