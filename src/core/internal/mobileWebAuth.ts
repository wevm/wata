import { Base64, Bytes, Hex } from 'ox'

import * as Aad from '../Aad.js'
import * as Aead from '../Aead.js'
import * as Envelope from '../Envelope.js'
import * as Errors from '../Errors.js'
import * as Nonce from '../Nonce.js'

/** Transport identifier bound into `mobile-web-auth` session-key derivation. */
export const transportId = 'mobile-web-auth'

const decoder = new TextDecoder()

/** Encode a normalized envelope as the URL-safe `message` parameter. */
export function encodeMessage(envelope: Envelope.Envelope): string {
  return Base64.fromBytes(Bytes.fromString(JSON.stringify(envelope)), { pad: false, url: true })
}

/** Decode the URL-safe `message` parameter into a normalized envelope. */
export function decodeMessage(value: string): Envelope.Envelope {
  try {
    return Envelope.parse(JSON.parse(decoder.decode(Base64.toBytes(value))))
  } catch (cause) {
    throw new Errors.ProtocolError('invalid mobile-web-auth message frame', {
      cause: cause as Error,
    })
  }
}

/** Encode an X25519 public key for URL transport. */
export function encodePublicKey(publicKey: Hex.Hex | Bytes.Bytes): string {
  return Base64.fromBytes(Bytes.from(publicKey), { pad: false, url: true })
}

/** Decode an X25519 public key from URL transport. */
export function decodePublicKey(value: string): Hex.Hex {
  try {
    const publicKey = Base64.toBytes(value)
    if (publicKey.length !== Aad.publicKeySize)
      throw new Errors.ProtocolError('mobile-web-auth public key must be 32 bytes', {
        details: `received ${publicKey.length} bytes`,
      })
    return Hex.fromBytes(publicKey)
  } catch (cause) {
    if (cause instanceof Errors.BaseError) throw cause
    throw new Errors.ProtocolError('invalid mobile-web-auth public key', {
      cause: cause as Error,
    })
  }
}

/** Seal a plaintext envelope for the mobile-web-auth callback frame. */
export function seal(options: seal.Options): Envelope.Envelope {
  const { envelope, from, key, publicKey, nonce = Nonce.fromCounter(1n) } = options
  return Envelope.encrypted({
    ciphertext: Aead.seal({
      aad: Aad.encode({ publicKey, role: roleFor(from) }),
      key,
      nonce,
      plaintext: Bytes.fromString(JSON.stringify(envelope)),
    }),
    from,
    nonce,
  })
}

export declare namespace seal {
  /** Options for {@link seal}. */
  type Options = {
    /** Plaintext envelope to encrypt. */
    envelope: Envelope.Envelope
    /** Sender role mirrored into the encrypted envelope. */
    from: Envelope.From
    /** Directional AEAD key. */
    key: Hex.Hex | Bytes.Bytes
    /** Optional explicit nonce. Defaults to the first session nonce. */
    nonce?: Hex.Hex | Bytes.Bytes | undefined
    /** Consumer X25519 public key bound into AAD. */
    publicKey: Hex.Hex | Bytes.Bytes
  }
}

/** Open an encrypted mobile-web-auth callback frame. */
export function open(options: open.Options): Envelope.Envelope {
  const { expectedFrom, envelope, key, publicKey } = options
  if (envelope.type !== 'encrypted')
    throw new Errors.ProtocolError('mobile-web-auth callback message must be encrypted')
  const encrypted = Envelope.toEncrypted(envelope)
  if (encrypted.from !== expectedFrom)
    throw new Errors.ProtocolError('mobile-web-auth encrypted frame sender mismatch', {
      details: `expected ${expectedFrom}, received ${encrypted.from}`,
    })
  const nonceDecoder = options.nonceDecoder ?? Nonce.decoder()
  nonceDecoder.accept(encrypted.nonce)
  const plaintext = Aead.open({
    aad: Aad.encode({ publicKey, role: roleFor(expectedFrom) }),
    ciphertext: encrypted.ciphertext,
    key,
    nonce: encrypted.nonce,
  })
  return Envelope.parse(JSON.parse(decoder.decode(Bytes.from(plaintext))))
}

export declare namespace open {
  /** Options for {@link open}. */
  type Options = {
    /** Encrypted envelope received from the peer. */
    envelope: Envelope.Envelope
    /** Expected sender role. */
    expectedFrom: Envelope.From
    /** Directional AEAD key. */
    key: Hex.Hex | Bytes.Bytes
    /** Optional nonce decoder enforcing replay discipline. */
    nonceDecoder?: Nonce.decoder.ReturnType | undefined
    /** Consumer X25519 public key bound into AAD. */
    publicKey: Hex.Hex | Bytes.Bytes
  }
}

function roleFor(from: Envelope.From): Aad.Role {
  if (from === Envelope.from.consumer) return Aad.role.consumer
  return Aad.role.host
}
