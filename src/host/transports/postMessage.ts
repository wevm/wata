/**
 * Host-side `postMessage` transport — speaks `postMessage` over a `Window`,
 * `WindowProxy`, or `MessagePort` handle.
 *
 * The host side is the mirror of the consumer transport: same `target`
 * callback shape, same origin pinning, but the readiness handshake is
 * inverted (host emits `urpc.ready`, waits for the consumer's
 * `urpc.hello`). Unlike the consumer, the host's `target` is
 * **optional** — it defaults to `window.opener ?? window.parent`, the
 * peer that opened this page (popup or iframe). Pass an explicit
 * `target` when you need a `MessagePort` or a non-default Window.
 *
 * @example default target (popup or iframe)
 * ```ts
 * import { Wata, postMessage } from 'wata/host'
 *
 * const wata = Wata.create({
 *   transports: [postMessage({ targetOrigin: 'https://app.example' })],
 * })
 *
 * wata.on('request', async (event) => {
 *   if (event.method === 'ping') await event.respond({ ok: true })
 * })
 * ```
 *
 * @example explicit MessagePort target
 * ```ts
 * const port = new Promise<MessagePort>((resolve) => {
 *   window.addEventListener('message', (event) => {
 *     if (event.origin !== 'https://app.example') return
 *     if (event.data?.type === 'wata.port') resolve(event.ports[0]!)
 *   })
 * })
 *
 * const wata = Wata.create({
 *   transports: [
 *     postMessage({
 *       target: () => port,
 *       targetOrigin: 'https://app.example',
 *     }),
 *   ],
 * })
 * ```
 */

import * as protocol from '../../consumer/transports/internal/protocol.js'
import * as ConsumerPostMessage from '../../consumer/transports/postMessage.js'
import * as Errors from '../../core/Errors.js'
import * as Transport from '../../core/Transport.js'

/**
 * Options accepted by the host-side {@link postMessage}. Both `target`
 * and `targetOrigin` are optional — the host genuinely doesn't know its
 * peer up front.
 */
export type Options<target extends ConsumerPostMessage.Target = Window> = {
  /**
   * Optional cleanup. Called from `close()` after the transport
   * unsubscribes its `message` listener. Defaults to `handle.close?.()`.
   */
  close?: ((handle: target) => void | Promise<void>) | undefined
  /**
   * `Window` / `WindowProxy` realm where inbound `message` events are
   * received. Defaults to the global `window`.
   */
  source?: ConsumerPostMessage.WindowLike | undefined
  /**
   * Called lazily when the transport starts to acquire the consumer
   * `Window` / `MessagePort` to talk back to. Defaults to
   * `window.opener ?? window.parent` when omitted, throwing
   * {@link NoPeerError} if neither is present.
   */
  target?: (() => target | Promise<target>) | undefined
  /**
   * `postMessage` `targetOrigin`. Defaults to `'*'` because the host
   * can't know the consumer's origin up front. Tighten this to a
   * specific origin (passed via URL param, derived from
   * `document.referrer`, or pinned after the first inbound frame)
   * whenever the consumer's identity is known.
   */
  targetOrigin?: string | undefined
}

/** Metadata emitted by Window-backed host-side postMessage transports. */
export type OriginMessageMeta = ConsumerPostMessage.OriginMessageMeta

/**
 * Create a host-side `postMessage` transport.
 *
 * @example
 * ```ts
 * import { Wata, postMessage } from 'wata/host'
 *
 * const wata = Wata.create({
 *   transports: [postMessage({ targetOrigin: 'https://app.example' })],
 * })
 * ```
 */
export function postMessage<const target extends ConsumerPostMessage.Target = Window>(
  options: Options<target> = {} as Options<target>,
): Transport.Transport<'host', 'postMessage', void, ConsumerPostMessage.MessageMeta<target>> {
  const target_resolved =
    options.target ??
    ((() => {
      const peer = window.opener ?? (window.parent !== window ? window.parent : undefined)
      if (!peer)
        throw new NoPeerError(
          'no `window.opener` or `window.parent` — open this page from a consumer or pass an explicit `target`',
        )
      return peer as unknown as target
    }) as () => target | Promise<target>)

  return ConsumerPostMessage.createSide({
    options: {
      close: options.close,
      source: options.source,
      target: target_resolved,
      targetOrigin: options.targetOrigin ?? '*',
    },
    handshake: { expect: protocol.consumerHello.type, send: protocol.hostReady },
    role: 'host',
  })
}

/**
 * Thrown when the host-side {@link postMessage} transport falls back to
 * its default `target` and finds neither `window.opener` nor a parent
 * frame — the host page is being run standalone instead of as a popup
 * or iframe of the consumer.
 */
export class NoPeerError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'PostMessage.NoPeerError'
}
