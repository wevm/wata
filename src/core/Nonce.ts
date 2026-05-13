/**
 * Per-direction nonce discipline for the TempoCP AEAD layer.
 *
 * TempoCP derives one ChaCha20-Poly1305 key per direction (consumer→host and
 * host→consumer) via HKDF, so each side only needs a fresh, monotonically
 * increasing nonce. We pin the format to a 12-byte big-endian counter
 * starting at 0, exactly matching ChaCha20-Poly1305's nonce size (RFC 8439
 * §2.8).
 *
 * - {@link encoder} produces an outbound counter — call `.next()` once per
 *   sealed frame.
 * - {@link decoder} verifies inbound nonces against the highest one already
 *   seen — call `.accept(nonce)` before each `Aead.open`.
 * - {@link fromCounter} / {@link toCounter} are the underlying conversions
 *   for low-level callers.
 */

import { Bytes, Hex } from 'ox'

import * as Errors from './Errors.js'

/** Length of a TempoCP AEAD nonce in bytes (matches ChaCha20-Poly1305). */
export const size = 12

/** Maximum 96-bit counter value before {@link encoder} refuses to emit further nonces. */
export const max = 2n ** 96n - 1n

/**
 * Encode a 96-bit counter into a 12-byte big-endian nonce.
 *
 * @example
 * ```ts
 * import { Nonce } from 'handshakes'
 *
 * Nonce.fromCounter(1n)
 * // '0x000000000000000000000001'
 * ```
 */
export function fromCounter(counter: bigint): Hex.Hex {
  if (counter < 0n) throw new Errors.ProtocolError('counter must be non-negative')
  if (counter > max) throw new Errors.ProtocolError('counter exceeds 96-bit nonce space')
  return Hex.fromNumber(counter, { size })
}

/**
 * Decode a 12-byte big-endian nonce back into its counter value.
 *
 * @example
 * ```ts
 * import { Nonce } from 'handshakes'
 *
 * Nonce.toCounter('0x000000000000000000000001')
 * // 1n
 * ```
 */
export function toCounter(nonce: Hex.Hex | Bytes.Bytes): bigint {
  const bytes = Bytes.from(nonce)
  if (bytes.length !== size)
    throw new Errors.ProtocolError('nonce must be exactly 12 bytes', {
      details: `received ${bytes.length} bytes`,
    })
  return Hex.toBigInt(Hex.fromBytes(bytes))
}

/**
 * Create an outbound nonce encoder. `.next()` returns a fresh 12-byte nonce
 * each call, starting from 0 (or `start`) and incrementing by 1. Throws
 * {@link Errors.ProtocolError} when the 96-bit counter space is exhausted.
 *
 * @example
 * ```ts
 * import { Nonce, Aead } from 'handshakes'
 *
 * const out = Nonce.encoder()
 * Aead.seal({ key, nonce: out.next(), plaintext })
 * Aead.seal({ key, nonce: out.next(), plaintext })
 * ```
 */
export function encoder(options: encoder.Options = {}): encoder.ReturnType {
  let counter = options.start ?? 0n
  return {
    next() {
      const nonce = fromCounter(counter)
      counter += 1n
      return nonce
    },
    get counter() {
      return counter
    },
  }
}

export declare namespace encoder {
  /** Options for {@link encoder}. */
  type Options = {
    /** Starting counter value (default `0n`). Useful for resumption. */
    start?: bigint | undefined
  }

  /** Result of {@link encoder}. */
  type ReturnType = {
    /** Emit the next monotonic nonce and advance the counter. */
    next: () => Hex.Hex
    /** Current (next-to-emit) counter value. */
    readonly counter: bigint
  }
}

/**
 * Create an inbound nonce decoder. `.accept(nonce)` validates an incoming
 * nonce against the highest one already seen and updates state on success.
 *
 * Default discipline is **strict monotonic** — every accepted nonce must be
 * exactly the next expected counter. This matches every transport TempoCP
 * targets in v1 (HTTPS, SSE, `MessageChannel`, deep links), all of which
 * deliver in order. Future transports that may reorder can swap this for a
 * sliding-window decoder later.
 *
 * @example
 * ```ts
 * import { Nonce, Aead } from 'handshakes'
 *
 * const inbound = Nonce.decoder()
 * inbound.accept(nonce)
 * Aead.open({ key, nonce, ciphertext })
 * ```
 */
export function decoder(options: decoder.Options = {}): decoder.ReturnType {
  let next = options.start ?? 0n
  return {
    accept(nonce) {
      const counter = toCounter(nonce)
      if (counter !== next)
        throw new Errors.ProtocolError('nonce out of order', {
          details: `expected counter=${next}, received counter=${counter}`,
        })
      next += 1n
    },
    get next() {
      return next
    },
  }
}

export declare namespace decoder {
  /** Options for {@link decoder}. */
  type Options = {
    /** Starting expected counter value (default `0n`). Useful for resumption. */
    start?: bigint | undefined
  }

  /** Result of {@link decoder}. */
  type ReturnType = {
    /**
     * Verify that `nonce` matches the next expected counter. Throws
     * {@link Errors.ProtocolError} on replay or out-of-order delivery and advances
     * the counter on success.
     */
    accept: (nonce: Hex.Hex | Bytes.Bytes) => void
    /** Next expected counter value. */
    readonly next: bigint
  }
}
