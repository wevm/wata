/**
 * Consumer-side `postMessage` transport — speaks `postMessage` over a
 * `Window`, `WindowProxy`, or `MessagePort` handle supplied by the caller.
 *
 * The transport never opens popups or iframes itself. Instead the caller
 * passes a `target` callback that returns a handle on demand. The library
 * owns the **wire** (origin pinning, readiness handshake, listener cleanup,
 * closed detection); the caller owns the **mount** (popup vs iframe vs
 * channel vs opener-supplied window).
 *
 * For `Window` / `WindowProxy` targets, the caller passes the `host`
 * (URL or origin) the consumer is connecting to. The transport derives
 * `postMessage`'s `targetOrigin` from it and forwards the `host` value
 * back to the `target` callback so the same string drives both.
 *
 * @example popup
 * ```ts
 * import { Wata, postMessage } from 'wata'
 *
 * const session = await Wata.create({
 *   transports: [
 *     postMessage({
 *       host: 'https://wallet.example',
 *       target: ({ host }) => window.open(host, '_blank', 'popup=1'),
 *     }),
 *   ],
 * }).start()
 *
 * // `target` runs on the first `send`, so the popup opens inside the user
 * // gesture — call `send` from a click handler to avoid popup blockers.
 * const { result } = await session.send({ method: 'wallet_connect', params: [] })
 * ```
 *
 * @example iframe
 * ```ts
 * const wata = Wata.create({
 *   transports: [
 *     postMessage({
 *       host: 'https://wallet.example/auth',
 *       // The iframe needs no user gesture, so connect during `start()` —
 *       // the handshake completes up front and proactive host notifications
 *       // arrive without first sending a request.
 *       connect: 'eager',
 *       target: ({ host }) => {
 *         const iframe = document.createElement('iframe')
 *         iframe.src = host
 *         iframe.hidden = true
 *         document.body.appendChild(iframe)
 *         return iframe.contentWindow!
 *       },
 *       close: (handle) => (handle as Window).frameElement?.remove(),
 *     }),
 *   ],
 * })
 * ```
 *
 * @example MessageChannel
 * ```ts
 * const host = 'https://wallet.example'
 * const wata = Wata.create({
 *   transports: [
 *     postMessage({
 *       target: () => {
 *         const popup = window.open(host, '_blank', 'popup=1')!
 *         const { port1, port2 } = new MessageChannel()
 *         popup.postMessage({ type: 'wata.port' }, host, [port2])
 *         return port1
 *       },
 *     }),
 *   ],
 * })
 * ```
 */

import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Transport from '../../core/Transport.js'
import * as protocol from './internal/protocol.js'

/** Targets the consumer transport accepts. */
export type Target = Window | MessagePort

/** Metadata emitted by Window-backed postMessage transports. */
export type OriginMessageMeta = {
  /** Browser `MessageEvent.origin`. */
  origin: string
}

/** Metadata emitted for postMessage transports based on their target kind. */
export type MessageMeta<target extends Target = Target> = target extends MessagePort
  ? Transport.NoMessageMeta
  : OriginMessageMeta

/**
 * Options accepted by {@link postMessage}.
 *
 * `host` is the URL or origin the consumer is connecting to. The
 * transport derives `postMessage`'s `targetOrigin` from it and forwards
 * the value to `target` so the same string drives both the popup /
 * iframe URL and the origin pin. Required for `Window` / `WindowProxy`
 * targets at runtime; `MessagePort` targets ignore it (channels don't
 * carry origin information).
 */
