/**
 * Consumer-side `mobile-web-auth` transport.
 *
 * Opens the host's HTTPS authorization URL, then waits for the native app
 * callback URL to deliver the encrypted `rpc-responses` frame. The
 * callback is handled explicitly via {@link MobileWebAuth.handle}, which
 * lets Expo / React Native / browser simulations wire their own deep-link
 * listener without changing the transport contract.
 */

import { Base64, Bytes } from 'ox'

import * as Crypto from '../../core/Crypto.js'
import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as core_mobileWebAuth from '../../core/internal/mobileWebAuth.js'
import * as Session from '../../core/Session.js'
import * as Transport from '../../core/Transport.js'

/** Options accepted by {@link mobileWebAuth}. */
export type Options = {
  /** Exact app-link / private-scheme callback URL the host redirects back to. */
  callbackUrl: string
  /** Override the discovery `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch | undefined
  /** Host origin to discover, or a pre-parsed `host.json`. */
  host: string | Discovery.HostDocument
  /** Consumer id/origin. Defaults to the wrapping `Wata.create({ baseUrl })`. */
  id?: string | undefined
  /** Opens the host authorization URL. Defaults to `location.assign` in browsers. */
  open?: ((url: string) => unknown) | undefined
}

/** Consumer transport plus explicit deep-link callback handler. */
export type MobileWebAuth = Transport.Transport<'consumer', 'mobileWebAuth'> & {
  /** Handle the callback URL delivered by the platform deep-link listener. */
  handle: (url: string | URL) => Promise<void>
}

/**
 * Create a consumer-side `mobile-web-auth` transport.
 *
 * @example
 * ```ts
 * import { Wata, mobileWebAuth } from 'wata'
 *
 * const wata = Wata.create({
 *   baseUrl: 'https://app.example',
 *   transports: [
 *     mobileWebAuth({
 *       callbackUrl: 'com.example.app://callback',
 *       host: 'https://wallet.example',
 *       open: (url) => Linking.openURL(url),
 *     }),
 *   ],
 * })
 * ```
 */
