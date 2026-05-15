/**
 * Thin namespace wrapper around the [`rettime`](https://github.com/kettanaito/rettime)
 * library so the rest of the codebase imports event primitives via
 * `import * as Events from '../core/Events.js'` and never reaches into
 * `rettime` directly.
 *
 * Every public/internal event emitter in `wata` is a rettime
 * `Emitter` under the hood, but exposed through a payload-style
 * surface: `.on(eventName, listener)` (listener receives the payload
 * directly) and `.emit(eventName, payload)` (no `TypedEvent`
 * boilerplate at the call site).
 *
 * Event maps are written as `{ eventName: payload }` — `create` lifts
 * them into the rettime-shaped `TypedEvent` map internally.
 */

import { Emitter as RettimeEmitter, TypedEvent as RettimeTypedEvent } from 'rettime'

/**
 * Listener for an {@link Emitter} event. Receives the typed payload
 * directly (the rettime `TypedEvent` is unwrapped at the boundary).
 */
export type Listener<payload> = (payload: payload) => unknown

/** Options accepted by {@link Emitter.on}. */
export type Options = {
  /** Cancel the subscription when the supplied `AbortSignal` aborts. */
  signal?: AbortSignal | undefined
}

/**
 * Payload-style event emitter. Parameterised by an event map of the
 * form `{ eventName: payload }`. Listeners receive the payload
 * directly; `emit` takes the event name and payload (no `TypedEvent`
 * construction at the call site).
 */
export type Emitter<map extends Record<string, unknown>> = {
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
  /** Remove a previously-subscribed listener (matched by reference). */
  off: <type extends keyof map & string>(type: type, listener: Listener<map[type]>) => void
  /**
   * Emit an event with its payload. Returns `true` if any listeners
   * were invoked, `false` otherwise.
   */
  emit: <type extends keyof map & string>(type: type, payload: map[type]) => boolean
  /**
   * Number of listeners subscribed to `type` (or to every event when
   * called with no argument).
   */
  listenerCount: <type extends keyof map & string>(type?: type) => number
}

/**
 * Create a payload-style {@link Emitter} backed by a rettime
 * `Emitter`. Listener errors are caught and swallowed so a buggy
 * subscriber can't disrupt the dispatch path.
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
  const inner = new RettimeEmitter<{
    [K in keyof map & string]: RettimeTypedEvent<map[K]>
  }>()
  const wrappers = new WeakMap<Listener<unknown>, (event: RettimeTypedEvent<unknown>) => unknown>()
  return {
    on(type, listener, options) {
      const wrapped = (event: RettimeTypedEvent<unknown>) => {
        try {
          return (listener as Listener<unknown>)(event.data)
        } catch {
          // Swallow listener errors so a buggy subscriber can't break the
          // dispatch path. Match the legacy `createBus` semantics.
          return undefined
        }
      }
      wrappers.set(listener as Listener<unknown>, wrapped)
      inner.on(type as never, wrapped as never, options as never)
    },
    off(type, listener) {
      const wrapped = wrappers.get(listener as Listener<unknown>)
      if (!wrapped) return
      inner.removeListener(type as never, wrapped as never)
      wrappers.delete(listener as Listener<unknown>)
    },
    emit(type, payload) {
      return inner.emit(new RettimeTypedEvent<unknown>(type, { data: payload }) as never)
    },
    listenerCount(type) {
      return inner.listenerCount(type as never)
    },
  }
}
