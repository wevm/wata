/**
 * Host-side `mobile-link` transport — direct, ongoing peer-to-peer
 * messaging with a consumer app via OS deep links / universal links.
 *
 * Inbound deep links (the consumer's initial handshake link and every
 * subsequent encrypted frame) are fed in via {@link MobileLink.handleUrl}.
 * On the initial link the host verifies the consumer's `return_url`
 * against its `consumer.json` allowlist, derives the session keys, signs
 * `pubkey_host` with the application's long-term identity key (bound by
 * `Wata.create({ identity })`), and answers through the consumer's sticky
 * `return_url` via the injected {@link Options.openLink}.
 *
 * @example
 * ```ts
 * import { Identity, Wata, mobileLink } from 'wata/host'
 *
 * const wata = Wata.create({
 *   baseUrl: 'https://wallet.example',
 *   identity: Identity.fromPrivateKey(process.env.IDENTITY_PRIVATE_KEY),
 *   meta: { name: 'Example Wallet' },
 *   transports: [
 *     mobileLink({ scheme: 'examplewallet', openLink: (url) => Linking.openURL(url) }),
 *   ],
 * })
 *
 * Linking.addEventListener('url', ({ url }) => wata.mobileLink.handleUrl(url))
 * ```
 */

import { Base64, Hex } from 'ox'

import * as Crypto from '../../core/Crypto.js'
import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Nonce from '../../core/Nonce.js'
import * as Rpc from '../../core/Rpc.js'
import * as SessionKey from '../../core/SessionKey.js'
import * as Transport from '../../core/Transport.js'
import * as MobileLinkEnvelope from '../../internal/MobileLinkEnvelope.js'
import * as Uri from '../../internal/Uri.js'

/** Options accepted by {@link mobileLink}. */
export type Options = {
  /**
   * Override the `fetch` implementation used for consumer discovery.
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch | undefined
  /**
   * Open a deep link / universal link. Injected so React Native, Expo,
   * iOS, Android, and tests can supply their native link opener. Optional:
   * a transport built only to advertise discovery (e.g. a `host.json`
   * worker via `Wata.create({ baseUrl }).fetch`) never opens a link.
   * Required for `send`; it throws {@link Transport.TransportError} when
   * it's absent.
   */
  openLink?: ((url: string) => void | Promise<void>) | undefined
  /**
   * Path appended to the wrapping `Wata.create({ baseUrl })` to form the
   * published `universal_link` binding. Defaults to `/urpc`. Ignored when
   * {@link Options.universalLink} is supplied.
   */
  path?: string | undefined
  /** Custom URL scheme registered by the host app (e.g. `examplewallet`). */
  scheme: string
  /**
   * Fully-qualified HTTPS universal/app-link prefix the host responds to.
   * When omitted, derived from the wrapping `Wata.create({ baseUrl })`
   * plus {@link Options.path}.
   */
  universalLink?: string | undefined
}

/** Host-side mobile-link transport. */
export type MobileLink = Transport.Transport<'host', 'mobileLink', { sendValue: void }> & {
  /** Feed an OS-routed inbound deep link into the transport. */
  handleUrl: (url: string) => Promise<void>
}

/**
 * Create a host-side `mobile-link` transport.
 */
