/**
 * Consumer-side `postMessage` transport — speaks `postMessage` over a
 * `Window`, `WindowProxy`, or `MessagePort` handle supplied by the caller.
 *
 * The transport never opens popups or iframes itself. Instead the caller
 * passes an `open` callback that returns a handle on demand. The library
 * owns the **wire** (origin pinning, ready handshake, listener cleanup,
 * closed detection); the caller owns the **mount** (popup vs iframe vs
 * channel vs opener-supplied window).
 *
 * @example popup
 * ```ts
 * import { Handshake, postMessage } from 'handshakes'
 *
 * const transport = postMessage({
 *   open: () => window.open('https://wallet.example/auth', '_blank', 'popup=1'),
 *   targetOrigin: 'https://wallet.example',
 * })
 * const handshake = Handshake.create({ transport })
 * await handshake.start()
 * ```
 *
 * @example iframe
 * ```ts
 * const transport = postMessage({
 *   open: () => {
 *     const iframe = document.createElement('iframe')
 *     iframe.src = 'https://wallet.example/auth'
 *     iframe.hidden = true
 *     document.body.appendChild(iframe)
 *     return iframe.contentWindow!
 *   },
 *   targetOrigin: 'https://wallet.example',
 *   close: (handle) => (handle as Window).frameElement?.remove(),
 * })
 * ```
 *
 * @example MessageChannel
 * ```ts
 * const transport = postMessage({
 *   open: () => {
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
 * Common options shared between every {@link postMessage} call shape.
 *
 * @internal — exported only so the host transport can re-export {@link Options}.
 */
export type CommonOptions<target extends Target> = {
  /**
   * Called lazily on `start()` to acquire the postMessage target. Lazy so
   * popup-blocker-sensitive callers can wire `start()` to a user-gesture
   * handler (button click).
   */
  open: () => target | Promise<target>
  /**
   * Optional cleanup. Called from `close()` after the transport
   * unsubscribes its `message` listener. Defaults to `handle.close?.()`.
   */
  close?: ((handle: target) => void | Promise<void>) | undefined
  /**
   * `Window` / `WindowProxy` realm where inbound `message` events are
   * received. Defaults to the global `window`.
   */
  source?: WindowLike | undefined
}

/**
 * Options accepted by {@link postMessage}.
 *
 * `targetOrigin` is **required** when the handle is a `Window` /
 * `WindowProxy`, and optional for `MessagePort` (channels don't carry
 * origin information).
 */
export type Options<target extends Target> = target extends MessagePort
  ? CommonOptions<target> & {
      /** `MessagePort` targets don't carry origin — this field is unused. */
      targetOrigin?: string | undefined
    }
  : CommonOptions<target> & {
      /**
       * Required for `Window` / `WindowProxy` targets — `postMessage`'s
       * `targetOrigin`. Inbound events whose `origin` doesn't match are
       * rejected.
       */
      targetOrigin: string
    }

/** Minimal `Window`-shaped contract used internally. */
export type WindowLike = {
  postMessage: (data: unknown, targetOrigin: string) => void
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  closed?: boolean
}

/**
 * Create a consumer-side `postMessage` transport.
 *
 * @example
 * ```ts
 * import { postMessage } from 'handshakes'
 *
 * const transport = postMessage({
 *   open: () => window.open('https://wallet.example', '_blank', 'popup=1'),
 *   targetOrigin: 'https://wallet.example',
 * })
 * ```
 */
export function postMessage<const target extends Target>(
  options: Options<target>,
): Transport.Transport<'consumer'> {
  return createSide({
    role: 'consumer',
    handshake: { send: protocol.consumerHello, expect: protocol.hostReady.type },
    options,
  })
}

/**
 * Internal helper — both consumer and host sides share the wire mechanics
 * (ready handshake, origin pinning, listener cleanup, closed detection),
 * so the actual transport object is built here. The host re-exports the
 * same routine via `handshakes/host`.
 */
