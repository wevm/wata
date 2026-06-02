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

import * as Aad from '../../core/Aad.js'
import * as Aead from '../../core/Aead.js'
import * as Crypto from '../../core/Crypto.js'
import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Nonce from '../../core/Nonce.js'
import * as Rpc from '../../core/Rpc.js'
import * as Session from '../../core/Session.js'
import * as Transport from '../../core/Transport.js'

/** Result returned by the platform browser-auth session. */
export type AuthSessionResult = string | URL | undefined

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
   */
  host: string | Discovery.HostDocument
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
   */
  openAuthSession: (
    options: openAuthSession.Options,
  ) => AuthSessionResult | Promise<AuthSessionResult>
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

/** Consumer-side mobile-web-auth transport. */
export type MobileWebAuth = Transport.Transport<'consumer', 'mobileWebAuth'>

/**
 * Create a consumer-side `mobile-web-auth` transport.
 */
export function mobileWebAuth(options: Options): MobileWebAuth {
  const {
    callback,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    host,
    openAuthSession,
  } = options
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

  async function resolveHost(): Promise<Discovery.HostDocument> {
    if (typeof host === 'string') return Discovery.fetchHost(host, { fetch: fetchImpl })
    return host
  }

  function resolveAuthUrl(hostDoc: Discovery.HostDocument): string {
    if (options.authUrl) return options.authUrl
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
    /** Origin of the host auth endpoint this state was launched against. */
    hostOrigin: string
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
      hostOrigin,
      keypair,
      requestId,
      state: stateValue,
    }
    const result = await openAuthSession({ authorizationUrl, callback: callbackUrl })
    if (result === undefined) {
      settle(cancelledEnvelope(requestId))
      return
    }
    await handleCallback(String(result))
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
    if (!matchesCallback(url, pending.callback)) {
      settle(errorEnvelope(pending.requestId, -32600, 'Mobile-web-auth callback URI mismatch.'))
      return
    }
    if (url.searchParams.get('version') !== '1') {
      settle(errorEnvelope(pending.requestId, -32600, 'Unsupported mobile-web-auth version.'))
      return
    }
    if (url.searchParams.get('state') !== pending.state) {
      settle(errorEnvelope(pending.requestId, -32600, 'Mobile-web-auth state mismatch.'))
      return
    }
    const pubkey = url.searchParams.get('pubkey')
    const message = url.searchParams.get('message')
    if (!pubkey || !message) {
      settle(errorEnvelope(pending.requestId, -32600, 'Mobile-web-auth callback missing fields.'))
      return
    }
    try {
      const publicKey_host = Hex.fromBytes(Base64.toBytes(pubkey)) as Hex.Hex
      const encrypted = Envelope.parse(decodeJson(message))
      if (encrypted.type !== 'encrypted')
        throw new Errors.ProtocolError('callback message must be encrypted')
      if (encrypted.payload.from !== 'host')
        throw new Errors.ProtocolError('callback message must be from host')
      const keys = Session.derive({
        peer: { publicKey: publicKey_host },
        role: 'consumer',
        self: pending.keypair.x25519,
        transportId: 'mobile-web-auth',
      })
      const frame = Envelope.toEncrypted(encrypted)
      if (Nonce.toCounter(frame.nonce) !== 1n)
        throw new Errors.ProtocolError('callback nonce must be 1')
      const plaintext = Aead.open({
        aad: Aad.encode({ publicKey: pending.keypair.x25519.publicKey, role: Aad.role.host }),
        ciphertext: frame.ciphertext,
        key: keys.h2c,
        nonce: frame.nonce,
      })
      const envelope = Envelope.parse(JSON.parse(Bytes.toString(Bytes.from(plaintext))))
      if (envelope.type !== 'rpc-responses')
        throw new Errors.ProtocolError('callback plaintext must be rpc-responses')
      settle(envelope)
    } catch (cause) {
      const code = cause instanceof Aead.OpenError ? -32603 : -32700
      settle(
        errorEnvelope(pending.requestId, code, 'Invalid mobile-web-auth callback.'),
        cause as Error,
      )
    }
  }

  return {
    bind(binding) {
      if (!id_bound && binding.baseUrl) id_bound = assertConsumerId(binding.baseUrl)
    },
    get callbackUrls() {
      return [callbackUrl]
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
      if (!state.started) state.started = true
      state.inFlight = true
      return await run(envelope).catch((cause) => {
        settle(undefined, cause as Error)
        throw cause
      })
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
      state.started = true
    },
  }
}

function assertCallback(value: string): string {
  const url = new URL(value)
  if (url.hash)
    throw new Errors.ProtocolError('mobile-web-auth callback must not contain a fragment')
  if (!isAllowedCallback(url))
    throw new Errors.ProtocolError(
      'mobile-web-auth callback must be HTTPS, loopback HTTP, or reverse-DNS private-use URI',
    )
  return url.toString()
}

function assertConsumerId(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !isLoopbackHttp(url))
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
  url.searchParams.set('message', encodeJson(options.envelope))
  url.searchParams.set(
    'pubkey',
    Base64.fromBytes(Bytes.from(options.publicKey), { pad: false, url: true }),
  )
  url.searchParams.set('state', options.state)
  url.searchParams.set('version', '1')
  return url.toString()
}

function cancelledEnvelope(id: Rpc.Id | null): Envelope.Envelope {
  return errorEnvelope(id, -32600, 'User cancelled the mobile-web-auth session.')
}

function decodeJson(value: string): unknown {
  return JSON.parse(Bytes.toString(Base64.toBytes(value)))
}

function encodeJson(value: unknown): string {
  return Base64.fromBytes(Bytes.fromString(JSON.stringify(value)), { pad: false, url: true })
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

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  )
}

function isAllowedCallback(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (isLoopbackHttp(url)) return true
  if (url.protocol === 'http:') return false
  const scheme = url.protocol.slice(0, -1)
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && scheme.includes('.')
}

function matchesCallback(url: URL, callback: string): boolean {
  const expected = new URL(callback)
  const actualBase =
    url.origin === 'null' ? `${url.protocol}${url.pathname}` : `${url.origin}${url.pathname}`
  const expectedBase =
    expected.origin === 'null'
      ? `${expected.protocol}${expected.pathname}`
      : `${expected.origin}${expected.pathname}`
  if (actualBase !== expectedBase) return false
  for (const [key, value] of expected.searchParams)
    if (!url.searchParams.getAll(key).includes(value)) return false
  return true
}
