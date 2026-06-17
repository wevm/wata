import { Base64, Bytes } from 'ox'

import * as Aad from '../core/Aad.js'
import * as Aead from '../core/Aead.js'
import * as Crypto from '../core/Crypto.js'
import * as Envelope from '../core/Envelope.js'
import * as Errors from '../core/Errors.js'
import * as Nonce from '../core/Nonce.js'
import * as SessionKey from '../core/SessionKey.js'

/** Decodes a base64url JSON payload. */
export function decodeJson(value: string): unknown {
  return JSON.parse(Bytes.toString(Base64.toBytes(value)))
}

/** Encodes a JSON payload as unpadded base64url. */
export function encodeJson(value: unknown): string {
  return Base64.fromBytes(Bytes.fromString(JSON.stringify(value)), { pad: false, url: true })
}

/** Opens a host-to-consumer encrypted callback response. */
export function openResponse(options: openResponse.Options): Envelope.Envelope {
  const encrypted = Envelope.parse(decodeJson(options.message))
  if (encrypted.type !== 'encrypted')
    throw new Errors.ProtocolError('callback message must be encrypted')
  if (encrypted.payload.from !== 'host')
    throw new Errors.ProtocolError('callback message must be from host')
  const keys = SessionKey.derive({
    peer: { publicKey: options.publicKey },
    role: 'consumer',
    self: options.self,
    transportId: 'mobile-web-auth',
  })
  const frame = Envelope.toEncrypted(encrypted)
  if (Nonce.toCounter(frame.nonce) !== 1n)
    throw new Errors.ProtocolError('callback nonce must be 1')
  const plaintext = Aead.open({
    aad: Aad.encode({ publicKey: options.self.publicKey, role: Aad.role.host }),
    ciphertext: frame.ciphertext,
    key: keys.h2c,
    nonce: frame.nonce,
  })
  const envelope = Envelope.parse(JSON.parse(Bytes.toString(Bytes.from(plaintext))))
  if (envelope.type !== 'rpc-responses')
    throw new Errors.ProtocolError('callback plaintext must be rpc-responses')
  return envelope
}

export declare namespace openResponse {
  /** Options for {@link openResponse}. */
  type Options = {
    /** Base64url-encoded encrypted callback message. */
    message: string
    /** Host ephemeral X25519 public key. */
    publicKey: Crypto.X25519Keypair['publicKey']
    /** Consumer ephemeral X25519 keypair. */
    self: Crypto.X25519Keypair
  }
}

/** Seals a host-to-consumer callback response. */
export function sealResponse(options: sealResponse.Options): Envelope.Envelope {
  const keys = SessionKey.derive({
    peer: { publicKey: options.publicKey },
    role: 'host',
    self: options.self,
    transportId: 'mobile-web-auth',
  })
  const nonce = Nonce.fromCounter(1n)
  const ciphertext = Aead.seal({
    aad: Aad.encode({ publicKey: options.publicKey, role: Aad.role.host }),
    key: keys.h2c,
    nonce,
    plaintext: Bytes.fromString(JSON.stringify(options.response)),
  })
  return Envelope.encrypted({
    ciphertext,
    from: 'host',
    nonce,
  })
}

export declare namespace sealResponse {
  /** Options for {@link sealResponse}. */
  type Options = {
    /** Consumer ephemeral X25519 public key. */
    publicKey: Crypto.X25519Keypair['publicKey']
    /** JSON-RPC response envelope to encrypt. */
    response: Envelope.Envelope
    /** Host ephemeral X25519 keypair. */
    self: Crypto.X25519Keypair
  }
}
