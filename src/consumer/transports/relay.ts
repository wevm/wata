/**
 * Consumer-side `relay` transport.
 *
 * The consumer discovers or receives a relay endpoint, posts an
 * ephemeral key-share through it, waits for the host key-share, then
 * exchanges encrypted envelopes through signed relay HTTP requests.
 */

import * as Discovery from '../../core/Discovery.js'
import * as RelayTransportCore from '../../core/internal/relayTransport.js'
import * as Transport from '../../core/Transport.js'

/** Options accepted by {@link relay}. */
export type Options = Options.DiscoveryMode | Options.Direct

export declare namespace Options {
  /** Discovery-backed relay options. */
  type DiscoveryMode = {
    /** Optional fetch override for host discovery and relay traffic. */
    fetch?: typeof globalThis.fetch | undefined
    /** Host origin or pre-parsed host discovery document. */
    host: string | Discovery.HostDocument
    /** Shared out-of-band secret bound into relay session keys. */
    pairingSecret: string
    /** Shared relay session id. */
    sessionId: string
  }

  /** Direct relay endpoint options. */
  type Direct = {
    /** Optional fetch override for relay traffic. */
    fetch?: typeof globalThis.fetch | undefined
    /** Shared out-of-band secret bound into relay session keys. */
    pairingSecret: string
    /** Shared relay session id. */
    sessionId: string
    /** Relay endpoint URL. */
    url: string
  }
}

/** Consumer-side relay transport. */
export type RelayTransport = Transport.Transport<'consumer', 'relay'>

/** Create a consumer-side `relay` transport. */
export function relay(options: Options): RelayTransport {
  const fetchImpl = options.fetch
  const url = (async () => {
    if ('url' in options) return options.url
    const document =
      typeof options.host === 'string'
        ? await Discovery.fetchHost(options.host, { fetch: fetchImpl })
        : options.host
    const binding = document.transports.relay
    if (!binding)
      throw new Transport.UnsupportedError('host does not advertise a `relay` transport binding')
    return binding.url
  })()

  return RelayTransportCore.create({
    fetch: fetchImpl,
    pairingSecret: options.pairingSecret,
    role: 'consumer',
    sessionId: options.sessionId,
    url,
  })
}
