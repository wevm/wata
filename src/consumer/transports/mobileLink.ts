/**
 * Consumer-side `mobile-link` transport — direct, ongoing peer-to-peer
 * messaging with a host app via OS deep links / universal links.
 *
 * The consumer pins the host's long-term `identity_pubkey` from
 * `host.json` on `start()`, then fires the initial deep link (carrying
 * its ephemeral public key, origin `id`, sticky `return_url`, and the
 * first JSON-RPC request) at the host through the injected
 * {@link Options.openLink}. Inbound callback deep links are fed back in
 * via {@link MobileLink.handleUrl}: the first one carries the host's
 * `identity_sig` (verified against the pinned key) plus the encrypted
 * handshake response; subsequent ones carry ongoing encrypted frames.
 *
 * @example
 * ```ts
 * import { Wata, mobileLink } from 'wata'
 *
 * const session = await Wata.create({
 *   baseUrl: 'https://app.example',
 *   transports: [
 *     mobileLink({
 *       host: 'https://wallet.example',
 *       returnUrl: 'https://app.example/urpc/cb',
 *       openLink: (url) => Linking.openURL(url),
 *     }),
 *   ],
 * }).start()
 *
 * // Feed OS-routed callback deep links back into the transport.
 * Linking.addEventListener('url', ({ url }) => session.mobileLink.handleUrl(url))
 *
 * const { result } = await session.send({ method: 'wallet_connect', params: [] })
 * ```
 */

import { Base64, Hex } from 'ox'

import * as Aead from '../../core/Aead.js'
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
   * Override the discovery `fetch` implementation. Defaults to
   * `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch | undefined
  /**
   * Host discovery doc. Accepts a host origin string or a pre-parsed
   * {@link Discovery.HostDocument}. Optional: when the target host isn't
   * known at construction time, defer it to `start({ host })` (which a
   * supplied host wins over). `start` throws
   * {@link Transport.TransportError} when neither construction nor start
   * supplies a host.
   */
  host?: string | Discovery.HostDocument | undefined
  /**
   * Consumer origin identifier used for `consumer.json` callback
   * verification by the host. Constructor value wins over the wrapping
   * `Wata.create({ baseUrl })` binding.
   */
  id?: string | undefined
  /**
   * Open a deep link / universal link. Injected so React Native, Expo,
   * iOS, Android, and tests can supply their native link opener. Optional:
   * a transport built only to advertise discovery (e.g. a `consumer.json`
   * worker via `Wata.create({ baseUrl }).fetch`) never opens a link.
   * Required for `send`/`start`; those throw {@link Transport.TransportError}
   * when it's absent.
   */
  openLink?: ((url: string) => void | Promise<void>) | undefined
  /**
   * Sticky callback URI the host invokes to deliver messages back to
   * this consumer. Published in `consumer.json` `callback_urls` when
   * wrapped by `Wata.create({ baseUrl })`.
   */
  returnUrl: string
  /**
   * Target app to open: a bare scheme (`'examplewallet'` →
   * `examplewallet://request`) or a full universal/app link
   * (`'https://wallet.example/urpc'`). When omitted, the transport uses
   * the host's `mobile-link` discovery binding, preferring its
   * `universal_link`. Overridable per call via `start({ target })`.
   */
  target?: string | undefined
}

/**
 * Options for the mobile-link transport's {@link Transport.Transport.start | start},
 * derived from the deferrable subset of {@link Options} (`host`,
 * `target`) so their docs live in one place. Parameterized by the
 * construction {@link Options}: a per-session `host` is **required** here
 * only when it was not supplied at construction; once `mobileLink({ host })`
 * pins it, both fields are optional per-session overrides.
 */
export type StartOptions<options = Options> = Transport.StartOptions<
  options,
  Options,
  { optional: 'target'; required: 'host' }
>

/** Consumer-side mobile-link transport. */
export type MobileLink<options = Options> = Transport.Transport<
  'consumer',
  'mobileLink',
  { startOptions: StartOptions<options> }
