/**
 * Internal relay frame helpers shared by the consumer, host, and relay
 * server surfaces.
 */

import { Base64, Bytes, Hex } from 'ox'
import { z } from 'zod/mini'

import * as Envelope from '../Envelope.js'
import * as Errors from '../Errors.js'
import * as Schema from '../Schema.js'

const encoder = new TextEncoder()

/** Relay roles as they appear in HTTP routing headers. */
export const role = {
  /** Consumer side. */
  consumer: 'consumer',
  /** Host side. */
  host: 'host',
} as const

/** Relay role discriminant. */
export type Role = (typeof role)[keyof typeof role]

/** Runtime schemas for relay frames. */
export namespace schema {
  /** Non-empty base64url byte string. */
  export const bytes = z.string().check(z.regex(/^[A-Za-z0-9_-]+={0,2}$/))

  /** Initial consumer-to-host key-share frame. */
  export const hello = z.object({
    pubkey: bytes,
    type: z.literal('hello'),
  })

  /** Host-to-consumer key-share frame. */
  export const ready = z.object({
    pubkey: bytes,
    type: z.literal('ready'),
  })

  /** Encrypted frame carried in either direction after ready. */
  export const message = z.object({
    message: Envelope.schema.encrypted,
    type: z.literal('message'),
  })

  /** Any relay frame. */
  export const frame = z.discriminatedUnion('type', [hello, message, ready])
}

/** Any relay frame. */
export type Frame = z.output<typeof schema.frame>

/** Consumer-to-host relay key-share frame. */
export type HelloFrame = z.output<typeof schema.hello>

/** Relay message frame. */
export type MessageFrame = z.output<typeof schema.message>

/** Host-to-consumer relay key-share frame. */
export type ReadyFrame = z.output<typeof schema.ready>

/** Parse an inbound relay frame. */
export function parse(value: unknown): Frame {
  try {
    return Schema.validate(schema.frame, value)
  } catch (cause) {
    throw new Errors.ProtocolError('invalid relay frame', { cause: cause as Error })
  }
}

/** Convert raw public-key bytes into unpadded base64url. */
export function publicKeyToString(publicKey: Hex.Hex | Bytes.Bytes): string {
  return Base64.fromBytes(Bytes.from(publicKey), { pad: false, url: true })
}

/** Convert a base64url public key into hex bytes. */
export function publicKeyToHex(publicKey: string): Hex.Hex {
  return Hex.fromBytes(Base64.toBytes(publicKey))
}

/** Convert a shared relay pairing secret into HKDF context bytes. */
export function pairingSecretToContext(pairingSecret: string): Uint8Array {
  return encoder.encode(pairingSecret)
}

/** Create a compact random relay session identifier. */
export function randomSession(): string {
  return Base64.fromBytes(Bytes.random(16), { pad: false, url: true })
}

/** Create an HTTP signature nonce. */
export function randomNonce(): string {
  return Base64.fromBytes(Bytes.random(16), { pad: false, url: true })
}

/** Decode an HTTP JSON body into relay frames. */
export function decodeMessages(text: string): readonly Frame[] {
  try {
    const value = JSON.parse(text)
    const messages = z.object({ messages: z.array(schema.frame) }).parse(value).messages
    return messages.map((message) => parse(message))
  } catch (cause) {
    throw new Errors.ProtocolError('invalid relay message response', { cause: cause as Error })
  }
}

/** Encode relay frames as an HTTP JSON response body. */
export function encodeMessages(messages: readonly Frame[]): string {
  return JSON.stringify({ messages })
}

/** Decode a single posted relay frame. */
export function decodeFrame(text: string): Frame {
  try {
    return parse(JSON.parse(text))
  } catch (cause) {
    throw new Errors.ProtocolError('invalid relay message body', { cause: cause as Error })
  }
}

/** Encode a single relay frame. */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

/** Return the opposite relay role. */
export function peerRole(value: Role): Role {
  return value === role.consumer ? role.host : role.consumer
}

/** Stable relay message endpoint below a relay URL. */
export function messageUrl(url: string): string {
  return new URL('./messages', url.endsWith('/') ? url : `${url}/`).toString()
}