export function mobileLink(options: Options): MobileLink {
  const {
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    openLink,
    path = '/urpc',
    scheme,
    universalLink,
  } = options

  const open = (url: string) => {
    if (!openLink)
      throw new Transport.TransportError(
        'mobile-link host requires `openLink` to open the consumer app',
      )
    return openLink(url)
  }

  let identity: Transport.Identity | undefined
  const emitter = Events.create<Transport.EventMap>()

  type Active = {
    handshakeSent: boolean
    inbound: Nonce.decoder.ReturnType
    keys: SessionKey.derive.ReturnType
    outbound: Nonce.encoder.ReturnType
    publicKeyConsumer: Hex.Hex
    publicKeyHost: Hex.Hex
    requestId: Rpc.Id | null
    returnUrl: string
    signature: Uint8Array
  }
  type State = { closed: boolean; session: Active | undefined; started: boolean }
  const state: State = { closed: false, session: undefined, started: false }

  function getIdentity(): Transport.Identity {
    if (!identity)
      throw new Transport.TransportError(
        'mobile-link host requires `Wata.create({ identity })` to sign the handshake',
      )
    return identity
  }

  async function close(cause?: Error): Promise<void> {
    if (state.closed) return
    state.closed = true
    state.session = undefined
    emitter.emit('close', cause)
  }

  async function handleUrl(linkUrl: string): Promise<void> {
    if (state.closed) return
    let url: URL
    try {
      url = new URL(linkUrl)
    } catch {
      return
    }
    if (Uri.requiredSearchParam(url, 'version') !== '1') return
    const message = Uri.requiredSearchParam(url, 'message')
    if (!message) return

    const pubkey = Uri.requiredSearchParam(url, 'pubkey')
    if (pubkey) {
      await handleHandshake(url, message, pubkey)
      return
    }
    handleSubsequent(message)
  }

  async function handleHandshake(url: URL, message: string, pubkey: string): Promise<void> {
    const returnUrl = Uri.requiredSearchParam(url, 'return_url')
    const id = Uri.requiredSearchParam(url, 'id')
    if (!returnUrl || !id) return

    const publicKeyConsumer = (() => {
      try {
        return Crypto.decodePublicKey(pubkey)
      } catch {
        return undefined
      }
    })()
    if (!publicKeyConsumer) return

    const request = (() => {
      try {
        return Envelope.parse(MobileLinkEnvelope.decodeJson(message))
      } catch {
        return undefined
      }
    })()
    if (!request || request.type !== 'rpc-requests') return

    // Verify the consumer's callback against its published allowlist (§4).
    try {
      const consumer = await Discovery.fetchConsumer(id, { fetch: fetchImpl })
      if (!consumer.callback_urls?.includes(returnUrl)) {
        await sendPreHandshakeError(returnUrl, request, 'callback is not registered by consumer')
        return
      }
    } catch (cause) {
      await sendPreHandshakeError(returnUrl, request, 'consumer discovery failed', cause as Error)
      return
    }

    const hostEph = Crypto.randomKeypair()
    const shared = SessionKey.shared({
      privateKey: hostEph.x25519.privateKey,
      publicKey: publicKeyConsumer,
    })
    const keys = MobileLinkEnvelope.deriveKeys({
      identityPublicKey: Crypto.decodePublicKey(getIdentity().publicKey),
      peerPublicKey: publicKeyConsumer,
      role: 'host',
      self: hostEph.x25519,
    })
    const signature = MobileLinkEnvelope.signIdentity({
      identity: getIdentity(),
      publicKeyConsumer,
      publicKeyHost: hostEph.x25519.publicKey,
      shared,
    })
    state.session = {
      handshakeSent: false,
      inbound: Nonce.decoder(),
      keys,
      outbound: Nonce.encoder(),
      publicKeyConsumer,
      publicKeyHost: hostEph.x25519.publicKey,
      requestId: firstRequestId(request),
      returnUrl,
      signature,
    }
    emitter.emit('message', request)
  }

  function handleSubsequent(message: string): void {
    const session = state.session
    if (!session) return
    const parsed = (() => {
      try {
        return Envelope.parse(MobileLinkEnvelope.decodeJson(message))
      } catch {
        return undefined
      }
    })()
    if (!parsed) return
    if (parsed.type !== 'encrypted') {
      void close(new Errors.ProtocolError('mobile-link session messages must be encrypted'))
      return
    }
    const frame = Envelope.toEncrypted(parsed)
    try {
      session.inbound.accept(frame.nonce)
      emitter.emit(
        'message',
        MobileLinkEnvelope.open({
          encrypted: parsed,
          key: session.keys.c2h,
          publicKeyConsumer: session.publicKeyConsumer,
        }),
      )
    } catch (cause) {
      emitter.emit('error', cause as Error)
      void close(cause as Error)
    }
  }

  async function sendPreHandshakeError(
    returnUrl: string,
    request: Envelope.Envelope,
    message: string,
    cause?: Error,
  ): Promise<void> {
    if (cause) emitter.emit('error', cause)
    const url = new URL(returnUrl)
    url.searchParams.set(
      'message',
      MobileLinkEnvelope.encodeJson(
        Envelope.rpcResponses([Rpc.error({ code: -32600, id: firstRequestId(request), message })]),
      ),
    )
    url.searchParams.set('version', '1')
    await open(url.toString())
  }

  return {
    bind(binding) {
      if (!identity && binding.identity) identity = binding.identity
    },
    capabilities: {
      notifications: { consumer: false, host: false },
      requests: { consumer: true, host: false },
    },
    close,
    discovery: {
      binding(baseUrl) {
        return {
          scheme,
          universal_link: universalLink ?? `${Uri.trimTrailingSlash(baseUrl)}${path}`,
        }
      },
      id: 'mobile-link',
    },
    exchange: 'ongoing',
    handleUrl,
    name: 'mobileLink',
    on: emitter.on,
    role: 'host',
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('mobile-link transport already closed')
      if (!state.started) throw new Transport.ClosedError('mobile-link transport not started')
      if (envelope.type !== 'rpc-responses')
        throw new Transport.UnsupportedError(
          `mobile-link host only sends rpc-responses envelopes; received \`${envelope.type}\``,
        )
      const session = state.session
      if (!session) throw new Transport.TransportError('no active mobile-link session to answer')
      const sealed = MobileLinkEnvelope.seal({
        envelope,
        from: 'host',
        key: session.keys.h2c,
        nonce: session.outbound.next(),
        publicKeyConsumer: session.publicKeyConsumer,
      })
      const url = new URL(session.returnUrl)
      url.searchParams.set('message', MobileLinkEnvelope.encodeJson(sealed))
      url.searchParams.set('version', '1')
      if (!session.handshakeSent) {
        url.searchParams.set(
          'identity_sig',
          Base64.fromBytes(session.signature, { pad: false, url: true }),
        )
        url.searchParams.set('pubkey', Crypto.encodePublicKey(session.publicKeyHost))
        session.handshakeSent = true
      }
      await open(url.toString())
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('mobile-link transport already closed')
      getIdentity()
      state.started = true
    },
  }
}

function firstRequestId(envelope: Envelope.Envelope): Rpc.Id | null {
  if (envelope.type !== 'rpc-requests') return null
  for (const message of envelope.payload) if ('id' in message) return message.id
  return null
}