export type Options<target extends Target> = {
  /**
   * Optional cleanup. Called from `close()` after the transport
   * unsubscribes its `message` listener. Defaults to `handle.close?.()`.
   */
  close?: ((handle: target) => void | Promise<void>) | undefined
  /**
   * When to establish the connection (acquire the target, attach the
   * inbound listener, send hello).
   *
   * - `'lazy'` (default) defers all of that to the first outbound frame
   *   (`send` / `notify`), so the `target` callback runs inside the user
   *   gesture that triggers the request — required for popups, which the
   *   browser only opens (and Safari only sizes) from a gesture.
   * - `'eager'` connects during `start()`. Use it when the target needs no
   *   gesture (an iframe, an already-open window, a `MessagePort`) so the
   *   handshake completes up front and proactive host notifications (e.g.
   *   `accountsChanged`) arrive without first sending a request.
   */
  connect?: 'eager' | 'lazy' | undefined
  /**
   * URL or origin of the host the consumer is connecting to. Drives
   * `postMessage`'s `targetOrigin` (inbound events whose `origin`
   * doesn't match are rejected) and is forwarded to `target` so the
   * same string opens the popup / iframe. Required for `Window` /
   * `WindowProxy` targets; optional and unused for `MessagePort`.
   */
  host?: string | undefined
  /**
   * `Window` / `WindowProxy` realm where inbound `message` events are
   * received. Defaults to the global `window`.
   */
  source?: WindowLike | undefined
  /**
   * Acquires the postMessage target. Called lazily on the consumer's first
   * outbound frame (`send` / `notify`) rather than at `start()`, so the popup
   * opens inside the user gesture that triggers the request — `start()` can
   * safely run at module scope. Receives the caller's `host` value (or
   * `undefined` for `MessagePort` targets that omitted it).
   *
   * Optional: when the mount isn't known at construction time, defer it
   * to `start({ target })`. The first `send` throws
   * {@link TargetRequiredError} when neither construction nor start supplies
   * a `target`.
   */
  target?: ((parameters: { host: string | undefined }) => target | Promise<target>) | undefined
}

/**
 * Options for the consumer `postMessage` transport's
 * {@link Transport.Transport.start | start}, derived from the deferrable
 * subset of {@link Options} (`close`, `host`, `target`) so their docs
 * live in one place. Each is an optional per-session override of the
 * construction value.
 */
export type StartOptions<target extends Target = Target> = Pick<
  Options<target>,
  'close' | 'connect' | 'host' | 'target'
>

/** Minimal `Window`-shaped contract used internally. */
export type WindowLike = {
  addEventListener: Window['addEventListener']
  closed?: boolean
  postMessage: (data: unknown, targetOrigin: string) => void
  removeEventListener: Window['removeEventListener']
}

/**
 * Create a consumer-side `postMessage` transport.
 *
 * @example
 * ```ts
 * import { postMessage } from 'wata'
 *
 * const transport = postMessage({
 *   host: 'https://wallet.example',
 *   target: ({ host }) => window.open(host, '_blank', 'popup=1'),
 * })
 * ```
 */
export function postMessage<const target extends Target = Target>(
  options: Options<target> = {},
): Transport.Transport<
  'consumer',
  'postMessage',
  { meta: MessageMeta<target>; startOptions: StartOptions<target> }
> {
  const { close, connect, host, source, target: acquire } = options
  return createSide({
    handshake: { expect: protocol.hostReady.type, send: protocol.consumerHello },
    resolve: (start?: StartOptions<target>) => {
      const host_resolved = start?.host ?? host
      const acquire_resolved = start?.target ?? acquire
      if (!acquire_resolved)
        throw new TargetRequiredError(
          '`target` must be supplied to `postMessage({ target })` or `start({ target })`',
        )
      return {
        close: start?.close ?? close,
        connect: start?.connect ?? connect,
        target: () => acquire_resolved({ host: host_resolved }),
        targetOrigin: host_resolved ? originFrom(host_resolved) : undefined,
      }
    },
    role: 'consumer',
    source,
  })
}

/**
 * Derive the `postMessage` `targetOrigin` value (an origin string) from
 * a caller-supplied `host` (either a full URL or an origin). Throws an
 * {@link InvalidHostError} if the value can't be parsed as a URL.
 *
 * @internal
 */
function originFrom(host: string): string {
  try {
    return new URL(host).origin
  } catch {
    throw new InvalidHostError(`\`host\` must be a valid URL or origin (received \`${host}\`)`)
  }
}

/**
 * Internal helper — both consumer and host sides share the wire mechanics
 * (readiness handshake, origin pinning, listener cleanup, closed detection),
 * so the actual transport object is built here. The host re-exports the
 * same routine via `wata/host`.
 */
export function createSide<
  role extends 'consumer' | 'host',
  target extends Target,
  startOptions = never,
>(
  parameters: createSide.Options<role, target, startOptions>,
): Transport.Transport<
  role,
  'postMessage',
  { meta: MessageMeta<target>; startOptions: startOptions }