export function mobileWebAuth(options: Options): MobileWebAuth {
  const {
    callbackUrl,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    host,
    open = openUrl,
  } = options

  const id_ctor = options.id
  let id_bound: string | undefined

  const emitter = Events.create<Transport.EventMap>()

  type Pending = {
    callbackUrl: string
    keypair: Crypto.Keypair
    state: string
  }
  type State = {
    closed: boolean
    inFlight: boolean
    pending: Pending | undefined
    started: boolean
  }
  const state: State = {
    closed: false,
    inFlight: false,
    pending: undefined,
    started: false,
  }

  async function resolveHost(): Promise<Discovery.HostDocument> {
    if (typeof host === 'string') return await Discovery.fetchHost(host, { fetch: fetchImpl })
    return host
  }

  function resolveId(): string {
    const id = id_ctor ?? id_bound
    if (!id)
      throw new Transport.TransportError(
        'mobile-web-auth consumer id could not be derived before `Wata.create({ baseUrl })` bound the transport',
      )
    return id
  }

  function settle(message: Envelope.Envelope | undefined, cause?: Error) {
    if (state.closed) return
    state.closed = true
    state.inFlight = false
    state.pending = undefined
    if (cause) emitter.emit('error', cause)
    if (message) emitter.emit('message', message)
    emitter.emit('close', cause)
  }

  async function runExchange(envelope: Envelope.Envelope): Promise<void> {
    if (envelope.type !== 'rpc-requests')
      throw new Transport.UnsupportedError(
        `mobile-web-auth transport only carries rpc-requests envelopes; received \`${envelope.type}\``,
      )

    const document = await resolveHost()
    const binding = document.transports['mobile-web-auth']
    if (!binding)
      throw new Transport.UnsupportedError(
        'host does not advertise a `mobile-web-auth` transport binding',
      )
    assertAuthUrlOrigin(document, binding.auth_url)

    const keypair = Crypto.randomKeypair()
    const sessionState = Base64.fromBytes(Bytes.random(16), { pad: false, url: true })
    state.pending = { callbackUrl, keypair, state: sessionState }

    const url = new URL(binding.auth_url)
    url.searchParams.set('callback', callbackUrl)
    url.searchParams.set('id', resolveId())
    url.searchParams.set('message', core_mobileWebAuth.encodeMessage(envelope))
    url.searchParams.set('pubkey', core_mobileWebAuth.encodePublicKey(keypair.x25519.publicKey))
    url.searchParams.set('state', sessionState)
    url.searchParams.set('version', '1')

    await open(url.toString())
  }

  return {
    bind(binding) {
      const { baseUrl } = binding
      if (!baseUrl) return
      if (id_ctor) return
      if (id_bound) return
      id_bound = baseUrl.replace(/\/+$/, '')
    },
    callbackUrls: [callbackUrl],
    async close(cause) {
      if (state.closed) return
      state.closed = true
      state.inFlight = false
      state.pending = undefined
      emitter.emit('close', cause)
    },
    exchange: 'single_exchange',
    async handle(input) {
      const pending = state.pending
      if (!pending)
        throw new Transport.ClosedError('mobile-web-auth has no pending callback session')

      try {
        const url = new URL(input)
        assertCallbackMatches(url, pending.callbackUrl)
        if (url.searchParams.get('version') !== '1')
          throw new Errors.ProtocolError('mobile-web-auth callback version mismatch')
        if (url.searchParams.get('state') !== pending.state)
          throw new Errors.ProtocolError('mobile-web-auth callback state mismatch')

        const publicKey = url.searchParams.get('pubkey')
        const message = url.searchParams.get('message')
        if (!publicKey) throw new Errors.ProtocolError('mobile-web-auth callback missing pubkey')
        if (!message) throw new Errors.ProtocolError('mobile-web-auth callback missing message')

        const keys = Session.derive({
          peer: { publicKey: core_mobileWebAuth.decodePublicKey(publicKey) },
          role: 'consumer',
          self: pending.keypair.x25519,
          transportId: core_mobileWebAuth.transportId,
        })
        const envelope = core_mobileWebAuth.open({
          envelope: core_mobileWebAuth.decodeMessage(message),
          expectedFrom: Envelope.from.host,
          key: keys.h2c,
          publicKey: pending.keypair.x25519.publicKey,
        })
        if (envelope.type !== 'rpc-responses')
          throw new Errors.ProtocolError('mobile-web-auth callback message must be rpc-responses')
        settle(envelope)
      } catch (cause) {
        settle(undefined, cause as Error)
        throw cause
      }
    },
    name: 'mobileWebAuth',
    on: emitter.on,
    role: 'consumer',
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
      if (state.inFlight)
        throw new Transport.TransportError(
          'mobile-web-auth is single-exchange; a previous send is still in flight',
        )
      if (!state.started) state.started = true
      state.inFlight = true

      void runExchange(envelope).catch((cause) => settle(undefined, cause as Error))
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
      state.started = true
    },
  }
}

function assertAuthUrlOrigin(document: Discovery.HostDocument, authUrl: string): void {
  if (new URL(authUrl).origin !== document.origin)
    throw new Errors.ProtocolError('mobile-web-auth auth_url origin mismatch', {
      details: `expected ${document.origin}, received ${new URL(authUrl).origin}`,
    })
}

function assertCallbackMatches(url: URL, callbackUrl: string): void {
  const actual = stripCallbackParameters(url)
  const expected = stripCallbackParameters(new URL(callbackUrl))
  if (actual !== expected)
    throw new Errors.ProtocolError('mobile-web-auth callback URL mismatch', {
      details: `expected ${expected}, received ${actual}`,
    })
}

function openUrl(url: string): unknown {
  const global = globalThis as {
    location?: { assign?: (url: string) => void; href?: string } | undefined
  }
  if (global.location?.assign) {
    global.location.assign(url)
    return
  }
  throw new Transport.TransportError(
    '`mobileWebAuth({ open })` is required outside a browser navigation context',
  )
}

function stripCallbackParameters(url: URL): string {
  const clone = new URL(url)
  clone.hash = ''
  clone.searchParams.delete('message')
  clone.searchParams.delete('pubkey')
  clone.searchParams.delete('state')
  clone.searchParams.delete('version')
  return clone.toString()
}