export function createSide<role extends 'consumer' | 'host', target extends Target>(
  parameters: createSide.Options<role, target>,
): Transport.Transport<role> {
  const { role, handshake, options } = parameters
  const source = options.source ?? (globalThis as { window?: WindowLike }).window

  const emitter = Events.create<Transport.EventMap>()

  const state = { started: false, closed: false, ready: false }
  const buffered: Envelope.Envelope[] = []
  // Widened to `Target` internally — the public `target` generic constrains
  // only the caller's `open` / `close` shapes, not internal storage.
  let handle: Target | undefined
  let unsubscribeMessage: (() => void) | undefined
  let closedPoll: ReturnType<typeof setInterval> | undefined

  function emitError(error: Error) {
    emitter.emit('error', error)
  }

  function emitClose(cause?: Error) {
    if (state.closed) return
    state.closed = true
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

  function postRaw(data: unknown) {
    if (!handle) throw new Transport.ClosedError('postMessage transport has no handle')
    if (protocol.isPortLike(handle)) {
      handle.postMessage(data)
      return
    }
    if (!options.targetOrigin)
      throw new TargetOriginRequiredError(
        '`targetOrigin` is required for Window / WindowProxy targets',
      )
    handle.postMessage(data, options.targetOrigin)
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
      if (event.origin !== expectedOrigin) return
      handleInbound(event.data)
    }
    source.addEventListener('message', listener as EventListener)
    unsubscribeMessage = () => {
      source.removeEventListener('message', listener as EventListener)
    }
  }

  function handleInbound(data: unknown) {
    if (protocol.isControlFrame(data)) {
      if (data.type === handshake.expect) markReady()
      return
    }
    let envelope: Envelope.Envelope
    try {
      envelope = Envelope.parse(data)
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

  return {
    role,
    exchange: 'ongoing',
    async start() {
      if (state.closed) throw new Transport.ClosedError('postMessage transport already closed')
      if (state.started) return
      state.started = true
      const acquired = await options.open()
      if (acquired === null || acquired === undefined)
        throw new PopupBlockedError('`open` returned null — popup blocked or window unavailable')
      if (!protocol.isWindowLike(acquired) && !protocol.isPortLike(acquired))
        throw new InvalidTargetError(
          '`open` must return a Window, WindowProxy, or MessagePort handle',
        )
      handle = acquired
      attachListener()
      attachClosedPoll()
      // Send our hello after the listener is attached so the peer's reply
      // is never missed.
      postRaw(handshake.send)
    },
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('postMessage transport already closed')
      if (!state.started) throw new Transport.ClosedError('postMessage transport not started')
      if (!state.ready) {
        buffered.push(envelope)
        return
      }
      postRaw(envelope)
    },
    async close(cause) {
      if (state.closed) return
      try {
        if (handle && options.close)
          await (options.close as (handle: Target) => void | Promise<void>)(handle)
        else if (handle && 'close' in handle && typeof handle.close === 'function')
          (handle as { close: () => void }).close()
      } catch (error) {
        emitError(error as Error)
      } finally {
        emitClose(cause)
      }
    },
    on: emitter.on,
  }
}

type PostMessageOptions<target extends Target> = Options<target>

export declare namespace createSide {
  /** Parameters for {@link createSide}. */
  type Options<role extends 'consumer' | 'host', target extends Target> = {
    /** Side of the protocol this transport speaks for. */
    role: role
    /** Outbound control frame and the inbound frame type to wait for. */
    handshake: { send: protocol.WireFrame; expect: protocol.WireFrame['type'] }
    /** Caller-supplied options for the underlying `postMessage` transport. */
    options: PostMessageOptions<target>
  }
}

/**
 * Thrown when the caller's `open` callback returns `null` — the canonical
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
 * Thrown when the handle returned from `open` is neither a Window-shaped
 * object nor a MessagePort. Helps catch typos in the bring-your-own
 * mounting code at start time rather than first message.
 */
export class InvalidTargetError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.ProtocolError<cause> {
  override name = 'PostMessage.InvalidTargetError'
}