> & {
  /** Feed an OS-routed inbound callback deep link into the transport. */
  handleUrl: (url: string) => void
}

/**
 * Create a consumer-side `mobile-link` transport. Its `start` additionally
 * accepts a {@link StartOptions} so the host and the deep-link target can
 * be supplied at start time — and requires `host` there when it was
 * omitted at construction. Overloaded so a construction-time `host` makes
 * the start-time `host` an optional override; omitting it makes the
 * start-time `host` mandatory.
 */
export function mobileLink(
  options: Options & { host: string | Discovery.HostDocument },
): MobileLink<{ host: string | Discovery.HostDocument }>
export function mobileLink(options: Options): MobileLink
export function mobileLink(options: Options): MobileLink {
  const {
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    host,
    openLink,
    returnUrl,
    target,
  } = options
  const open = (url: string) => {
    if (!openLink)
      throw new Transport.TransportError(
        'mobile-link consumer requires `openLink` to open the host app',
      )
    return openLink(url)
  }
  const returnUrl_resolved = assertCallback(returnUrl)
  const id_ctor = options.id ? assertConsumerId(options.id) : undefined
  let id_bound: string | undefined

  function getId(): string {
    if (id_ctor) return id_ctor
    if (id_bound) return id_bound
    throw new Transport.TransportError(
      'mobile-link consumer id could not be derived before `Wata.create({ baseUrl })` bound the transport',
    )
  }

  const emitter = Events.create<Transport.EventMap>()

  type Session_ = {
    c2h: Hex.Hex
    h2c: Hex.Hex
    inbound: Nonce.decoder.ReturnType
    publicKeyHost: Hex.Hex
  }
  type State = {
    closed: boolean
    identityPublicKey: Hex.Hex | undefined
    keypair: Crypto.Keypair | undefined
    outbound: Nonce.encoder.ReturnType
    requestId: Rpc.Id | null
    session: Session_ | undefined
    started: boolean
    target: string | undefined
  }
  const state: State = {
    closed: false,
    identityPublicKey: undefined,
    keypair: undefined,
    outbound: Nonce.encoder(),
    requestId: null,
    session: undefined,
    started: false,
    target: undefined,
  }

  function resolveTarget(hostDoc: Discovery.HostDocument, target: string | undefined): string {
    if (target) {
      if (target.includes('://')) return target
      return `${target}://request`
    }
    const binding = hostDoc.transports['mobile-link']
    if (!binding)
      throw new Transport.UnsupportedError(
        'host does not advertise a `mobile-link` transport binding',
      )
    if (binding.universal_link) return binding.universal_link
    return `${binding.scheme}://request`
  }

  function emitError(id: Rpc.Id | null, code: number, message: string, cause?: Error) {
    if (state.closed) return
    if (cause) emitter.emit('error', cause)
    emitter.emit('message', Envelope.rpcResponses([Rpc.error({ code, id, message })]))
    void close()
  }

  async function close(cause?: Error): Promise<void> {
    if (state.closed) return
    state.closed = true
    emitter.emit('close', cause)
  }

  function handleUrl(callbackUrl: string): void {
    if (state.closed) return
    const keypair = state.keypair
    const identityPublicKey = state.identityPublicKey
    if (!keypair || !identityPublicKey) {
      emitError(null, -32600, 'Unexpected mobile-link callback before handshake.')
      return
    }
    let url: URL
    try {
      url = new URL(callbackUrl)
    } catch (cause) {
      emitError(state.requestId, -32700, 'Malformed mobile-link callback.', cause as Error)
      return
    }
    if (Uri.requiredSearchParam(url, 'version') !== '1') {
      emitError(state.requestId, -32600, 'Unsupported mobile-link version.')
      return
    }
    const message = Uri.requiredSearchParam(url, 'message')
    if (!message) {
      emitError(state.requestId, -32600, 'Mobile-link callback missing `message`.')
      return
    }

    if (state.session) {
      handleSubsequent(message)
      return
    }
    handleHandshake(url, message, keypair, identityPublicKey)
  }

  function handleHandshake(
    url: URL,
    message: string,
    keypair: Crypto.Keypair,
    identityPublicKey: Hex.Hex,
  ): void {
    const parsed = (() => {
      try {
        return Envelope.parse(MobileLinkEnvelope.decodeJson(message))
      } catch (cause) {
        emitError(state.requestId, -32700, 'Malformed mobile-link callback.', cause as Error)
        return undefined
      }
    })()
    if (!parsed) return

    // Pre-handshake plaintext error (spec §7.1).
    if (parsed.type === 'rpc-responses') {
      emitter.emit('message', parsed)
      void close()
      return
    }
    if (parsed.type !== 'encrypted') {
      emitError(state.requestId, -32600, 'Mobile-link handshake message must be encrypted.')
      return
    }

    const pubkey = Uri.requiredSearchParam(url, 'pubkey')
    const identitySig = Uri.requiredSearchParam(url, 'identity_sig')
    if (!pubkey || !identitySig) {
      emitError(state.requestId, -32600, 'Mobile-link callback missing handshake fields.')
      return
    }

    const publicKeyHost = (() => {
      try {
        return Crypto.decodePublicKey(pubkey)
      } catch (cause) {
        emitError(state.requestId, -32600, 'Invalid mobile-link host public key.', cause as Error)
        return undefined
      }
    })()
    if (!publicKeyHost) return

    const signature = (() => {
      const bytes = Base64.toBytes(identitySig)
      if (bytes.length !== 64) return undefined
      return bytes
    })()
    if (!signature) {
      emitError(state.requestId, -32600, 'Invalid mobile-link identity signature.')
      return
    }

    const shared = (() => {
      try {
        return SessionKey.shared({
          privateKey: keypair.x25519.privateKey,
          publicKey: publicKeyHost,
        })
      } catch (cause) {
        emitError(state.requestId, -32600, 'Mobile-link key agreement failed.', cause as Error)
        return undefined
      }
    })()
    if (!shared) return

    const verified = MobileLinkEnvelope.verifyIdentity({
      identityPublicKey,
      publicKeyConsumer: keypair.x25519.publicKey,
      publicKeyHost,
      shared,
      signature,
    })
    if (!verified) {
      emitError(state.requestId, -32600, 'Mobile-link host identity signature did not verify.')
      return
    }

    const keys = MobileLinkEnvelope.deriveKeys({
      identityPublicKey,
      peerPublicKey: publicKeyHost,
      role: 'consumer',
      self: keypair.x25519,
    })
    const inbound = Nonce.decoder()
    const frame = Envelope.toEncrypted(parsed)
    try {
      inbound.accept(frame.nonce)
      const opened = MobileLinkEnvelope.open({
        encrypted: parsed,
        key: keys.h2c,
        publicKeyConsumer: keypair.x25519.publicKey,
      })
      state.session = { c2h: keys.c2h, h2c: keys.h2c, inbound, publicKeyHost }
      emitter.emit('message', opened)
    } catch (cause) {
      const code = cause instanceof Aead.OpenError ? -32603 : -32600
      emitError(state.requestId, code, 'Invalid mobile-link handshake response.', cause as Error)
    }
  }

  function handleSubsequent(message: string): void {
    const session = state.session!
    const keypair = state.keypair!
    const parsed = (() => {
      try {
        return Envelope.parse(MobileLinkEnvelope.decodeJson(message))
      } catch (cause) {
        emitError(state.requestId, -32700, 'Malformed mobile-link message.', cause as Error)
        return undefined
      }
    })()
    if (!parsed) return
    if (parsed.type !== 'encrypted') {
      emitError(state.requestId, -32600, 'Mobile-link session messages must be encrypted.')
      return
    }
    const frame = Envelope.toEncrypted(parsed)
    try {
      session.inbound.accept(frame.nonce)
      emitter.emit(
        'message',
        MobileLinkEnvelope.open({
          encrypted: parsed,
          key: session.h2c,
          publicKeyConsumer: keypair.x25519.publicKey,
        }),
      )
    } catch (cause) {
      const code = cause instanceof Aead.OpenError ? -32603 : -32600
      emitError(state.requestId, code, 'Invalid mobile-link message.', cause as Error)
    }
  }

  async function sendHandshake(
    envelope: Envelope.Envelope,
    keypair: Crypto.Keypair,
  ): Promise<void> {
    if (envelope.type !== 'rpc-requests')
      throw new Transport.UnsupportedError(
        `mobile-link transport only carries rpc-requests envelopes; received \`${envelope.type}\``,
      )
    state.requestId = firstRequestId(envelope)
    const url = new URL(state.target!)
    url.searchParams.set('id', getId())
    url.searchParams.set('message', MobileLinkEnvelope.encodeJson(envelope))
    url.searchParams.set('pubkey', Crypto.encodePublicKey(keypair.x25519.publicKey))
    url.searchParams.set('return_url', returnUrl_resolved)
    url.searchParams.set('version', '1')
    await open(url.toString())
  }

  async function sendSubsequent(envelope: Envelope.Envelope): Promise<void> {
    const session = state.session!
    const keypair = state.keypair!
    const sealed = MobileLinkEnvelope.seal({
      envelope,
      from: 'consumer',
      key: session.c2h,
      nonce: state.outbound.next(),
      publicKeyConsumer: keypair.x25519.publicKey,
    })
    const url = new URL(state.target!)
    url.searchParams.set('message', MobileLinkEnvelope.encodeJson(sealed))
    url.searchParams.set('version', '1')
    await open(url.toString())
  }

  return {
    bind(binding) {
      if (!id_bound && binding.baseUrl) id_bound = assertConsumerId(binding.baseUrl)
    },
    get callbackUrls() {
      return [returnUrl_resolved]
    },
    capabilities: {
      notifications: { consumer: false, host: false },
      requests: { consumer: true, host: false },
    },
    close,
    exchange: 'ongoing',
    handleUrl,
    name: 'mobileLink',
    on: emitter.on,
    role: 'consumer',
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('mobile-link transport already closed')
      if (!state.started) throw new Transport.ClosedError('mobile-link transport not started')
      const keypair = state.keypair!
      if (state.session) return await sendSubsequent(envelope)
      return await sendHandshake(envelope, keypair)
    },
    async start(options: Pick<Options, 'host' | 'target'> = {}) {
      if (state.closed) throw new Transport.ClosedError('mobile-link transport already closed')
      if (state.started) return
      const host_resolved = options.host ?? host
      if (!host_resolved)
        throw new Transport.TransportError(
          'mobile-link host must be supplied to `mobileLink({ host })` or `start({ host })`',
        )
      const hostDoc =
        typeof host_resolved === 'string'
          ? await Discovery.fetchHost(host_resolved, { fetch: fetchImpl })
          : host_resolved
      state.identityPublicKey = Crypto.decodePublicKey(hostDoc.identity_pubkey)
      state.target = resolveTarget(hostDoc, options.target ?? target)
      state.keypair = Crypto.randomKeypair()
      state.started = true
    },
  }
}

function assertCallback(value: string): string {
  const url = new URL(value)
  if (url.hash) throw new Errors.ProtocolError('mobile-link return_url must not contain a fragment')
  if (!Uri.isAllowedAppCallback(url))
    throw new Errors.ProtocolError(
      'mobile-link return_url must be HTTPS, loopback HTTP, or reverse-DNS private-use URI',
    )
  return url.toString()
}

function assertConsumerId(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !Uri.isLoopbackHttp(url))
    throw new Errors.ProtocolError('mobile-link id must be an HTTPS origin')
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Errors.ProtocolError('mobile-link id must not include path, query, or fragment')
  return url.origin
}

function firstRequestId(
  envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' }>,
): Rpc.Id | null {
  for (const message of envelope.payload) if ('id' in message) return message.id
  return null
}
