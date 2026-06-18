/**
 * `useSession`, a React hook that owns a `wata` session's lifecycle —
 * starting it, subscribing to its event surface, mirroring `prompt`/`error`
 * into React state, and closing it on unmount — so components never
 * hand-roll refs, subscriptions, or cleanup. Works for both consumer
 * sessions (`onPrompt` / `onNotification`) and host sessions (`onRequest`).
 *
 * `react` is an optional peer dependency: only import `wata/react` from a
 * React app that already depends on `react`.
 *
 * @example
 * ```tsx
 * import { Wata, relay } from 'wata'
 * import { useSession } from 'wata/react'
 *
 * const wata = Wata.create({ transports: [relay({ url: 'https://relay.example' })] })
 *
 * function App() {
 *   const { prompt, start, status } = useSession(wata, {
 *     onNotification: (event) => console.log(event),
 *   })
 *
 *   async function send() {
 *     const session = await start()
 *     const { result } = await session.send({ method: 'ping', params: [] })
 *     console.log(result)
 *   }
 *
 *   return (
 *     <button disabled={status === 'pending'} onClick={() => void send()} type="button">
 *       {prompt ? 'pairing…' : 'send'}
 *     </button>
 *   )
 * }
 * ```
 */

import * as React from 'react'

/** Lifecycle status of the session managed by {@link useSession}. */
export type Status = 'closed' | 'error' | 'idle' | 'open' | 'pending'

/**
 * Manage a `wata` session's lifecycle from a React component. Pass the
 * `Wata` config (or a single transport handle) returned by `Wata.create`
 * — consumer or host;
 * the hook lazily {@link useSession.Result.start | starts} the session,
 * keeps `status` / `prompt` / `error` / `session` in React state, forwards
 * events to the optional callbacks, and closes the session on unmount.
 *
 * Starting is lazy by default — call the returned `start()` (e.g. from a
 * button handler) to open the session. Pass `start: true` (or `start:
 * { …startOptions }`) to start on mount instead. `start()` is idempotent
 * while the session is open and reopens a fresh session after a close.
 */
export function useSession<const handle extends useSession.Handle>(
  handle: handle,
  options?: useSession.Options<handle>,
): useSession.Result<handle>
export function useSession(
  handle: useSession.Handle,
  options: useSession.Options<useSession.Handle> = {},
): useSession.Result<useSession.Handle> {
  type Entry = {
    controllers: AbortController[]
    promise: Promise<useSession.AnySession>
  }

  const [state, dispatch] = React.useReducer(reducer, initialState)

  // Keep the latest callbacks in a ref so subscriptions never depend on
  // their identity (which changes every render).
  const callbacks = React.useRef(options)
  callbacks.current = options

  const entry = React.useRef<Entry | undefined>(undefined)

  const start = React.useCallback(
    (...args: never[]) => {
      if (entry.current) return entry.current.promise
      const current: Entry = { controllers: [], promise: undefined as never }
      entry.current = current
      dispatch({ type: 'start' })
      current.promise = (async () => {
        try {
          const next = (await handle.start(...args)) as useSession.AnySession
          // Subscribe only to the events this session actually exposes —
          // consumer sessions emit `prompt` / `notification`, host sessions
          // emit `request`; both share `error` / `close`.
          current.controllers = [
            next.onPrompt?.((value) => {
              dispatch({ prompt: value, type: 'prompt' })
              callbacks.current.onPrompt?.(value as never)
            }),
            next.onNotification?.((event) => callbacks.current.onNotification?.(event as never)),
            next.onRequest?.((event) => callbacks.current.onRequest?.(event as never)),
            next.onError?.((cause) => {
              dispatch({ error: cause, type: 'error' })
              callbacks.current.onError?.(cause as never)
            }),
            next.onClose?.((cause) => {
              for (const controller of current.controllers) controller.abort()
              entry.current = undefined
              dispatch({ type: 'close' })
              callbacks.current.onClose?.(cause as never)
            }),
          ].filter((controller) => controller !== undefined)
          dispatch({ session: next, type: 'open' })
          return next
        } catch (cause) {
          entry.current = undefined
          dispatch({ error: cause as Error, type: 'session-error' })
          throw cause
        }
      })()
      return current.promise
    },
    [handle],
  )

  const close = React.useCallback(async () => {
    const current = entry.current
    if (!current) return
    const next = await current.promise.catch(() => undefined)
    await next?.close()
  }, [])

  React.useEffect(() => {
    const option = callbacks.current.start
    if (option) void start(...((option === true ? [] : [option]) as never[]))
    return () => void close()
  }, [start, close])

  const { error, prompt, session, status } = state
  return { close, error, prompt, session, start, status } as useSession.Result<useSession.Handle>
}

/** Reducer state backing {@link useSession}. */
type State = {
  error: Error | undefined
  prompt: unknown
  session: useSession.AnySession | undefined
  status: Status
}