> {
  const { discovery, handshake, resolve, role, source: source_option } = parameters
  const source = source_option ?? (globalThis as { window?: WindowLike }).window

  // Resolved per-start: the effective `targetOrigin` / `close` for the
  // active session, produced by `resolve(startOptions)` when `start`
  // runs so start-time overrides win over construction values.
  let targetOrigin: string | undefined
  let close_fn: ((handle: Target) => void | Promise<void>) | undefined

  const emitter = Events.create<Transport.EventMap<MessageMeta<target>>>()

  // `started` = currently in an active connection cycle (target acquired,
  // listeners attached, hello sent). After close, drops back to `false`,
  // and `start()` / `send()` can re-acquire — popups closing externally
  // is a normal end-of-session event, not a permanent transport failure.
  const state = { ready: false, started: false }
  let buffered: Envelope.Envelope[] = []
  let startPromise: Promise<void> | undefined
  let connectPromise: Promise<void> | undefined
  // Resolved target thunk for the active session. `start` binds it from
  // `resolve(...)`; `connect` invokes it lazily so the consumer never
  // acquires its target (e.g. opens a popup) until the first outbound frame.
  let acquire: (() => Target | Promise<Target>) | undefined
  // Widened to `Target` internally — the public `target` generic constrains
  // only the caller's `target` / `close` shapes, not internal storage.
  let handle: Target | undefined
  let unsubscribeMessage: (() => void) | undefined
  let closedPoll: ReturnType<typeof setInterval> | undefined

  function emitError(error: Error) {
    emitter.emit('error', error)
  }

  function emitClose(cause?: Error) {
    if (!state.started) return
    state.started = false
    state.ready = false
    buffered = []
    handle = undefined
    acquire = undefined
    if (unsubscribeMessage) {
      unsubscribeMessage()
      unsubscribeMessage = undefined
    }
    if (closedPoll) {
      clearInterval(closedPoll)
      closedPoll = undefined
    }
    emitter.emit('close', cause)
  }

  function postRaw(data: object) {
    if (!handle) throw new Transport.ClosedError('postMessage transport has no handle')
    // Per the uRPC window-transport spec, every outbound frame
    // (control or envelope) carries a sender-generated v4 UUID `id`.
    // Decoration happens at the wire boundary so callers never have to
    // think about it.
    const wire = protocol.withId(data)
    if (protocol.isPortLike(handle)) {
      handle.postMessage(wire)
      return
    }
    if (!targetOrigin)
      throw new TargetOriginRequiredError(
        '`targetOrigin` is required for Window / WindowProxy targets',
      )
    handle.postMessage(wire, targetOrigin)
  }

  function emitMessage(envelope: Envelope.Envelope, meta?: MessageMeta<target>) {
    emitter.emit(
      'message',
      ...((meta === undefined ? [envelope] : [envelope, meta]) as Events.EventArgs<
        Transport.EventMap<MessageMeta<target>>['message']
      >),
    )
  }

  function attachListener() {
    if (!handle) return
    if (protocol.isPortLike(handle)) {
      const port = handle
      const listener = (event: MessageEvent) => {
        handleInbound(event.data)
      }
      port.addEventListener('message', listener)
      port.start()
      unsubscribeMessage = () => {
        port.removeEventListener('message', listener)
      }
      return
    }
    if (!source)
      throw new TargetOriginRequiredError(
        'no `source` window available to receive postMessage events',
      )
    const expectedOrigin = targetOrigin
    const listener = (event: MessageEvent) => {
      // Window targets — only honour events whose origin is pinned.
      // `'*'` means "accept any origin"; matches the postMessage outbound
      // semantics on the same field.
      if (expectedOrigin !== '*' && event.origin !== expectedOrigin) return
      // Origin alone can't tell two same-origin windows apart, so when the
      // browser identifies the sender, drop frames from any window but the
      // one we opened (else sibling same-origin sessions cross-read). Absent
      // `event.source` falls through to the origin pin.
      if (event.source && event.source !== (handle as unknown as MessageEventSource)) return
      handleInbound(event.data, { origin: event.origin } as MessageMeta<target>)
    }
    source.addEventListener('message', listener as EventListener)
    unsubscribeMessage = () => {
      source.removeEventListener('message', listener as EventListener)
    }
  }

  function handleInbound(data: unknown, meta?: MessageMeta<target>) {
    // Per the uRPC window-transport spec, every inbound frame must
    // carry a top-level v4 UUID `id`. Frames missing or malforming `id`
    // are a protocol violation; we surface them as `error` and drop the
    // frame (no JSON-RPC response — the peer might be a stale tab still
    // emitting non-spec frames, and the wata-level mode discipline
    // gate covers the keyed-phase tear-down case).
    const inbound = protocol.readFrame(data)
    if (!inbound) {
      emitError(
        new InvalidFrameError('inbound postMessage frame is missing or has malformed v4 UUID `id`'),
      )
      return
    }
    const { frame } = inbound
    if (protocol.isControlFrame(frame)) {
      // The first time we hear the peer, announce back before draining: a host
      // that mounted after our initial announce (e.g. a still-loading iframe)
      // otherwise never hears us, never readies, and strands its buffered frames.
      if (frame.type === handshake.expect) {
        if (!state.ready)
          try {
            postRaw(handshake.send)
          } catch (error) {
            emitError(error as Error)
          }
        markReady()
      }
      return
    }
    let envelope: Envelope.Envelope
    try {
      envelope = Envelope.parse(frame)
    } catch (error) {
      emitError(error as Error)
      return
    }
    // Receiving a real frame implies the peer is alive and listening — even
    // if we never observed their hello (the iframe / popup mount races).
    // Mark ourselves ready so any buffered outbound frames flush before we
    // hand the inbound payload off to the user-facing listeners.
    if (!state.ready) markReady()
    emitMessage(envelope, meta)
  }

  function markReady() {
    if (state.ready) return
    state.ready = true
    // Drain any frames the caller queued while waiting for ready.
    while (buffered.length > 0) {
      const next = buffered.shift()
      if (next === undefined) continue
      try {
        postRaw(next)
      } catch (error) {
        emitError(error as Error)
      }
    }
  }

  function attachClosedPoll() {
    if (!handle || protocol.isPortLike(handle)) return
    const win = handle as unknown as { closed?: boolean }
    if (typeof win.closed !== 'boolean') return
    closedPoll = setInterval(() => {
      if (win.closed)
        emitClose(new Transport.ClosedError('postMessage handle was closed externally'))
    }, 250)
  }

  async function start(options?: startOptions): Promise<void> {
    if (state.started) return
    if (startPromise) return startPromise
    // Keep the cleanup in this function's `finally` rather than the IIFE's:
    // the consumer path has no `await`, so an inner `finally` would run
    // synchronously *before* the `startPromise = …` assignment and leak a
    // resolved promise that wedges the next `start`.
    startPromise = (async () => {
      const resolved = resolve(options)
      targetOrigin = resolved.targetOrigin
      close_fn = resolved.close as ((handle: Target) => void | Promise<void>) | undefined
      acquire = resolved.target
      // The host responds to inbound traffic, so it acquires its target and
      // attaches listeners now. The consumer defaults to deferring connection
      // to the first outbound frame (see `connect` / `send`) so `start` never
      // acquires a target — e.g. opens a popup — outside a user gesture. A
      // consumer whose target needs no gesture (an iframe, an already-open
      // window, a MessagePort) can opt into `connect: 'eager'` so the
      // handshake completes during `start` and proactive host notifications
      // (e.g. `accountsChanged`) are received without an outbound request.
      if (role === 'host' || resolved.connect === 'eager') await connect()
      state.started = true
    })()
    try {
      await startPromise
    } finally {
      startPromise = undefined
    }
  }

  // Acquire the target, attach inbound listeners, and announce hello. Runs on
  // `start` for the host and on the first outbound frame for the consumer.
  async function connect(): Promise<void> {
    if (handle) return
    if (connectPromise) return connectPromise
    connectPromise = (async () => {
      if (!acquire) throw new Transport.ClosedError('postMessage transport is not started')
      const acquired = await acquire()
      if (acquired === null || acquired === undefined)
        throw new PopupBlockedError('`target` returned null — popup blocked or window unavailable')
      if (!protocol.isWindowLike(acquired) && !protocol.isPortLike(acquired))
        throw new InvalidTargetError(
          '`target` must return a Window, WindowProxy, or MessagePort handle',
        )
      handle = acquired
      attachListener()
      attachClosedPoll()
      // Send our hello after the listener is attached so the peer's reply
      // is never missed.
      postRaw(handshake.send)
    })()
    try {
      await connectPromise
    } finally {
      connectPromise = undefined
    }
  }

  return {
    capabilities: {
      notifications: { consumer: true, host: true },
      requests: { consumer: true, host: false },
    },
    async close(cause) {
      if (!state.started) return
      const handle_local = handle
      try {
        if (handle_local && close_fn) await close_fn(handle_local)
        else if (
          handle_local &&
          'close' in handle_local &&
          typeof handle_local.close === 'function'
        )
          (handle_local as { close: () => void }).close()
      } catch (error) {
        emitError(error as Error)
      } finally {
        emitClose(cause)
      }
    },
    ...(discovery ? { discovery } : {}),
    exchange: 'ongoing',
    name: 'postMessage',
    on: emitter.on,
    role,
    async send(envelope) {
      if (!state.started) await start()
      // Lazily connect on the first outbound frame — acquires the target
      // (e.g. opens the popup) inside the caller's gesture rather than at
      // `start`. No-op once connected.
      await connect()
      if (!state.ready) {
        buffered.push(envelope)
        return
      }
      postRaw(envelope)
    },
    start,
  }
}

