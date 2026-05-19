/**
 * URL-frame helpers shared by the consumer and host `mobileLink` adapters.
 */

import { Base64, Bytes, Ed25519, Hex } from 'ox'
import { z } from 'zod/mini'

import * as Envelope from '../Envelope.js'
import * as Errors from '../Errors.js'
import * as Schema from '../Schema.js'

const decoder = new TextDecoder()
const encoder = new TextEncoder()
const queryParam = 'urpc'
const signatureDomain = 'urpc/v1/mobile-link/identity_sig'

/** Runtime schemas for mobile-link URL frames. */
export namespace schema {
  /** Non-empty base64url byte string. */
  export const bytes = z.string().check(z.regex(/^[A-Za-z0-9_-]+={0,2}$/))

  /** Consumer-to-host bootstrap frame. */
  export const bootstrap = z.object({
    callback_url: z.string().check(z.minLength(1)),
    pubkey_consumer: bytes,
    session: z.string().check(z.minLength(1)),
    type: z.literal('bootstrap'),
  })

  /** Encrypted frame carried in either direction after bootstrap. */
  export const message = z.object({
    message: Envelope.schema.encrypted,
    session: z.string().check(z.minLength(1)),
    type: z.literal('message'),
  })

  /** Host-to-consumer readiness and identity proof frame. */
  export const ready = z.object({
    identity_sig: bytes,
    pubkey_host: bytes,
    session: z.string().check(z.minLength(1)),
    type: z.literal('ready'),
  })

  /** Any mobile-link frame. */
  export const frame = z.discriminatedUnion('type', [bootstrap, message, ready])
}

/** Consumer-to-host bootstrap frame. */
export type BootstrapFrame = z.output<typeof schema.bootstrap>

/** Any mobile-link URL frame. */
export type Frame = z.output<typeof schema.frame>

/** Host-to-consumer readiness and identity proof frame. */
export type ReadyFrame = z.output<typeof schema.ready>

/** Append an encoded mobile-link frame to a URL. */
export function append(url: string, frame: Frame): string {
  const next = new URL(url)
  next.searchParams.set(queryParam, encode(frame))
  return next.toString()
}

/** Encode a mobile-link frame as unpadded base64url JSON. */
export function encode(frame: Frame): string {
  return Base64.fromBytes(encoder.encode(JSON.stringify(frame)), { pad: false, url: true })
}

/** Decode an encoded mobile-link frame. */
export function decode(value: string): Frame {
  try {
    return Schema.validate(schema.frame, JSON.parse(decoder.decode(Base64.toBytes(value))))
  } catch (cause) {
    throw new Errors.ProtocolError('invalid mobileLink frame', { cause: cause as Error })
  }
}

/** Read and decode the `urpc` query parameter from a URL. */
export function read(url: string | URL): Frame {
  const value = new URL(url).searchParams.get(queryParam)
  if (!value) throw new Errors.ProtocolError('mobileLink URL is missing `urpc`')
  return decode(value)
}

/** Sign the host readiness key share with the host identity key. */
export function signIdentity(options: signIdentity.Options): string {
  const signature = Ed25519.sign({
    as: 'Bytes',
    payload: signaturePayload(options),
    privateKey: options.privateKey,
  })
  return Base64.fromBytes(signature, { pad: false, url: true })
}

export declare namespace signIdentity {
  /** Options for {@link signIdentity}. */
  type Options = {
    /** Consumer ephemeral X25519 public key, base64url encoded. */
    publicKey_consumer: string
    /** Host ephemeral X25519 public key, base64url encoded. */
    publicKey_host: string
    /** Host long-term Ed25519 private seed. */
    privateKey: Hex.Hex
    /** Mobile-link session identifier. */
    session: string
  }
}

/** Verify the host readiness key share against the host identity key. */
export function verifyIdentity(options: verifyIdentity.Options): boolean {
  try {
    return Ed25519.verify({
      payload: signaturePayload(options),
      publicKey: options.publicKey_identity,
      signature: Base64.toBytes(options.signature),
    })
  } catch {
    return false
  }
}

export declare namespace verifyIdentity {
  /** Options for {@link verifyIdentity}. */
  type Options = {
    /** Host long-term Ed25519 public key. */
    publicKey_identity: Hex.Hex
    /** Consumer ephemeral X25519 public key, base64url encoded. */
    publicKey_consumer: string
    /** Host ephemeral X25519 public key, base64url encoded. */
    publicKey_host: string
    /** Host readiness signature, base64url encoded. */
    signature: string
    /** Mobile-link session identifier. */
    session: string
  }
}

/** Convert a base64url public key into hex bytes. */
export function publicKeyToHex(publicKey: string): Hex.Hex {
  return Hex.fromBytes(Base64.toBytes(publicKey))
}

/** Convert raw public-key bytes into unpadded base64url. */
export function publicKeyToString(publicKey: Hex.Hex | Bytes.Bytes): string {
  return Base64.fromBytes(Bytes.from(publicKey), { pad: false, url: true })
}

/** Create a compact random session identifier. */
export function randomSession(): string {
  return Base64.fromBytes(Bytes.random(16), { pad: false, url: true })
}

function signaturePayload(options: {
  publicKey_consumer: string
  publicKey_host: string
  session: string
}): Uint8Array {
  return encoder.encode(
    [signatureDomain, options.session, options.publicKey_consumer, options.publicKey_host].join(
      '\n',
    ),
  )
}
