/**
 * Small event primitive used by the rest of the codebase via
 * `import * as Events from '../core/Events.js'`.
 *
 * Every public/internal event emitter in `wata` is exposed through a
 * payload-style surface: `.on(eventName, listener)` (listener receives
 * the payload directly) and `.emit(eventName, payload)`. Event values
 * that are non-empty tuples are spread into listener arguments, so maps
 * can model multi-argument events without bespoke adapters.
 *
 * Event maps are written as `{ eventName: payload }` for normal
 * single-payload events, or `{ eventName: [a, b] }` for multi-argument
 * events.
 */

/**
 * Arguments delivered for an event map payload. Non-empty tuples are
 * treated as the full argument list; every other payload is passed as
 * one argument.
 */
export type EventArgs<payload> = [payload] extends [[unknown, ...unknown[]]] ? payload : [payload]

/**
 * Listener for an {@link Emitter} event. Receives the typed payload
 * directly.
 */
export type Listener<payload> = (...payload: EventArgs<payload>) => unknown

/** Options accepted by {@link Emitter.on}. */
export type Options = {
  /** Cancel the subscription when the supplied `AbortSignal` aborts. */
  signal?: AbortSignal | undefined
}

/**
 * Payload-style event emitter. Parameterised by an event map of the
 * form `{ eventName: payload }`. Listeners receive the payload
 * directly; `emit` takes the event name and payload (no `TypedEvent`
 * construction at the call site). Non-empty tuple values are treated
 * as multi-argument events.
 */
export type Emitter<map extends Record<string, unknown>> = {
  /**
   * Emit an event with its payload. Returns `true` if any listeners
   * were invoked, `false` otherwise.
   */
  emit: <type extends keyof map & string>(type: type, ...payload: EventArgs<map[type]>) => boolean
  /**
   * Number of listeners subscribed to `type` (or to every event when
   * called with no argument).
   */
  listenerCount: <type extends keyof map & string>(type?: type) => number
  /** Remove a previously-subscribed listener (matched by reference). */
  off: <type extends keyof map & string>(type: type, listener: Listener<map[type]>) => void
  /**
   * Subscribe to an event. The listener receives the typed payload
   * directly. Pass `{ signal }` to scope the subscription to an
   * `AbortController`.
   */
  on: <type extends keyof map & string>(
    type: type,
    listener: Listener<map[type]>,
    options?: Options,
  ) => void
}

/**
 * Create a payload-style {@link Emitter}. Listener errors are caught
 * and swallowed so a buggy subscriber can't disrupt the dispatch path.
 *
 * @example
 * ```ts
 * import * as Events from '../core/Events.js'
 *
 * const emitter = Events.create<{
 *   open: void
 *   message: { id: string }
 *   error: Error
 * }>()
 *
 * emitter.on('message', (payload) => console.log(payload.id))
 * emitter.emit('message', { id: '1' })
 * ```
 */
export function create<map extends Record<string, unknown>>(): Emitter<map> {
  type AnyListener = (...payload: unknown[]) => unknown
  const listeners = new Map<string, Set<AnyListener>>()
  const cleanups = new Map<string, WeakMap<object, () => void>>()

  function cleanupMap(type: string): WeakMap<object, () => void> {
    const existing = cleanups.get(type)
    if (existing) return existing
    const next = new WeakMap<object, () => void>()
    cleanups.set(type, next)
    return next
  }

  function remove(type: string, listener: AnyListener): void {
    const set = listeners.get(type)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) listeners.delete(type)
    const map = cleanupMap(type)
    const cleanup = map.get(listener)
    if (!cleanup) return
    cleanup()
    map.delete(listener)
  }

  return {
    emit(type, ...payload) {
      const set = listeners.get(type)
      if (!set?.size) return false
      for (const listener of Array.from(set))
        try {
          listener(...payload)
        } catch {
          // Swallow listener errors so a buggy subscriber can't break the
          // dispatch path. Match the legacy `createBus` semantics.
        }
      return true
    },
    listenerCount(type) {
      if (type) return listeners.get(type)?.size ?? 0
      let count = 0
      for (const set of listeners.values()) count += set.size
      return count
    },
    off(type, listener) {
      remove(type, listener as AnyListener)
    },
    on(type, listener, options) {
      if (options?.signal?.aborted) return
      const set = listeners.get(type) ?? new Set<AnyListener>()
      listeners.set(type, set)
      set.add(listener as AnyListener)
      if (!options?.signal) return
      const abort = () => {
        remove(type, listener as AnyListener)
      }
      options.signal.addEventListener('abort', abort, { once: true })
      cleanupMap(type).set(listener, () => options.signal?.removeEventListener('abort', abort))
    },
  }
}
