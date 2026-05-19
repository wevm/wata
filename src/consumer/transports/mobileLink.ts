/**
 * Consumer-side `mobileLink` transport.
 *
 * The consumer opens a host deep link / universal link carrying a
 * bootstrap frame, verifies the host's signed readiness key share,
 * and then carries encrypted envelopes back and forth through future
 * links. The transport emits plaintext envelopes to `Wata`; the URL
 * wire stays encrypted after bootstrap.
 */

import { Base64 } from 'ox'

import * as Crypto from '../../core/Crypto.js'
import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as MobileLink from '../../core/internal/MobileLink.js'
import * as SecureChannel from '../../core/internal/secureChannel.js'
import * as Session from '../../core/Session.js'
import * as Transport from '../../core/Transport.js'

/** Options accepted by {@link mobileLink}. */
export type Options = Options.DiscoveryMode | Options.Pinned

export declare namespace Options {
  /** Discovery-backed mobile-link options. */
  type DiscoveryMode = {
    /** Consumer callback URL the host opens with `ready` and response frames. */
    callbackUrl: string
    /** Optional fetch override for host discovery. */
    fetch?: typeof globalThis.fetch | undefined
    /** Host origin or pre-parsed host discovery document. */
    host: string | Discovery.HostDocument
    /** Open a deep link / universal link. Defaults to `globalThis.location.assign` when available. */
    open?: ((url: string) => unknown) | undefined
  }

  /** Pinned host identity options. */
  type Pinned = {
    /** Consumer callback URL the host opens with `ready` and response frames. */
    callbackUrl: string
    /** Pinned host identity and link target. */
    identity: {
      /** Host deep-link or universal-link URL to open. */
      deepLinkUrl: string
      /** Host long-term Ed25519 public key, unpadded base64url encoded. */
      publicKey: string
    }
    /** Open a deep link / universal link. Defaults to `globalThis.location.assign` when available. */
    open?: ((url: string) => unknown) | undefined
  }
}

/** Consumer-side mobile-link transport plus URL callback handler. */
export type MobileLinkTransport = Transport.Transport<'consumer', 'mobileLink'> & {
  /** Handle an inbound callback URL opened by the host app. */
  handle: (url: string | URL) => Promise<void>
}

type ResolvedHost = {
  deepLinkUrl: string
  publicKey: string
}

type State = {
  channel: SecureChannel.Channel | undefined
  closed: boolean
  deepLinkUrl: string | undefined
  keypair: Crypto.Keypair | undefined
  publicKey_consumer: string | undefined
  publicKey_hostIdentity: string | undefined
  ready: boolean
  readyReject: ((error: Error) => void) | undefined
  readyResolve: (() => void) | undefined
  session: string | undefined
  started: boolean
}

