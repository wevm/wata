/**
 * Host-side `mobileLink` transport.
 *
 * The host receives bootstrap and encrypted message frames through a
 * universal-link HTTP route or a native app's URL listener. It signs its
 * readiness key share with the host identity injected by `Wata.create`,
 * then emits plaintext envelopes to `Wata` while the URL wire stays AEAD
 * encrypted.
 */

import { Hono } from 'hono'
import { Base64 } from 'ox'

import * as Crypto from '../../core/Crypto.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Http from '../../core/Http.js'
import * as MobileLink from '../../core/internal/mobileLink.js'
import * as SecureChannel from '../../core/internal/secureChannel.js'
import * as Session from '../../core/Session.js'
import * as Transport from '../../core/Transport.js'

/** Options accepted by {@link mobileLink}. */
export type Options = {
  /** Open a deep link / universal link for native/custom-scheme deployments. */
  open?: ((url: string) => unknown) | undefined
  /** Universal-link callback path handled by `.fetch`. Defaults to `/auth/mobile-link`. */
  path?: string | undefined
  /** How long HTTP `.fetch` waits for a response frame before returning 204. */
  responseTimeout?: number | undefined
  /** Custom URL scheme registered by the host app. */
  scheme: string
  /** Public universal-link URL. Defaults to `Wata.create({ baseUrl })` + `path`. */
  universalLink?: string | undefined
}

/** Host-side mobile-link transport plus URL handler and HTTP handlers. */
export type MobileLinkTransport = Transport.Transport<'host', 'mobileLink'> &
  Http.Server & {
    /** Handle an inbound URL opened by the consumer. */
    handle: (url: string | URL) => Promise<void>
  }

type HostSession = {
  callbackUrl: string
  channel: SecureChannel.Channel
  session: string
}

type State = {
  activeSession: string | undefined
  closed: boolean
  identity: Transport.Identity | undefined
  started: boolean
}

/** Create a host-side `mobileLink` transport. */
export function mobileLink(options: Options): MobileLinkTransport {
  const emitter = Events.create<Transport.EventMap>()
  const path = normalizePath(options.path ?? '/auth/mobile-link')
  const responseTimeout = Math.max(0, options.responseTimeout ?? 10_000)
  const sessions = new Map<string, HostSession>()
  const state: State = {
    activeSession: undefined,
    closed: false,
    identity: undefined,
    started: false,
  }
  const waiters = new Map<string, (url: string | undefined) => void>()

  const app = new Hono()
  app.get(path, async (c) => {
    try {
      const url = await handleFrame(MobileLink.read(c.req.url), { wait: true })
      if (url) return c.redirect(url, 302)
      return new Response(null, { status: 204 })
    } catch (cause) {
      return new Response((cause as Error).message, { status: 400 })
    }
  })
  const { fetch, listener } = Http.fromHono(app)

  async function deliver(session: string, url: string): Promise<void> {
    const waiter = waiters.get(session)
    if (waiter) {
      waiters.delete(session)
      waiter(url)
      return
    }
    const open = options.open ?? defaultOpen
    if (!open)
      throw new Transport.TransportError(
        '`open` is required when no HTTP redirect is waiting for the response',
      )
    await Promise.resolve(open(url))
  }

  async function handle(url: string | URL): Promise<void> {
    await handleFrame(MobileLink.read(url), { wait: false })
  }

  async function handleBootstrap(frame: MobileLink.BootstrapFrame): Promise<string> {
    const identity = state.identity
    if (!identity)
      throw new Errors.BaseError('`privateKey` is required to accept mobileLink bootstrap frames', {
        details: 'host readiness frames are signed with the host long-term Ed25519 identity',
      })

    const keypair = Crypto.randomKeypair()
    const publicKey_host = MobileLink.publicKeyToString(keypair.x25519.publicKey)
    const session = Session.derive({
      peer: { publicKey: MobileLink.publicKeyToHex(frame.pubkey_consumer) },
      role: 'host',
      self: keypair.x25519,
      transportContext: Base64.toBytes(identity.publicKey),
      transportId: 'mobile-link',
    })
    sessions.set(frame.session, {
      callbackUrl: frame.callback_url,
      channel: SecureChannel.create({
        keys: session,
        publicKey: MobileLink.publicKeyToHex(frame.pubkey_consumer),
        role: 'host',
      }),
      session: frame.session,
    })
    state.activeSession = frame.session
    return MobileLink.append(frame.callback_url, {
      identity_sig: MobileLink.signIdentity({
        privateKey: identity.privateKey,
        publicKey_consumer: frame.pubkey_consumer,
        publicKey_host,
        session: frame.session,
      }),
      pubkey_host: publicKey_host,
      session: frame.session,
      type: 'ready',
    })
  }

  async function handleFrame(
    frame: MobileLink.Frame,
    options_handle: { wait: boolean },
  ): Promise<string | undefined> {
    if (!state.started) await start()
    if (frame.type === 'bootstrap') {
      const url = await handleBootstrap(frame)
      if (options_handle.wait) return url
      await deliver(frame.session, url)
      return undefined
    }
    if (frame.type === 'message') return await handleMessage(frame, options_handle)
    throw new Errors.ProtocolError('host received unexpected mobileLink ready frame')
  }

  async function handleMessage(
    frame: Extract<MobileLink.Frame, { type: 'message' }>,
    options_handle: { wait: boolean },
  ): Promise<string | undefined> {
    const session = sessions.get(frame.session)
    if (!session) throw new Transport.ClosedError('unknown mobileLink session')
    state.activeSession = frame.session
    const response = options_handle.wait ? waitForResponse(frame.session) : undefined
    emitter.emit('message', session.channel.open(frame.message))
    return response ? await response : undefined
  }

  async function start(): Promise<void> {
    if (state.closed) throw new Transport.ClosedError('mobileLink transport already closed')
    state.started = true
  }

  function waitForResponse(session: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        waiters.delete(session)
        resolve(undefined)
      }, responseTimeout)
      waiters.set(session, (url) => {
        clearTimeout(timeout)
        resolve(url)
      })
    })
  }

  return {
    bind(binding) {
      state.identity = binding.identity
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
      sessions.clear()
      for (const waiter of waiters.values()) waiter(undefined)
      waiters.clear()
      emitter.emit('close', cause)
    },
    discovery: {
      binding: (baseUrl: string) => ({
        scheme: options.scheme,
        universal_link: options.universalLink ?? new URL(path, baseUrl).toString(),
      }),
      id: 'mobile-link',
    },
    exchange: 'ongoing',
    fetch,
    handle,
    listener,
    name: 'mobileLink',
    on: emitter.on,
    role: 'host',
    routes: [path],
    async send(envelope: Envelope.Envelope) {
      if (state.closed) throw new Transport.ClosedError('mobileLink transport already closed')
      const sessionId = state.activeSession
      const session = sessionId ? sessions.get(sessionId) : undefined
      if (!session) throw new Transport.ClosedError('mobileLink transport has no active session')
      await deliver(
        session.session,
        MobileLink.append(session.callbackUrl, {
          message: session.channel.seal(envelope),
          session: session.session,
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

function normalizePath(path: string): string {
  if (!path.startsWith('/')) throw new Errors.BaseError('`path` must start with /')
  if (path === '/') return path
  return path.replace(/\/+$/, '')
}