/**
 * Per-start options shape returned by a side's `resolve` callback. The
 * consumer / host factories merge their construction {@link Options} with
 * the start-time overrides and normalize the result into this form —
 * `targetOrigin` is derived from the caller's `host` (consumer) or passed
 * through (host), and `target` is bound to a parameterless callback.
 *
 * @internal
 */
export type InternalOptions<target extends Target> = {
  close?: ((handle: target) => void | Promise<void>) | undefined
  /**
   * When the connection is established. `'eager'` acquires the target,
   * attaches listeners, and sends hello during `start()`; `'lazy'`
   * (default) defers all of that to the first outbound frame. The host
   * always connects eagerly regardless of this value.
   */
  connect?: 'eager' | 'lazy' | undefined
  target: () => target | Promise<target>
  targetOrigin: string | undefined
}

export declare namespace createSide {
  /** Parameters for {@link createSide}. */
  type Options<role extends 'consumer' | 'host', target extends Target, startOptions> = {
    /**
     * Optional discovery contribution. The host side passes a `window`
     * binding so the published `host.json` advertises that this origin
     * speaks `postMessage`; the consumer side omits it.
     */
    discovery?: Transport.DiscoveryBinding | undefined
    /** Outbound control frame and the inbound frame type to wait for. */
    handshake: { expect: protocol.WireFrame['type']; send: protocol.WireFrame }
    /**
     * Produce the effective per-start {@link InternalOptions} from the
     * start-time overrides, merging them over the construction values
     * (start wins). Invoked once each time `start` runs.
     */
    resolve: (options?: startOptions) => InternalOptions<target>
    /** Side of the protocol this transport speaks for. */
    role: role
    /**
     * `Window` / `WindowProxy` realm where inbound `message` events are
     * received. Construction-only; defaults to the global `window`.
     */
    source?: WindowLike | undefined
  }
}

