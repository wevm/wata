/**
 * Consumer-side `mobile-web-auth` transport — system-browser auth
 * session, single-exchange.
 *
 * The transport opens the host's authorization URL in a platform
 * browser-auth session, waits for the callback URI, decrypts the single
 * `rpc-responses` envelope delivered in that callback, emits it, and
 * closes. The platform integration is injected through
 * {@link Options.openAuthSession} so React Native, Expo, iOS, Android,
 * and tests can supply their native auth-session primitive.
 */

import { Base64, Bytes, Hex } from 'ox'

import * as Aead from '../../core/Aead.js'
import * as Crypto from '../../core/Crypto.js'
import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Rpc from '../../core/Rpc.js'
import * as Transport from '../../core/Transport.js'
import * as MobileWebAuthEnvelope from '../../internal/MobileWebAuthEnvelope.js'
import * as Uri from '../../internal/Uri.js'

/** Result returned by the platform browser-auth session. */
export type AuthSessionResult = string | undefined

/** Options accepted by {@link mobileWebAuth}. */
export type Options = {
  /**
   * Host authorization endpoint override. When omitted, the transport
   * resolves the host's `mobile-web-auth` discovery binding.
   */
  authUrl?: string | undefined
  /**
   * Callback URI registered to the mobile app. This exact URI is
   * published in `consumer.json` when wrapped by `Wata.create({ meta,
   * baseUrl })` and is sent to the host in the authorization request.
   */
  callback: string
  /**
   * Override the discovery `fetch` implementation. Defaults to
   * `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch | undefined
  /**
   * Host discovery doc. Accepts a host origin string or a pre-parsed
   * {@link Discovery.HostDocument}.
   *
   * Omit it to supply the host at start time instead via
   * `wata.mobileWebAuth.start({ host })`, so a single hoisted
   * `Wata.create({ transports: [mobileWebAuth()] })` can be pointed at a
   * host chosen out of band. `start` throws {@link Transport.TransportError}
   * when neither construction nor start supplies a host.
   */
  host?: string | Discovery.HostDocument | undefined
  /**
   * Consumer origin identifier used for `consumer.json` callback
   * verification. Constructor value wins over the wrapping
   * `Wata.create({ baseUrl })` binding.
   */
  id?: string | undefined
  /**
   * Open `authorizationUrl` in a system-browser auth session and
   * resolve with the delivered callback URL. Resolve `undefined` when
   * the user dismisses the session without a callback.
   *
   * Omit it to supply the platform primitive at start time instead via
   * `wata.mobileWebAuth.start({ openAuthSession })`, so a single hoisted
   * `Wata.create({ transports: [mobileWebAuth()] })` can be shared
   * between a discovery server (which only serves `consumer.json` and
   * never starts a session) and the app (which injects its native
   * auth-session primitive at start). `start`/`send` throw
   * {@link Transport.TransportError} when neither construction nor start
   * supplies it.
   */
  openAuthSession?:
    | ((options: openAuthSession.Options) => AuthSessionResult | Promise<AuthSessionResult>)
    | undefined
}

export declare namespace openAuthSession {
  /** Argument passed to {@link Options.openAuthSession}. */
  type Options = {
    /** Authorization URL to open in the system browser auth session. */
    authorizationUrl: string
    /** Callback URI the platform auth session should watch for. */
    callback: string
  }
}

/**
 * Options for the mobile-web-auth transport's
 * {@link Transport.Transport.start | start}, derived from the deferrable
 * subset of {@link Options} so their docs live in one place.
 * Parameterized by the construction {@link Options}: a per-session
 * `host` is **required** here only when it was not supplied at
 * construction (`mobileWebAuth()`); once `mobileWebAuth({ host })` pins
 * it, `host` joins `authUrl` and `openAuthSession` as optional
 * per-session overrides.
 */
export type StartOptions<options = Options> = Transport.StartOptions<
  options,
  Options,
  { optional: 'authUrl' | 'openAuthSession'; required: 'host' }
>

/** Consumer-side mobile-web-auth transport. */
export type MobileWebAuth<options = Options> = Transport.Transport<
  'consumer',
  'mobileWebAuth',
  { startOptions: StartOptions<options> }
>

/**
 * Create a consumer-side `mobile-web-auth` transport.
 */
