/**
 * uRPC session-key derivation.
 *
 * Per [uRPC `core.md` §5](https://github.com/tempoxyz/urpc/blob/main/specs/core.md#key-agreement-and-derivation),
 * each peer derives a pair of 32-byte ChaCha20-Poly1305 keys — one per
 * direction — from a single X25519 ECDH shared secret:
 *
 * ```text
 * shared = X25519(self_sk, peer_pk)          ← abort if all-zero
 *
 * enc_key_consumer_to_host = HKDF-SHA256(
 *   IKM  = shared,
 *   salt = pubkey_consumer,                  ← raw 32 bytes (X25519 form)
 *   info = "urpc/v1/" || transport_id || "/c2h"
 *          || pubkey_host || transport_context,
 *   L = 32
 * )
 *
 * enc_key_host_to_consumer = HKDF-SHA256(   ← same but "/h2c"
 *   ...
 * )
 * ```
 *
 * - `transport_id` is a per-transport ASCII identifier (`"relay"`,
 *   `"mobile-link"`, `"mobile-web-auth"`, …). Transports that don't
 *   encrypt (`window`, `device-code`) skip session derivation entirely.
 * - `transport_context` is per-transport anti-MITM material (e.g. the
 *   relay `pairing_secret`, the mobile-link host `identity_pubkey`).
 *   Defaults to empty bytes.
 *
 * Both peers derive the same two keys; each side picks `c2h` or `h2c`
 * based on which side it is sealing for / opening from.
 */

import { Bytes, Hex, X25519 } from 'ox'

import * as Errors from './Errors.js'
import * as Kdf from './Kdf.js'

/** Length of each derived AEAD key in bytes (matches ChaCha20-Poly1305). */
export const keySize = 32

/** ASCII version prefix bound to every `info` blob. */
export const infoPrefix = 'urpc/v1/'

/** Direction tag values used in the HKDF `info` blob. */
export const direction = {
  /** Consumer → host. */
  c2h: 'c2h',
  /** Host → consumer. */
  h2c: 'h2c',
} as const

/** Discriminant for the HKDF `info` direction tag. */
export type Direction = (typeof direction)[keyof typeof direction]

const encoder = new TextEncoder()

/**
 * Compute the X25519 ECDH shared secret between a local private scalar
 * and a peer public key. Throws {@link Errors.ProtocolError} if the
 * underlying `@noble/curves` call rejects (low-order public key /
 * all-zero output).
 *
 * @example
 * ```ts
 * import { Session } from 'wata'
 *
 * const secret = Session.shared({ privateKey, publicKey: peerPublicKey })
 * ```
 */
export function shared(options: shared.Options): Hex.Hex {
  try {
    return X25519.getSharedSecret({
      privateKey: options.privateKey,
      publicKey: options.publicKey,
    })
  } catch (cause) {
    throw new Errors.ProtocolError('X25519 ECDH rejected (low-order key or all-zero shared)', {
      cause: cause as Error,
    })
  }
}

export declare namespace shared {
  /** Options for {@link shared}. */
  type Options = {
    /** Local X25519 private scalar. */
    privateKey: Hex.Hex | Bytes.Bytes
    /** Peer X25519 public key. */
    publicKey: Hex.Hex | Bytes.Bytes
  }
}

/**
 * Derive both per-direction AEAD keys for a session. Returns a `{ c2h,
 * h2c }` record; both peers compute identical values, each side chooses
 * which key to use for sealing vs opening based on its own role.
 *
 * @example
 * ```ts
 * import { Crypto, Session } from 'wata'
 *
 * const self = Crypto.randomKeypair()
 * const { c2h, h2c } = Session.derive({
 *   role: 'consumer',
 *   self: self.x25519,
 *   peer: { publicKey: hostX25519Public },
 *   transportId: 'relay',
 *   transportContext: pairingSecret,
 * })
 * ```
 */
export function derive(options: derive.Options): derive.ReturnType {
  const { peer, role, self, transportContext, transportId } = options

  const publicKey_consumer = role === 'consumer' ? self.publicKey : peer.publicKey
  const publicKey_host = role === 'consumer' ? peer.publicKey : self.publicKey

  const ikm = shared({ privateKey: self.privateKey, publicKey: peer.publicKey })

  function deriveOne(tag: Direction): Hex.Hex {
    return Kdf.derive({
      ikm,
      info: buildInfo({ direction: tag, publicKey_host, transportContext, transportId }),
      length: keySize,
      salt: publicKey_consumer,
    })
  }

  return { c2h: deriveOne(direction.c2h), h2c: deriveOne(direction.h2c) }
}

export declare namespace derive {
  /** Options for {@link derive}. */
  type Options = {
    /** Peer X25519 public key. */
    peer: { publicKey: Hex.Hex | Bytes.Bytes }
    /** Local role (`'consumer'` or `'host'`). */
    role: 'consumer' | 'host'
    /** Local X25519 keypair (typically `Crypto.randomKeypair().x25519`). */
    self: {
      privateKey: Hex.Hex | Bytes.Bytes
      publicKey: Hex.Hex | Bytes.Bytes
    }
    /** Per-transport anti-MITM material (default: empty bytes). */
    transportContext?: Hex.Hex | Bytes.Bytes | undefined
    /** Per-transport ASCII identifier (`'relay'`, `'mobile-link'`, …). */
    transportId: string
  }

  /** Result of {@link derive}. */
  type ReturnType = {
    /** 32-byte AEAD key for consumer→host frames. */
    c2h: Hex.Hex
    /** 32-byte AEAD key for host→consumer frames. */
    h2c: Hex.Hex
  }
}

/**
 * Build the spec's HKDF `info` blob:
 *
 * ```text
 * "urpc/v1/" || transport_id || "/" || direction || pubkey_host || transport_context
 * ```
 *
 * Exposed for testing and for transport-specific helpers that need the
 * raw bytes (e.g. when computing additional derived secrets bound to the
 * same context).
 */
export function buildInfo(options: buildInfo.Options): Hex.Hex {
  const { direction: tag, publicKey_host, transportContext, transportId } = options
  const prefix = encoder.encode(`${infoPrefix}${transportId}/${tag}`)
  const hostBytes = Bytes.from(publicKey_host)
  const ctxBytes = transportContext === undefined ? new Uint8Array(0) : Bytes.from(transportContext)

  const out = new Uint8Array(prefix.length + hostBytes.length + ctxBytes.length)
  out.set(prefix, 0)
  out.set(hostBytes, prefix.length)
  out.set(ctxBytes, prefix.length + hostBytes.length)
  return Hex.fromBytes(out)
}

export declare namespace buildInfo {
  /** Options for {@link buildInfo}. */
  type Options = {
    /** Direction tag (`c2h` or `h2c`). */
    direction: Direction
    /** Host's X25519 public key. */
    publicKey_host: Hex.Hex | Bytes.Bytes
    /** Per-transport anti-MITM material (default: empty). */
    transportContext?: Hex.Hex | Bytes.Bytes | undefined
    /** Per-transport ASCII identifier. */
    transportId: string
  }
}
