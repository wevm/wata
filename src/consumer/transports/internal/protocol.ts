/**
 * Internal wire protocol used by the consumer + host `window` transports
 * to negotiate readiness before exchanging real envelope frames.
 *
 * Two control frames live alongside the normalized {@link "../../../core/Envelope".Envelope}
 * frames on the wire:
 *
 * - `urpc.hello` — sent by the consumer after it acquires its handle.
 * - `urpc.ready` — sent by the host once it observes the consumer's
 *                  hello (or as soon as its own handle is acquired in
 *                  opener-supplied flows).
 *
 * Until each side has seen the peer's frame, outbound envelopes are
 * buffered locally; the buffer is drained the moment readiness is
 * established.
 *
 * Per the uRPC window-transport spec, every wire frame (control or
 * envelope) carries a sender-generated v4 UUID `id` field at the top
 * level: `{ type, payload?, id }`. Outbound frames are decorated via
 * {@link withId}; inbound frames are validated via {@link readFrame},
 * which strips the `id` before downstream processing.
 */

/** Outbound consumer-hello control frame. */
export const consumerHello = { type: 'urpc.hello' as const }

/** Outbound host-ready control frame. */
export const hostReady = { type: 'urpc.ready' as const }

/** Discriminated union of every control frame the wire understands. */
export type WireFrame = typeof consumerHello | typeof hostReady

/** Type-guard for a control frame on inbound `MessageEvent.data`. */
export function isControlFrame(value: unknown): value is WireFrame {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === consumerHello.type || type === hostReady.type
}

/**
 * RFC 4122 v4 UUID — 8-4-4-4-12 hex with the version + variant bits set.
 * Validation pattern matches the uRPC window-transport spec requirement.
 */
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** True when `value` matches the RFC 4122 v4 UUID shape. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && uuidV4Pattern.test(value)
}

/**
 * Decorate a wire frame with a freshly-generated v4 UUID `id`.
 * Used by both sides for every outbound frame (control or envelope).
 *
 * Falls back to a manually-assembled v4 UUID when `crypto.randomUUID`
 * is unavailable (older browser realms / non-secure contexts).
 */
export function withId<frame extends object>(frame: frame): frame & { id: string } {
  return { ...frame, id: randomUuidV4() }
}

/**
 * Validate an inbound frame carries a v4 UUID `id` at the top level and
 * return the frame stripped of the `id` field for downstream processing.
 * Returns `undefined` when the frame is not an object or the `id` is
 * missing / malformed; callers MUST treat that case as a protocol
 * violation.
 */
export function readFrame(value: unknown): { frame: object; id: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { id, ...frame } = value as { id?: unknown } & Record<string, unknown>
  if (!isUuidV4(id)) return undefined
  return { frame, id }
}

function randomUuidV4(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID()
  // Fallback for realms without `crypto.randomUUID`. Uses
  // `crypto.getRandomValues` when available, otherwise `Math.random`.
  const bytes = new Uint8Array(16)
  const getRandomValues = (
    globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }
  ).crypto?.getRandomValues
  if (getRandomValues) getRandomValues.call((globalThis as { crypto: object }).crypto, bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Best-effort `Window` / `WindowProxy` shape detection. */
export function isWindowLike(value: unknown): value is Window {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { addEventListener?: unknown; postMessage?: unknown }
  if (typeof candidate.postMessage !== 'function') return false
  try {
    return typeof candidate.addEventListener === 'function'
  } catch {
    // Cross-origin `WindowProxy` blocks reads of most properties but
    // always exposes `postMessage`. If we got past the `postMessage`
    // check and reading `addEventListener` throws, this is a
    // cross-origin window — treat it as Window-like.
    return true
  }
}

/** Best-effort `MessagePort` shape detection. */
export function isPortLike(value: unknown): value is MessagePort {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as {
    addEventListener?: unknown
    postMessage?: unknown
    start?: unknown
  }
  if (typeof candidate.postMessage !== 'function') return false
  try {
    return (
      typeof candidate.start === 'function' &&
      typeof candidate.addEventListener === 'function'
    )
  } catch {
    // Cross-origin `WindowProxy` throws when reading non-whitelisted
    // properties — definitely not a `MessagePort`.
    return false
  }
}
