/**
 * Wire helpers for the `mobile-link` transport: base64url JSON framing,
 * the host long-term identity signature (`identity_sig`, spec §4.3), and
 * per-direction AEAD seal/open bound to the host's pinned identity key.
 *
 * Mobile Link derives its session keys with `transportId: 'mobile-link'`
 * and `transportContext` = the raw 32 bytes of the host's Ed25519
 * `identity_pubkey` (spec §5.6), so a handshake against a host whose
 * identity differs from the pinned value fails AEAD closed.
 */

import { Base64, Bytes, Ed25519, Hash, Hex } from 'ox'

import * as Aad from '../core/Aad.js'
import * as Aead from '../core/Aead.js'
import * as Crypto from '../core/Crypto.js'
import * as Envelope from '../core/Envelope.js'
import * as Session from '../core/Session.js'
import type * as Transport from '../core/Transport.js'

/** uRPC `mobile-link` transport identifier mixed into the HKDF `info`. */
export const transportId = 'mobile-link'

/** Domain-separation label prefixed to the host {@link identityMessage}. */
export const identityLabel = 'urpc/mobile-host-identity/v1'

/** Decodes a base64url JSON payload. */
export function decodeJson(value: string): unknown {
  return JSON.parse(Bytes.toString(Base64.toBytes(value)))
}

/** Encodes a JSON payload as unpadded base64url. */
export function encodeJson(value: unknown): string {
  return Base64.fromBytes(Bytes.fromString(JSON.stringify(value)), { pad: false, url: true })
}

/**
 * Build the host identity-signature message (spec §4.3.4):
 *
 * ```text
 * "urpc/mobile-host-identity/v1" || pubkey_consumer || pubkey_host || SHA-256(shared)
 * ```
 */
export function identityMessage(options: identityMessage.Options): Bytes.Bytes {
  const label = Bytes.fromString(identityLabel)
  const consumer = Bytes.from(options.publicKeyConsumer)
  const host = Bytes.from(options.publicKeyHost)
  const digest = Hash.sha256(Bytes.from(options.shared), { as: 'Bytes' })
  const out = new Uint8Array(label.length + consumer.length + host.length + digest.length)
  out.set(label, 0)
  out.set(consumer, label.length)
  out.set(host, label.length + consumer.length)
  out.set(digest, label.length + consumer.length + host.length)
  return out
}

export declare namespace identityMessage {
  /** Options for {@link identityMessage}. */
  type Options = {
    /** Consumer ephemeral X25519 public key (raw 32 bytes). */
    publicKeyConsumer: Hex.Hex | Bytes.Bytes
    /** Host ephemeral X25519 public key (raw 32 bytes). */
    publicKeyHost: Hex.Hex | Bytes.Bytes
    /** X25519 shared secret derived by both peers. */
    shared: Hex.Hex | Bytes.Bytes
  }
}

/**
 * Sign the host {@link identityMessage} under the host's long-term
 * Ed25519 identity key, returning the raw 64-byte signature.
 */
export function signIdentity(options: signIdentity.Options): Bytes.Bytes {
  return options.identity.sign(identityMessage(options))
}

export declare namespace signIdentity {
  /** Options for {@link signIdentity}. */
  type Options = identityMessage.Options & {
    /** Host application identity bound by `Wata.create({ identity })`. */
    identity: Transport.Identity
  }
}

/**
 * Verify the host's `identity_sig` against the `identity_pubkey` pinned
 * from the host's `host.json` (spec §4.3.5).
 */
export function verifyIdentity(options: verifyIdentity.Options): boolean {
  return Ed25519.verify({
    payload: identityMessage(options),
    publicKey: options.identityPublicKey,
    signature: options.signature,
  })
}

export declare namespace verifyIdentity {
  /** Options for {@link verifyIdentity}. */
  type Options = identityMessage.Options & {
    /** Host's long-term Ed25519 identity public key (raw 32 bytes). */
    identityPublicKey: Hex.Hex | Bytes.Bytes
    /** Detached 64-byte Ed25519 signature from the callback `identity_sig`. */
    signature: Hex.Hex | Bytes.Bytes
  }
}

/**
 * Derive the per-direction AEAD keys for a mobile-link session, binding
 * them to the host's long-term `identity_pubkey` via `transportContext`.
 */
export function deriveKeys(options: deriveKeys.Options): Session.derive.ReturnType {
  return Session.derive({
    peer: { publicKey: options.peerPublicKey },
    role: options.role,
    self: options.self,
    transportContext: options.identityPublicKey,
    transportId,
  })
}

export declare namespace deriveKeys {
  /** Options for {@link deriveKeys}. */
  type Options = {
    /** Host's long-term Ed25519 identity public key (raw 32 bytes). */
    identityPublicKey: Hex.Hex | Bytes.Bytes
    /** Peer ephemeral X25519 public key. */
    peerPublicKey: Hex.Hex | Bytes.Bytes
    /** Local role. */
    role: 'consumer' | 'host'
    /** Local ephemeral X25519 keypair. */
    self: Crypto.X25519Keypair
  }
}

/**
 * Seal a Core message into an `encrypted` envelope under a per-direction
 * key and nonce. The AAD anchors the ciphertext to the consumer's
 * X25519 public key and the sender role (Core §6).
 */
export function seal(options: seal.Options): Envelope.Envelope {
  const { envelope, from, key, nonce, publicKeyConsumer } = options
  const ciphertext = Aead.seal({
    aad: Aad.encode({
      publicKey: publicKeyConsumer,
      role: from === Envelope.from.host ? Aad.role.host : Aad.role.consumer,
    }),
    key,
    nonce,
    plaintext: Bytes.fromString(JSON.stringify(envelope)),
  })
  return Envelope.encrypted({ ciphertext, from, nonce })
}

export declare namespace seal {
  /** Options for {@link seal}. */
  type Options = {
    /** Core message to encrypt as the AEAD plaintext. */
    envelope: Envelope.Envelope
    /** Sender role. */
    from: Envelope.From
    /** Per-direction AEAD key for the sender's direction. */
    key: Hex.Hex | Bytes.Bytes
    /** Outbound 12-byte nonce. */
    nonce: Hex.Hex | Bytes.Bytes
    /** Consumer ephemeral X25519 public key (the AAD session anchor). */
    publicKeyConsumer: Hex.Hex | Bytes.Bytes
  }
}

/**
 * Open an inbound `encrypted` envelope under a per-direction key,
 * returning the decoded inner Core message. The caller is responsible
 * for nonce high-water-mark enforcement before calling this.
 */
export function open(options: open.Options): Envelope.Envelope {
  const { encrypted, key, publicKeyConsumer } = options
  const frame = Envelope.toEncrypted(encrypted)
  const plaintext = Aead.open({
    aad: Aad.encode({
      publicKey: publicKeyConsumer,
      role: frame.from === Envelope.from.host ? Aad.role.host : Aad.role.consumer,
    }),
    ciphertext: frame.ciphertext,
    key,
    nonce: frame.nonce,
  })
  return Envelope.parse(JSON.parse(Bytes.toString(Bytes.from(plaintext))))
}

export declare namespace open {
  /** Options for {@link open}. */
  type Options = {
    /** Parsed inbound `encrypted` envelope. */
    encrypted: Extract<Envelope.Envelope, { type: 'encrypted' }>
    /** Per-direction AEAD key for the sender's direction. */
    key: Hex.Hex | Bytes.Bytes
    /** Consumer ephemeral X25519 public key (the AAD session anchor). */
    publicKeyConsumer: Hex.Hex | Bytes.Bytes
  }
}