/** Create a consumer-side `mobileLink` transport. */
export function mobileLink(options: Options): MobileLinkTransport {
  const emitter = Events.create<Transport.EventMap>()
  const fetchImpl =
    'fetch' in options && options.fetch ? options.fetch : globalThis.fetch.bind(globalThis)
  const state: State = {
    channel: undefined,
    closed: false,
    deepLinkUrl: undefined,
    keypair: undefined,
    publicKey_consumer: undefined,
    publicKey_hostIdentity: undefined,
    ready: false,
    readyReject: undefined,
    readyResolve: undefined,
    session: undefined,
    started: false,
  }
  let startPromise: Promise<void> | undefined

  async function resolveHost(): Promise<ResolvedHost> {
    if ('identity' in options)
      return {
        deepLinkUrl: options.identity.deepLinkUrl,
        publicKey: options.identity.publicKey,
      }

    const document =
      typeof options.host === 'string'
        ? await Discovery.fetchHost(options.host, { fetch: fetchImpl })
        : options.host
    const binding = document.transports['mobile-link']
    if (!binding)
      throw new Transport.UnsupportedError(
        'host does not advertise a `mobile-link` transport binding',
      )
    return {
      deepLinkUrl: binding.universal_link,
      publicKey: document.identity_pubkey,
    }
  }

  async function open(url: string): Promise<void> {
    const open = options.open ?? defaultOpen
    if (!open)
      throw new Transport.TransportError(
        '`open` is required when no browser `location.assign` is available',
      )
    await Promise.resolve(open(url))
  }

  async function start(): Promise<void> {
    if (state.closed) throw new Transport.ClosedError('mobileLink transport already closed')
    if (state.ready) return
    if (startPromise) return startPromise
    startPromise = (async () => {
      try {
        const host = await resolveHost()
        const keypair = Crypto.randomKeypair()
        const publicKey_consumer = MobileLink.publicKeyToString(keypair.x25519.publicKey)
        const session = MobileLink.randomSession()
        state.deepLinkUrl = host.deepLinkUrl
        state.keypair = keypair
        state.publicKey_consumer = publicKey_consumer
        state.publicKey_hostIdentity = host.publicKey
        state.session = session
        state.started = true

        const ready = new Promise<void>((resolve, reject) => {
          state.readyReject = reject
          state.readyResolve = resolve
        })
        try {
          await open(
            MobileLink.append(host.deepLinkUrl, {
              callback_url: options.callbackUrl,
              pubkey_consumer: publicKey_consumer,
              session,
              type: 'bootstrap',
            }),
          )
        } catch (cause) {
          ready.catch(() => undefined)
          state.readyReject = undefined
          state.readyResolve = undefined
          throw cause
        }
        await ready
      } finally {
        startPromise = undefined
      }
    })()
    return startPromise
  }

  async function handle(url: string | URL): Promise<void> {
    try {
      const frame = MobileLink.read(url)
      if (frame.type === 'ready') {
        handleReady(frame)
        return
      }
      if (frame.type === 'message') {
        handleMessage(frame)
        return
      }
      throw new Errors.ProtocolError('consumer received unexpected mobileLink bootstrap frame')
    } catch (cause) {
      const error = cause as Error
      state.readyReject?.(error)
      emitter.emit('error', error)
      throw error
    }
  }

  function handleMessage(frame: Extract<MobileLink.Frame, { type: 'message' }>): void {
    if (!state.channel) throw new Transport.ClosedError('mobileLink transport is not ready')
    assertSession(frame.session)
    emitter.emit('message', state.channel.open(frame.message))
  }

  function handleReady(frame: MobileLink.ReadyFrame): void {
    assertSession(frame.session)
    const keypair = state.keypair
    const publicKey_consumer = state.publicKey_consumer
    const publicKey_hostIdentity = state.publicKey_hostIdentity
    if (!keypair || !publicKey_consumer || !publicKey_hostIdentity)
      throw new Transport.ClosedError('mobileLink transport is not started')

    const publicKey_identity = MobileLink.publicKeyToHex(publicKey_hostIdentity)
    if (
      !MobileLink.verifyIdentity({
        publicKey_consumer,
        publicKey_host: frame.pubkey_host,
        publicKey_identity,
        session: frame.session,
        signature: frame.identity_sig,
      })
    )
      throw new Errors.ProtocolError('invalid mobileLink identity signature')

    state.channel = SecureChannel.create({
      keys: Session.derive({
        peer: { publicKey: MobileLink.publicKeyToHex(frame.pubkey_host) },
        role: 'consumer',
        self: keypair.x25519,
        transportContext: Base64.toBytes(publicKey_hostIdentity),
        transportId: 'mobile-link',
      }),
      publicKey: keypair.x25519.publicKey,
      role: 'consumer',
    })
    state.ready = true
    state.readyResolve?.()
    state.readyReject = undefined
    state.readyResolve = undefined
  }

  function assertSession(session: string): void {
    if (state.session !== session)
      throw new Errors.ProtocolError('mobileLink session mismatch', {
        details: `expected ${state.session ?? '<none>'}, received ${session}`,
      })
  }

  return {
    async close(cause) {
      if (state.closed) return
      state.channel = undefined
      state.closed = true
      state.ready = false
      state.readyReject?.(cause ?? new Transport.ClosedError('mobileLink transport closed'))
      emitter.emit('close', cause)
    },
    exchange: 'ongoing',
    handle,
    name: 'mobileLink',
    on: emitter.on,
    role: 'consumer',
    async send(envelope: Envelope.Envelope) {
      if (state.closed) throw new Transport.ClosedError('mobileLink transport already closed')
      if (!state.ready) await start()
      if (!state.channel || !state.deepLinkUrl || !state.session)
        throw new Transport.ClosedError('mobileLink transport is not ready')
      await open(
        MobileLink.append(state.deepLinkUrl, {
          message: state.channel.seal(envelope),
          session: state.session,
          type: 'message',
        }),
      )
    },
    start,
  }
}

function defaultOpen(url: string): void {
  const location = (globalThis as { location?: { assign?: (url: string) => void } }).location
  if (!location?.assign) throw new Transport.TransportError('no default URL opener is available')
  location.assign(url)
}
