/**
 * Host-side `relay` transport.
 *
 * The host polls a relay endpoint for a consumer key-share, answers with
 * its own key-share, then exchanges encrypted envelopes through signed
 * relay HTTP requests.
 */

import * as RelayTransportCore from '../../core/internal/relayTransport.js'
import * as Transport from '../../core/Transport.js'

/** Options accepted by {@link relay}. */
export type Options = {
  /** Optional fetch override for relay traffic. */
  fetch?: typeof globalThis.fetch | undefined
  /** Shared out-of-band secret bound into relay session keys. */
  pairingSecret: string
  /** Shared relay session id. */
  sessionId: string
  /** Relay endpoint URL. */
  url: string
}

/** Host-side relay transport. */
export type RelayTransport = Transport.Transport<'host', 'relay'>

/** Create a host-side `relay` transport. */
export function relay(options: Options): RelayTransport {
  return {
    ...RelayTransportCore.create({
      fetch: options.fetch,
      pairingSecret: options.pairingSecret,
      role: 'host',
      sessionId: options.sessionId,
      url: options.url,
    }),
    discovery: {
      binding: () => ({ url: options.url }),
      id: 'relay',
    },
  }
}
