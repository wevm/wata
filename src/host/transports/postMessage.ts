/**
 * Host-side `postMessage` transport — speaks `postMessage` over a `Window`,
 * `WindowProxy`, or `MessagePort` handle.
 *
 * The host side is the mirror of the consumer transport: same `target`
 * callback shape, same origin pinning, but the ready handshake is
 * inverted (host emits `urpc.ready`, waits for the consumer's
 * `urpc.hello`). Unlike the consumer, the host's `target` is
 * **optional** — it defaults to `window.opener ?? window.parent`, the
 * peer that opened this page (popup or iframe). Pass an explicit
 * `target` when you need a `MessagePort` or a non-default Window.
 *
 * @example default target (popup or iframe)
 * ```ts
 * import { Handshake, postMessage } from 'handshakes/host'
 *
 * const handshake = Handshake.create({
 *   transport: postMessage({ targetOrigin: 'https://app.example' }),
 * })
 * await handshake.start()
 * ```
 *
 * @example explicit MessagePort target
 * ```ts
 * const handshake = Handshake.create({
 *   transport: postMessage({ target: () => receivedPort }),
 * })
 * ```
 */

import * as Errors from '../../core/Errors.js'
import * as protocol from '../../consumer/transports/internal/protocol.js'
import * as ConsumerPostMessage from '../../consumer/transports/postMessage.js'
import * as Transport from '../../core/Transport.js'

/**
 * Options accepted by the host-side {@link postMessage}. Identical to the
 * consumer's {@link ConsumerPostMessage.Options}, except both `target`
 * and `targetOrigin` are optional — the host genuinely doesn't know its
 * peer up front.
 */
export type Options<target extends ConsumerPostMessage.Target = Window> =
  target extends ConsumerPostMessage.Target
    ? Omit<ConsumerPostMessage.Options<target>, 'target' | 'targetOrigin'> & {
        /**
         * Called lazily on `start()` to acquire the postMessage target —
         * the consumer `Window` / `MessagePort` to talk back to. Defaults
         * to `window.opener ?? window.parent` when omitted, throwing
         * {@link NoPeerError} if neither is present.
         */
        target?: (() => target | Promise<target>) | undefined
        /**
         * `postMessage` `targetOrigin`. Defaults to `'*'` because the
         * host can't know the consumer's origin up front. Tighten this
         * to a specific origin (passed via URL param, derived from
         * `document.referrer`, or pinned after the first inbound frame)
         * whenever the consumer's identity is known.
         */
        targetOrigin?: string | undefined
      }
    : never

/**
 * Create a host-side `postMessage` transport.
 *
 * @example
 * ```ts
 * import { Handshake, postMessage } from 'handshakes/host'
 *
 * const handshake = Handshake.create({
 *   transport: postMessage({ targetOrigin: 'https://app.example' }),
 * })
 * ```
 */
export function postMessage<const target extends ConsumerPostMessage.Target = Window>(
  options: Options<target> = {} as Options<target>,
): Transport.Transport<'host'> {
  const target_resolved =
    options.target ??
    ((() => {
      const peer =
        window.opener ?? (window.parent !== window ? window.parent : undefined)
      if (!peer)
        throw new NoPeerError(
          'no `window.opener` or `window.parent` — open this page from a consumer or pass an explicit `target`',
        )
      return peer as unknown as target
    }) as () => target | Promise<target>)

  return ConsumerPostMessage.createSide({
    role: 'host',
    handshake: { send: protocol.hostReady, expect: protocol.consumerHello.type },
    options: {
      ...options,
      target: target_resolved,
      targetOrigin: options.targetOrigin ?? '*',
    } as never,
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
