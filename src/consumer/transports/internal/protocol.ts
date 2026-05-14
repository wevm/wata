/**
 * Internal wire protocol used by the consumer + host `window` transports
 * to negotiate readiness before exchanging real envelope frames.
 *
 * Two control frames live alongside the normalized {@link "../../../core/Envelope".Envelope}
 * frames on the wire:
 *
 * - `tempocp.hello` — sent by the consumer after it acquires its handle.
 * - `tempocp.ready` — sent by the host once it observes the consumer's
 *                     hello (or as soon as its own handle is acquired in
 *                     opener-supplied flows).
 *
 * Until each side has seen the peer's frame, outbound envelopes are
 * buffered locally; the buffer is drained the moment readiness is
 * established.
 */

/** Outbound consumer-hello control frame. */
export const consumerHello = { type: 'tempocp.hello' as const }

/** Outbound host-ready control frame. */
export const hostReady = { type: 'tempocp.ready' as const }

/** Discriminated union of every control frame the wire understands. */
export type WireFrame = typeof consumerHello | typeof hostReady

/** Type-guard for a control frame on inbound `MessageEvent.data`. */
export function isControlFrame(value: unknown): value is WireFrame {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === consumerHello.type || type === hostReady.type
}

/** Best-effort `Window` / `WindowProxy` shape detection. */
export function isWindowLike(value: unknown): value is Window {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { postMessage?: unknown; addEventListener?: unknown }
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
    postMessage?: unknown
    start?: unknown
    addEventListener?: unknown
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
