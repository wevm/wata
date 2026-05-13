/**
 * Additional Authenticated Data (AAD) construction for the TempoCP AEAD layer.
 *
 * Every sealed frame binds a deterministic AAD blob to the ciphertext so the
 * recipient can detect cross-session, cross-direction, or cross-version
 * replay attempts even if the attacker has the right key.
 *
 * Layout (30 bytes total):
 *
 * ```diagram
 * ╭───────────┬───────────┬─────────────────╮
 * │ version 1 │ direction │     reserved    │
 * │   1 byte  │   1 byte  │ session id 16 B │
 * ╰───────────┴───────────┴─────────────────╯
 *               (counter, 12 bytes)
 * ```
 *
 * - `version`   — pinned to {@link version} for protocol versioning.
 * - `direction` — `0x00` consumer→host, `0x01` host→consumer.
 * - `sessionId` — 16 random bytes, established at bootstrap.
 * - `counter`   — 12-byte big-endian nonce counter (matches the AEAD nonce).
 */

import { Bytes, Hex } from 'ox'
import { ProtocolError } from './Errors.js'
import * as Nonce from './Nonce.js'

/** Current AAD layout version. Bumped if the bound fields ever change. */
export const version = 0x01

/** Total AAD length in bytes (`1 + 1 + 16 + 12`). */
export const size = 30

/** Length of the session id field in bytes. */
export const sessionIdSize = 16

/** Allowed values for the `direction` byte. */
export const direction = {
  /** Consumer → host. */
  c2h: 0x00,
  /** Host → consumer. */
  h2c: 0x01,
} as const

/** Direction discriminant for {@link encode} and {@link decode}. */
export type Direction = (typeof direction)[keyof typeof direction]

/**
 * Encode a structured AAD record into its 30-byte wire form.
 *
 * @example
 * ```ts
 * import { Aad } from 'handshakes'
 *
 * Aad.encode({
 *   sessionId: '0x00112233445566778899aabbccddeeff',
 *   direction: Aad.direction.c2h,
 *   counter: 0n,
 * })
 * ```
 */
export function encode(options: encode.Options): Hex.Hex {
  const sessionId = Bytes.from(options.sessionId)
  if (sessionId.length !== sessionIdSize)
    throw new ProtocolError('sessionId must be 16 bytes', {
      details: `received ${sessionId.length} bytes`,
    })
  const out = new Uint8Array(size)
  out[0] = version
  out[1] = options.direction
  out.set(sessionId, 2)
  out.set(Bytes.from(Nonce.fromCounter(options.counter)), 2 + sessionIdSize)
  return Hex.fromBytes(out)
}

export declare namespace encode {
  /** Options for {@link encode}. */
  type Options = {
    /** 16-byte session id, established at bootstrap. */
    sessionId: Hex.Hex | Bytes.Bytes
    /** Direction byte; use {@link direction}. */
    direction: Direction
    /** Frame counter (must match the AEAD nonce counter). */
    counter: bigint
  }
}

/**
 * Parse a 30-byte AAD blob back into its structured fields. Throws
 * {@link ProtocolError} on malformed inputs (wrong length, wrong version,
 * invalid direction byte).
 *
 * @example
 * ```ts
 * import { Aad } from 'handshakes'
 *
 * const fields = Aad.decode(aad)
 * ```
 */
export function decode(aad: Hex.Hex | Bytes.Bytes): decode.ReturnType {
  const bytes = Bytes.from(aad)
  if (bytes.length !== size)
    throw new ProtocolError('aad must be exactly 30 bytes', {
      details: `received ${bytes.length} bytes`,
    })
  const versionByte = bytes[0]!
  if (versionByte !== version)
    throw new ProtocolError('aad version mismatch', {
      details: `expected ${version}, received ${versionByte}`,
    })
  const directionByte = bytes[1]!
  if (directionByte !== direction.c2h && directionByte !== direction.h2c)
    throw new ProtocolError('aad direction byte invalid', {
      details: `received 0x${directionByte.toString(16).padStart(2, '0')}`,
    })
  return {
    direction: directionByte,
    sessionId: Hex.fromBytes(bytes.slice(2, 2 + sessionIdSize)),
    counter: Nonce.toCounter(bytes.slice(2 + sessionIdSize)),
  }
}

export declare namespace decode {
  /** Result of {@link decode}. */
  type ReturnType = {
    /** Direction byte (see {@link direction}). */
    direction: Direction
    /** 16-byte session id as `0x`-prefixed hex. */
    sessionId: Hex.Hex
    /** Frame counter parsed from the trailing 12 bytes. */
    counter: bigint
  }
}