/** Reducer actions dispatched across the session lifecycle. */
type Action =
  | { type: 'close' }
  | { error: Error; type: 'error' }
  | { session: useSession.AnySession; type: 'open' }
  | { prompt: unknown; type: 'prompt' }
  | { error: Error; type: 'session-error' }
  | { type: 'start' }

const initialState: State = {
  error: undefined,
  prompt: undefined,
  session: undefined,
  status: 'idle',
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'close':
      return { ...state, prompt: undefined, session: undefined, status: 'closed' }
    case 'error':
      return { ...state, error: action.error }
    case 'open':
      return { ...state, session: action.session, status: 'open' }
    case 'prompt':
      return { ...state, prompt: action.prompt }
    case 'session-error':
      return { ...state, error: action.error, status: 'error' }
    case 'start':
      return { ...state, error: undefined, status: 'pending' }
  }
}

export declare namespace useSession {
  /** Minimal shape the hook needs: anything with a `start()` factory. */
  type Handle = {
    /**
     * Open the session. Consumer handles return the session synchronously;
     * host handles resolve with it. `SessionOf` unwraps either via `Awaited`.
     */
    start: (...args: never[]) => unknown
  }

  /**
   * Structural session surface the hook subscribes to internally. Every
   * `onX` is optional: consumer sessions expose `onPrompt` / `onNotification`,
   * host sessions expose `onRequest`, and both share `onError` / `onClose`.
   */
  type AnySession = {
    close: (cause?: Error) => Promise<void>
    onClose?: (listener: (cause: Error | undefined) => void) => AbortController
    onError?: (listener: (error: Error) => void) => AbortController
    onNotification?: (listener: (event: never) => void) => AbortController
    onPrompt?: (listener: (prompt: never) => void) => AbortController
    onRequest?: (listener: (event: never) => void) => AbortController
    prompt?: unknown
  }

  /** The live session type produced by a {@link Handle}. */
  type SessionOf<handle extends Handle> = Awaited<ReturnType<handle['start']>>

  /**
   * Payload type of an `onX(listener)` subscriber method on a session.
   * Uses `Parameters` so overloaded subscribers (the host's `onRequest`)
   * resolve to their broad-listener signature.
   */
  type ListenerArg<fn extends (...args: never) => unknown> =
    Parameters<fn> extends [infer listener]
      ? listener extends (payload: infer payload) => unknown
        ? payload
        : never
      : never

  /** Inbound notification payload of a session. */
  type NotificationOf<session> = session extends {
    onNotification: infer fn extends (...args: never) => unknown
  }
    ? ListenerArg<fn>
    : never

  /** Inbound request-event payload of a (host) session. */
  type RequestOf<session> = session extends {
    onRequest: infer fn extends (...args: never) => unknown
  }
    ? ListenerArg<fn>
    : never

  /** Pairing/verification prompt type of a session (`undefined` if none). */
  type PromptOf<session> = session extends { prompt: infer prompt } ? prompt : undefined

  /** Start options accepted by a {@link Handle}'s `start()`. */
  type StartArg<handle extends Handle> = Parameters<handle['start']>[0]

  /** Options accepted by {@link useSession}. */
  type Options<handle extends Handle> = {
    /** Called when the session closes, with the cause if any. */
    onClose?: ((cause: Error | undefined) => void) | undefined
    /** Called when the session emits an error. */
    onError?: ((error: Error) => void) | undefined
    /** Called for each inbound JSON-RPC notification from the host. */
    onNotification?: ((event: NotificationOf<SessionOf<handle>>) => void) | undefined
    /** Called when the transport produces a pairing/verification prompt. */
    onPrompt?: ((prompt: NonNullable<PromptOf<SessionOf<handle>>>) => void) | undefined
    /** Called for each inbound request (host sessions only). */
    onRequest?: ((event: RequestOf<SessionOf<handle>>) => void) | undefined
    /**
     * Start the session on mount instead of lazily. `true` starts with no
     * options; pass the transport's start options object to start with them.
     * Omitted (or `false`) keeps starting lazy — call the returned `start()`.
     */
    start?: boolean | StartArg<handle> | undefined
  }

  /** Value returned by {@link useSession}. */
  type Result<handle extends Handle> = {
    /** Close the active session, if any. Idempotent. */
    close: () => Promise<void>
    /** The latest session error, reset on each `start()`. */
    error: Error | undefined
    /** The session's current pairing/verification prompt, if any. */
    prompt: PromptOf<SessionOf<handle>>
    /** The live session once open, otherwise `undefined`. */
    session: SessionOf<handle> | undefined
    /**
     * Open the session (forwarding any start options the transport
     * accepts) and resolve with it. Idempotent while open.
     */
    start: (...args: Parameters<handle['start']>) => Promise<SessionOf<handle>>
    /** Lifecycle status of the session. */
    status: Status
  }
}
