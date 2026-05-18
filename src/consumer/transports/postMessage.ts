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
 * const wata = Wata.create({
 *   transport: postMessage({
 *     host: 'https://wallet.example',
 *     target: ({ host }) => window.open(host, '_blank', 'popup=1'),
 *   }),
 * })
 *
 * const { result } = await wata.send({ method: 'wallet_connect', params: [] })
 * ```
 *
 * @example iframe
 * ```ts
 * const transport = postMessage({
 *   host: 'https://wallet.example/auth',
 *   target: ({ host }) => {
 *     const iframe = document.createElement('iframe')
 *     iframe.src = host
 *     iframe.hidden = true
 *     document.body.appendChild(iframe)
 *     return iframe.contentWindow!
 *   },
 *   close: (handle) => (handle as Window).frameElement?.remove(),
 * })
 * ```
 *
 * @example MessageChannel
 * ```ts
 * const transport = postMessage({
 *   target: () => {
 *     const { port1, port2 } = new MessageChannel()
 *     sendPortSomehow(port2)
 *     return port1
 *   },
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
   * Called lazily on `start()` to acquire the postMessage target.
   * Lazy so popup-blocker-sensitive callers can wire `start()` to a
   * user-gesture handler (button click). Receives the caller's `host`
   * value (or `undefined` for `MessagePort` targets that omitted it).
   */
  target: (parameters: { host: string | undefined }) => target | Promise<target>
}

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
export function postMessage<const target extends Target>(
  options: Options<target>,
): Transport.Transport<'consumer'> {
  const { close, host, source, target: acquire } = options
  const targetOrigin = host ? originFrom(host) : undefined
  return createSide<'consumer', target>({
    options: {
      close,
      source,
      target: () => acquire({ host }),
      targetOrigin,
    },
    handshake: { expect: protocol.hostReady.type, send: protocol.consumerHello },
    role: 'consumer',
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
export function createSide<role extends 'consumer' | 'host', target extends Target>(
  parameters: createSide.Options<role, target>,
): Transport.Transport<role> {
  const { handshake, options, role } = parameters
  const source = options.source ?? (globalThis as { window?: WindowLike }).window

  const emitter = Events.create<Transport.EventMap>()

  // `started` = currently in an active connection cycle (target acquired,
  // listeners attached, hello sent). After close, drops back to `false`,
  // and `start()` / `send()` can re-acquire — popups closing externally
  // is a normal end-of-session event, not a permanent transport failure.
  const state = { ready: false, started: false }
  let buffered: Envelope.Envelope[] = []
  let startPromise: Promise<void> | undefined
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
    if (!options.targetOrigin)
      throw new TargetOriginRequiredError(
        '`targetOrigin` is required for Window / WindowProxy targets',
      )
    handle.postMessage(wire, options.targetOrigin)
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
    const expectedOrigin = options.targetOrigin
    const listener = (event: MessageEvent) => {
      // Window targets — only honour events whose origin is pinned.
      // `'*'` means "accept any origin"; matches the postMessage outbound
      // semantics on the same field.
      if (expectedOrigin !== '*' && event.origin !== expectedOrigin) return
      handleInbound(event.data)
    }
    source.addEventListener('message', listener as EventListener)
    unsubscribeMessage = () => {
      source.removeEventListener('message', listener as EventListener)
    }
  }

  function handleInbound(data: unknown) {
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
      if (frame.type === handshake.expect) markReady()
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
    emitter.emit('message', envelope)
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

  async function start(): Promise<void> {
    if (state.started) return
    if (startPromise) return startPromise
    startPromise = (async () => {
      try {
        const acquired = await options.target()
        if (acquired === null || acquired === undefined)
          throw new PopupBlockedError(
            '`target` returned null — popup blocked or window unavailable',
          )
        if (!protocol.isWindowLike(acquired) && !protocol.isPortLike(acquired))
          throw new InvalidTargetError(
            '`target` must return a Window, WindowProxy, or MessagePort handle',
          )
        handle = acquired
        state.started = true
        attachListener()
        attachClosedPoll()
        // Send our hello after the listener is attached so the peer's reply
        // is never missed.
        postRaw(handshake.send)
      } finally {
        startPromise = undefined
      }
    })()
    return startPromise
  }

  return {
    async close(cause) {
      if (!state.started) return
      const handle_local = handle
      try {
        if (handle_local && options.close)
          await (options.close as (handle: Target) => void | Promise<void>)(handle_local)
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
    exchange: 'ongoing',
    on: emitter.on,
    role,
    async send(envelope) {
      if (!state.started) await start()
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
 * Internal options shape consumed by {@link createSide}. The public
 * consumer / host {@link Options} shapes are normalized into this form
 * before being handed off — `targetOrigin` is derived from the caller's
 * `host` (consumer) or defaulted to `'*'` (host), and `target` is bound
 * to a parameterless callback.
 *
 * @internal
 */
export type InternalOptions<target extends Target> = {
  close?: ((handle: target) => void | Promise<void>) | undefined
  source?: WindowLike | undefined
  target: () => target | Promise<target>
  targetOrigin: string | undefined
}

export declare namespace createSide {
  /** Parameters for {@link createSide}. */
  type Options<role extends 'consumer' | 'host', target extends Target> = {
    /** Normalized options for the underlying `postMessage` transport. */
    options: InternalOptions<target>
    /** Side of the protocol this transport speaks for. */
    role: role
    /** Outbound control frame and the inbound frame type to wait for. */
    handshake: { expect: protocol.WireFrame['type']; send: protocol.WireFrame }
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
