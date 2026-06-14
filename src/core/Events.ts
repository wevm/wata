/**
 * Self-contained, payload-style event emitter used everywhere in
 * `wata`. The rest of the codebase imports event primitives via
 * `import * as Events from '../core/Events.js'`; this module owns the
 * single implementation so no other file ever touches an event
 * library directly.
 *
 * The surface is payload-style: `.on(eventName, listener)` (listener
 * receives the payload directly) and `.emit(eventName, payload)` (no
 * event-object boilerplate at the call site). Event values that are
 * non-empty tuples are spread into listener arguments, so maps can
 * model multi-argument events without bespoke adapters.
 *
 * Event maps are written as `{ eventName: payload }` for normal
 * single-payload events, or `{ eventName: [a, b] }` for multi-argument
 * events.
 *
 * The emitter is intentionally a plain `Map<string, Set<listener>>`
 * with no dependency on DOM event classes (`Event`, `MessageEvent`,
 * …). React Native (Hermes) ships without those globals, so any
 * emitter that subclassed them would crash at module-load before the
 * app could render.
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
 * directly; `emit` takes the event name and payload (no event-object
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
 * PascalCase an event name, splitting on `-` so kebab-cased events map
 * to camelCased method suffixes (e.g. `rpc-requests` → `RpcRequests`).
 * Drives the `on`/`off` method names derived from an event map.
 */
export type PascalEvent<type extends string> = type extends `${infer head}-${infer tail}`
  ? `${Capitalize<head>}${PascalEvent<tail>}`
  : Capitalize<type>

/**
 * `onX` subscriber methods derived from an event map. Each method takes
 * a typed {@link Listener} and returns an `AbortController` so the
 * subscription can be cancelled (or composed with an external signal).
 */
export type On<map extends Record<string, unknown>> = {
  [type in keyof map & string as `on${PascalEvent<type>}`]: (
    listener: Listener<map[type]>,
  ) => AbortController
}

/** `offX` unsubscribe methods derived from an event map. */
export type Off<map extends Record<string, unknown>> = {
  [type in keyof map & string as `off${PascalEvent<type>}`]: (listener: Listener<map[type]>) => void
}

/** Combined `onX` + `offX` subscriber surface derived from an event map. */
export type Subscribers<map extends Record<string, unknown>> = Off<map> & On<map>

/**
 * Build the `onX` / `offX` subscriber methods for a set of event names
 * on an {@link Emitter}. `onX` wraps each subscription in its own
 * `AbortController` (returned to the caller) and invokes
 * {@link subscribers.Options.onSubscribe} after subscribing — used by
 * lazy-connecting sides to bring the transport up on first listener.
 *
 * @example
 * ```ts
 * import * as Events from '../core/Events.js'
 *
 * const emitter = Events.create<{ close: void; error: Error }>()
 * const surface = Events.subscribers(emitter, ['close', 'error'])
 * surface.onError((error) => console.log(error))
 * ```
 */
export function subscribers<
  map extends Record<string, unknown>,
  const names extends readonly (keyof map & string)[],
>(
  emitter: Emitter<map>,
  names: names,
  options: subscribers.Options = {},
): Subscribers<Pick<map, names[number]>> {
  const { onSubscribe } = options
  const out: Record<string, unknown> = {}
  for (const name of names) {
    const suffix = name
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
    out[`on${suffix}`] = (listener: Listener<map[typeof name]>) => {
      const controller = new AbortController()
      emitter.on(name, listener, { signal: controller.signal })
      onSubscribe?.()
      return controller
    }
    out[`off${suffix}`] = (listener: Listener<map[typeof name]>) => emitter.off(name, listener)
  }
  return out as Subscribers<Pick<map, names[number]>>
}

export declare namespace subscribers {
  /** Options for {@link subscribers}. */
  type Options = {
    /** Invoked after each successful subscription (e.g. to lazy-connect). */
    onSubscribe?: (() => void) | undefined
  }
}

/**
 * Create a payload-style {@link Emitter}. Listener errors are caught
 * and swallowed so a buggy subscriber can't disrupt the dispatch
 * path.
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
  type AnyListener = (...payload: readonly unknown[]) => unknown
  const listeners = new Map<string, Set<AnyListener>>()
  return {
    emit(type, ...payload) {
      const set = listeners.get(type)
      if (!set || set.size === 0) return false
      for (const listener of [...set])
        try {
          listener(...payload)
        } catch {
          // Swallow listener errors so a buggy subscriber can't break
          // the dispatch path.
        }
      return true
    },
    listenerCount(type) {
      if (type === undefined) {
        let total = 0
        for (const set of listeners.values()) total += set.size
        return total
      }
      return listeners.get(type)?.size ?? 0
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener as AnyListener)
    },
    on(type, listener, options) {
      const signal = options?.signal
      if (signal?.aborted) return
      const set = listeners.get(type) ?? new Set<AnyListener>()
      listeners.set(type, set)
      set.add(listener as AnyListener)
      signal?.addEventListener('abort', () => set.delete(listener as AnyListener), { once: true })
    },
  }
}
