/**
 * Per-direction nonce discipline for the uRPC AEAD layer.
 *
 * Per [uRPC `core.md` §6](https://github.com/tempoxyz/urpc/blob/main/specs/core.md#encrypted-message-envelope-aead),
 * each direction maintains a 12-byte big-endian counter that is
 * **pre-incremented** before sealing — the very first wire nonce is
 * `0x00…01`, the second `0x00…02`, etc. The receiver enforces strictly-
 * greater than the highest accepted nonce (HWM) and updates the HWM only
 * on successful AEAD open. Anti-replay + anti-reorder fall out of that
 * single rule.
 *
 * Surface:
 *
 * - {@link encoder} produces an outbound counter — call `.next()` once per
 *   sealed frame. Defaults to `start: 1n` so the first emitted nonce is
 *   `0x00…01`.
 * - {@link decoder} verifies inbound nonces against the HWM — call
 *   `.accept(nonce)` before each `Aead.open`. Defaults to `hwm: 0n` so the
 *   first accepted counter must be at least `1n`.
 * - {@link fromCounter} / {@link toCounter} are the underlying conversions
 *   for low-level callers.
 */

import { Bytes, Hex } from 'ox'

import * as Errors from './Errors.js'

/** Length of a uRPC AEAD nonce in bytes (matches ChaCha20-Poly1305). */
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
 * each call. Per spec §6 the counter is pre-incremented, so the very first
 * emitted nonce is `0x00…01` (counter = `1n`). Throws
 * {@link Errors.ProtocolError} when the 96-bit counter space is exhausted.
 *
 * @example
 * ```ts
 * import { Nonce, Aead } from 'handshakes'
 *
 * const out = Nonce.encoder()
 * Aead.seal({ key, nonce: out.next(), plaintext })  // first nonce: 0x00…01
 * Aead.seal({ key, nonce: out.next(), plaintext })  // second:      0x00…02
 * ```
 */
export function encoder(options: encoder.Options = {}): encoder.ReturnType {
  let counter = options.start ?? 1n
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
    /** Starting counter value (default `1n`, per spec §6 pre-increment). Useful for resumption. */
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
 * nonce against the high-water mark (HWM = highest counter already seen)
 * and updates the HWM on success.
 *
 * Per spec §6 the rule is **strictly greater than HWM**: the very first
 * accepted counter must be `> 0n` (i.e. at least `1n`, matching the
 * encoder's pre-incremented start), and any out-of-order or replayed
 * nonce is rejected. The HWM is updated only when {@link "./Aead".open}
 * subsequently succeeds, so call this immediately before AEAD open and
 * roll back on failure if the transport demands it.
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
  let hwm = options.hwm ?? 0n
  return {
    accept(nonce) {
      const counter = toCounter(nonce)
      if (counter <= hwm)
        throw new Errors.ProtocolError('nonce not strictly greater than HWM', {
          details: `hwm=${hwm}, received counter=${counter}`,
        })
      hwm = counter
    },
    get hwm() {
      return hwm
    },
  }
}

export declare namespace decoder {
  /** Options for {@link decoder}. */
  type Options = {
    /** Initial high-water mark (default `0n`). Useful for resumption. */
    hwm?: bigint | undefined
  }

  /** Result of {@link decoder}. */
  type ReturnType = {
    /**
     * Verify that `nonce` is strictly greater than the current HWM.
     * Throws {@link Errors.ProtocolError} on replay or out-of-order
     * delivery and advances the HWM on success.
     */
    accept: (nonce: Hex.Hex | Bytes.Bytes) => void
    /** Current high-water mark (highest counter accepted so far). */
    readonly hwm: bigint
  }
}