export function mobileWebAuth<options extends Options>(
  options: options = {} as options,
): MobileWebAuth<options> {
  const { callback, fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = options

  // Per-session start-time overrides, captured when `start()` runs and
  // read by the `send()`-driven auth exchange. Start values win over
  // construction.
  let start_options: Pick<Options, 'authUrl' | 'host' | 'openAuthSession'> = {}
  const callbackUrl = assertCallback(callback)
  const id_ctor = options.id ? assertConsumerId(options.id) : undefined
  let id_bound: string | undefined

  function getId(): string {
    if (id_ctor) return id_ctor
    if (id_bound) return id_bound
    throw new Transport.TransportError(
      'mobile-web-auth consumer id could not be derived before `Wata.create({ baseUrl })` bound the transport',
    )
  }

  /** Host input (url or pre-parsed doc) from start ?? construction. */
  function resolveHostInput(): string | Discovery.HostDocument {
    const host = start_options.host ?? options.host
    if (!host)
      throw new Transport.TransportError(
        'mobile-web-auth host must be supplied to `mobileWebAuth({ host })` or `start({ host })`',
      )
    return host
  }

  /** Host `auth_url` override from start ?? construction. */
  function authUrlOverride(): string | undefined {
    return start_options.authUrl ?? options.authUrl
  }

  /** Platform auth-session opener from start ?? construction. */
  function resolveOpenAuthSession(): NonNullable<Options['openAuthSession']> {
    const openAuthSession = start_options.openAuthSession ?? options.openAuthSession
    if (!openAuthSession)
      throw new Transport.TransportError(
        'mobile-web-auth `openAuthSession` must be supplied to `mobileWebAuth({ openAuthSession })` or `start({ openAuthSession })`',
      )
    return openAuthSession
  }

  async function resolveHost(): Promise<Discovery.HostDocument> {
    const host = resolveHostInput()
    if (typeof host === 'string') return Discovery.fetchHost(host, { fetch: fetchImpl })
    return host
  }

  function resolveAuthUrl(hostDoc: Discovery.HostDocument): string {
    const override = authUrlOverride()
    if (override) return override
    const binding = hostDoc.transports['mobile-web-auth']
    if (!binding)
      throw new Transport.UnsupportedError(
        'host does not advertise a `mobile-web-auth` transport binding',
      )
    return binding.auth_url
  }

  const emitter = Events.create<Transport.EventMap>()
  type Pending = {
    callback: string
    keypair: Crypto.Keypair
    requestId: Rpc.Id | null
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

  function settle(message: Envelope.Envelope | undefined, cause?: Error) {
    if (state.closed) return
    state.closed = true
    state.inFlight = false
    state.pending = undefined
    if (cause) emitter.emit('error', cause)
    if (message) emitter.emit('message', message)
    emitter.emit('close', cause)
  }

  async function run(envelope: Envelope.Envelope): Promise<void> {
    if (envelope.type !== 'rpc-requests')
      throw new Transport.UnsupportedError(
        `mobile-web-auth transport only carries rpc-requests envelopes; received \`${envelope.type}\``,
      )
    const hostDoc = await resolveHost()
    const authUrl = new URL(resolveAuthUrl(hostDoc))
    const hostOrigin = new URL(hostDoc.origin).origin
    if (authUrl.origin !== hostOrigin)
      throw new Errors.ProtocolError('mobile-web-auth auth_url origin does not match host origin')

    const keypair = Crypto.randomKeypair()
    const stateValue = generateState()
    const requestId = firstRequestId(envelope)
    const authorizationUrl = buildAuthorizationUrl({
      authUrl: authUrl.toString(),
      callback: callbackUrl,
      envelope,
      id: getId(),
      publicKey: keypair.x25519.publicKey,
      state: stateValue,
    })
    state.pending = {
      callback: callbackUrl,
      keypair,
      requestId,
      state: stateValue,
    }
    const result = await resolveOpenAuthSession()({ authorizationUrl, callback: callbackUrl })
    if (result === undefined) {
      settle(cancelledEnvelope(requestId))
      return
    }
    await handleCallback(result)
  }

  async function handleCallback(callbackResult: string): Promise<void> {
    const pending = state.pending
    if (!pending) {
      settle(errorEnvelope(null, -32600, 'Unknown mobile-web-auth callback state.'))
      return
    }
    let url: URL
    try {
      url = new URL(callbackResult)
    } catch (cause) {
      settle(
        errorEnvelope(pending.requestId, -32700, 'Malformed mobile-web-auth callback.'),
        cause as Error,
      )
      return
    }
    if (!Uri.matchesCallback(url, pending.callback)) {
      settle(errorEnvelope(pending.requestId, -32600, 'Mobile-web-auth callback URI mismatch.'))
      return
    }
    if (Uri.requiredSearchParam(url, 'version') !== '1') {
      settle(errorEnvelope(pending.requestId, -32600, 'Unsupported mobile-web-auth version.'))
      return
    }
    if (Uri.requiredSearchParam(url, 'state') !== pending.state) {
      settle(errorEnvelope(pending.requestId, -32600, 'Mobile-web-auth state mismatch.'))
      return
    }
    const pubkey = Uri.requiredSearchParam(url, 'pubkey')
    const message = Uri.requiredSearchParam(url, 'message')
    if (!pubkey || !message) {
      settle(errorEnvelope(pending.requestId, -32600, 'Mobile-web-auth callback missing fields.'))
      return
    }
    try {
      settle(
        MobileWebAuthEnvelope.openResponse({
          message,
          publicKey: Crypto.decodePublicKey(pubkey),
          self: pending.keypair.x25519,
        }),
      )
    } catch (cause) {
      const code = cause instanceof Aead.OpenError ? -32603 : -32700
      settle(
        errorEnvelope(pending.requestId, code, 'Invalid mobile-web-auth callback.'),
        cause as Error,
      )
    }
  }

  async function start(
    options: Pick<Options, 'authUrl' | 'host' | 'openAuthSession'> = {},
  ): Promise<void> {
    if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
    start_options = options
    // Fail fast: surface a missing host or auth-session opener at `start()`
    // rather than waiting for the first `send()` to open the auth session.
    resolveHostInput()
    resolveOpenAuthSession()
    state.started = true
  }

  return {
    bind(binding) {
      if (!id_bound && binding.baseUrl) id_bound = assertConsumerId(binding.baseUrl)
    },
    get callbackUrls() {
      return [callbackUrl]
    },
    capabilities: {
      notifications: { consumer: false, host: false },
      requests: { consumer: true, host: false },
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
      state.inFlight = false
      state.pending = undefined
      emitter.emit('close', cause)
    },
    exchange: 'single_exchange',
    name: 'mobileWebAuth',
    on: emitter.on,
    role: 'consumer',
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
      if (state.inFlight)
        throw new Transport.TransportError(
          'mobile-web-auth is single-exchange; a previous send is still in flight',
        )
      if (!state.started) await start()
      state.inFlight = true
      return await run(envelope).catch((cause) => {
        settle(undefined, cause as Error)
        throw cause
      })
    },
    start,
  }
}

function assertCallback(value: string): string {
  const url = new URL(value)
  if (url.hash)
    throw new Errors.ProtocolError('mobile-web-auth callback must not contain a fragment')
  if (!Uri.isAllowedAppCallback(url))
    throw new Errors.ProtocolError(
      'mobile-web-auth callback must be HTTPS, loopback HTTP, or reverse-DNS private-use URI',
    )
  return url.toString()
}

function assertConsumerId(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !Uri.isLoopbackHttp(url))
    throw new Errors.ProtocolError('mobile-web-auth id must be an HTTPS origin')
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Errors.ProtocolError('mobile-web-auth id must not include path, query, or fragment')
  return url.origin
}

