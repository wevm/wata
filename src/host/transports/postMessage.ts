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
 * const session = await Wata.create({
 *   transports: [postMessage({ targetOrigin: 'https://app.example' })],
 * }).start()
 *
 * session.onRequest(async (event) => {
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
import * as Uri from '../../internal/Uri.js'

/**
 * Options accepted by the host-side {@link postMessage}. `target`
 * defaults to the opener / parent window; `targetOrigin` — the consumer's
 * origin, conveyed out of band — is required for `Window` targets.
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
   * `postMessage` `targetOrigin` — the consumer's origin, which the
   * consumer conveys out of band (e.g. a URL parameter) before the
   * session (spec §3.1). Required for `Window` / `WindowProxy` targets:
   * the transport never broadcasts to `'*'`, so a Window host given no
   * `targetOrigin` rejects the session (its sends throw
   * {@link PostMessage.TargetOriginRequiredError}). Ignored for
   * `MessagePort` targets, which carry no origin.
   *
   * Optional: when the consumer origin isn't known at construction time,
   * defer it to `start({ targetOrigin })`.
   */
  targetOrigin?: string | undefined
  /**
   * URL of the host page a consumer loads as the embedded host browsing
   * context (popup / iframe). Published in `host.json` as the `window`
   * transport binding so a directory consumer can discover that this
   * origin speaks `postMessage`. Accepts an absolute URL or a path
   * resolved against the wrapping `Wata.create({ baseUrl })`; defaults to
   * `baseUrl` (the origin root) when omitted.
   */
  url?: string | undefined
}

/**
 * Options for the host `postMessage` transport's
 * {@link Transport.Transport.start | start}, derived from the deferrable
 * subset of {@link Options} (`close`, `target`, `targetOrigin`) so their
 * docs live in one place. Each is an optional per-session override of the
 * construction value.
 */
export type StartOptions<target extends ConsumerPostMessage.Target = Window> = Pick<
  Options<target>,
  'close' | 'target' | 'targetOrigin'
>

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
): Transport.Transport<
  'host',
  'postMessage',
  { meta: ConsumerPostMessage.MessageMeta<target>; startOptions: StartOptions<target> }
> {
  const { close, source, target, targetOrigin, url } = options
  const defaultTarget = (() => {
    const peer = window.opener ?? (window.parent !== window ? window.parent : undefined)
    if (!peer)
      throw new NoPeerError(
        'no `window.opener` or `window.parent` — open this page from a consumer or pass an explicit `target`',
      )
    return peer as unknown as target
  }) as () => target | Promise<target>

  return ConsumerPostMessage.createSide({
    discovery: {
      binding(baseUrl) {
        return { url: resolveUrl(baseUrl, url) }
      },
      id: 'window',
    },
    handshake: { expect: protocol.consumerHello.type, send: protocol.hostReady },
    resolve: (start?: StartOptions<target>) => ({
      close: start?.close ?? close,
      target: start?.target ?? target ?? defaultTarget,
      targetOrigin: start?.targetOrigin ?? targetOrigin,
    }),
    role: 'host',
    source,
  })
}

/** Resolve the host-page `url` (absolute or path) against `baseUrl`. */
function resolveUrl(baseUrl: string, url: string | undefined): string {
  if (!url) return baseUrl
  if (/^https?:\/\//.test(url)) return url
  return `${Uri.trimTrailingSlash(baseUrl)}${url.startsWith('/') ? url : `/${url}`}`
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
