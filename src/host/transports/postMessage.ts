/**
 * Host-side `postMessage` transport — speaks `postMessage` over a `Window`,
 * `WindowProxy`, or `MessagePort` handle supplied by the caller.
 *
 * The host side is the mirror of the consumer transport: same `open`
 * callback shape, same origin pinning, but the ready handshake is
 * inverted (host emits `tempocp.ready`, waits for the consumer's
 * `tempocp.hello`).
 *
 * @example opener-supplied window (host running inside a popup)
 * ```ts
 * import { Handshake, postMessage } from 'handshakes/host'
 *
 * const transport = postMessage({
 *   open: () => window.opener,
 *   targetOrigin: 'https://app.example',
 * })
 * const handshake = Handshake.create({ transport })
 * await handshake.connect()
 * ```
 */

import * as protocol from '../../consumer/transports/internal/protocol.js'
import * as ConsumerPostMessage from '../../consumer/transports/postMessage.js'
import * as Transport from '../../core/Transport.js'

/**
 * Create a host-side `postMessage` transport.
 *
 * @example
 * ```ts
 * import { postMessage } from 'handshakes/host'
 *
 * const transport = postMessage({
 *   open: () => window.opener,
 *   targetOrigin: 'https://app.example',
 * })
 * ```
 */
export function postMessage<const target extends ConsumerPostMessage.Target>(
  options: ConsumerPostMessage.Options<target>,
): Transport.Transport<'host'> {
  return ConsumerPostMessage.createSide({
    role: 'host',
    handshake: { send: protocol.hostReady, expect: protocol.consumerHello.type },
    options,
  })
}