function buildAuthorizationUrl(options: {
  authUrl: string
  callback: string
  envelope: Envelope.Envelope
  id: string
  publicKey: Hex.Hex
  state: string
}): string {
  const url = new URL(options.authUrl)
  url.searchParams.set('callback', options.callback)
  url.searchParams.set('id', options.id)
  url.searchParams.set('message', MobileWebAuthEnvelope.encodeJson(options.envelope))
  url.searchParams.set('pubkey', Crypto.encodePublicKey(options.publicKey))
  url.searchParams.set('state', options.state)
  url.searchParams.set('version', '1')
  return url.toString()
}

function cancelledEnvelope(id: Rpc.Id | null): Envelope.Envelope {
  return errorEnvelope(id, -32600, 'User cancelled the mobile-web-auth session.')
}

function errorEnvelope(id: Rpc.Id | null, code: number, message: string): Envelope.Envelope {
  return Envelope.rpcResponses([Rpc.error({ code, id, message })])
}

function firstRequestId(
  envelope: Extract<Envelope.Envelope, { type: 'rpc-requests' }>,
): Rpc.Id | null {
  for (const message of envelope.payload) if ('id' in message) return message.id
  return null
}

function generateState(): string {
  return Base64.fromBytes(Bytes.random(32), { pad: false, url: true })
}