/**
 * Thrown when the caller's `target` callback returns `null` — the canonical
 * signal from `window.open` that the popup was blocked, or that the
 * caller is in a context (e.g. SSR) where the window isn't available.
 */
export class PopupBlockedError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'PostMessage.PopupBlockedError'
}

/**
 * Thrown when `targetOrigin` is required (Window / WindowProxy target) but
 * was omitted from {@link Options}.
 */
export class TargetOriginRequiredError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.ProtocolError<cause> {
  override name = 'PostMessage.TargetOriginRequiredError'
}

/**
 * Thrown when `start()` runs but no `target` was supplied at construction
 * (`postMessage({ target })`) or at start (`start({ target })`) — the
 * transport has no way to acquire a `Window` / `MessagePort` handle.
 */
export class TargetRequiredError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.ProtocolError<cause> {
  override name = 'PostMessage.TargetRequiredError'
}

/**
 * Thrown when the handle returned from `target` is neither a Window-shaped
 * object nor a MessagePort. Helps catch typos in the bring-your-own
 * mounting code at start time rather than first message.
 */
export class InvalidTargetError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.ProtocolError<cause> {
  override name = 'PostMessage.InvalidTargetError'
}

/**
 * Surfaced via the transport's `error` event when an inbound `message`
 * frame is missing the spec-mandated top-level `{ id: <uuid v4> }`, or
 * the value is not a syntactically valid v4 UUID. The frame is dropped
 * — non-conforming peers (or stale tabs) shouldn't be able to inject
 * envelopes into the wata by accident.
 */
export class InvalidFrameError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.ProtocolError<cause> {
  override name = 'PostMessage.InvalidFrameError'
}

/**
 * Thrown when the caller's `host` option is not a valid URL or origin.
 * The transport derives `postMessage`'s `targetOrigin` from `host` via
 * `new URL(host).origin`, so unparseable values are rejected at start
 * time rather than silently broadcasting to `'*'`.
 */
export class InvalidHostError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.ProtocolError<cause> {
  override name = 'PostMessage.InvalidHostError'
}
