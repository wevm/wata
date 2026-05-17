/**
 * Consumer-side `webhook-callback` transport — HTTP-server-shaped,
 * single-exchange.
 *
 * Implements the consumer half of the uRPC `webhook-callback` spec.
 * `transport.send(envelope)`:
 *
 * 1. RFC 9421-signs `POST <registerUrl>` with the consumer's
 *    long-term Ed25519 identity key, carrying the queued
 *    `rpc-requests` envelope and the consumer's `webhook_url`.
 * 2. Returns immediately once the host accepts (`200 OK`, with
 *    `auth_req_id` / `verification_uri`); the user is fanned out
 *    to the verification URI through the consumer's out-of-band
 *    channel.
 * 3. The transport's `.fetch` / `.listener` handle the incoming
 *    `POST <baseUrl><path>` from the host: verify RFC 9421 signature
 *    against the host's pinned `identity_pubkey`, verify the
 *    `Content-Digest`, enforce per-`auth_req_id` nonce replay
 *    protection, then emit the `rpc-responses` envelope as
 *    `'message'` so the wrapping `Wata` resolves the pending
 *    `send()`.
 * 4. Auto-closes on terminal response (single-exchange).
 *
 * Optional cancellation: {@link Cancel} is exposed on the returned
 * transport for callers who need to abort an in-flight intent. Sends
 * an RFC 9421-signed `DELETE <registerUrl>/<auth_req_id>`.
 *
 * @example
 * ```ts
 * import { Wata, Kv, webhookCallback } from 'wata'
 *
 * const transport = webhookCallback({
 *   host: 'https://wallet.example',
 *   path: '/cb',
 *   store: Kv.memory(),
 * })
 *
 * const wata = Wata.create({ baseUrl: 'https://acme.dev', meta, privateKey, transport })
 * const { result } = await wata.send({ method: 'wallet_connect', params: [] })
 * ```
 */

import { Hono } from 'hono'
import { Base64, Bytes, Hex } from 'ox'

import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Fetch from '../../core/Fetch.js'
import * as Http from '../../core/Http.js'
import * as Kv from '../../core/Kv.js'
import * as MessageSig from '../../core/MessageSig.js'
import * as Transport from '../../core/Transport.js'
import * as Uri from '../../internal/Uri.js'

/** Information surfaced to {@link Options.onPrompt} once `/register` succeeds. */
export type Prompt = {
  /** Opaque host-issued correlation id for the pending intent. */
  authReqId: string
  /** Approval-window lifetime (seconds) advertised by the host. */
  expiresIn: number | undefined
  /** Retry-budget hint (seconds) advertised by the host, if any. */
  retrySeconds: number | undefined
  /** Fully-qualified URL the user should open to approve the request. */
  verificationUri: string
}

/** Options accepted by {@link webhookCallback}. */
export type Options = {
  /**
   * Override the outbound `fetch` implementation. Defaults to
   * `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch | undefined
  /**
   * Per-`/token`-poll request timeout (milliseconds). Defaults to
   * 30_000ms. Applies to `POST /register` and outbound `DELETE`.
   */
  fetchTimeout?: number | undefined
  /**
   * Host discovery doc. Accepts either a `host.json` URL string
   * (lazily fetched + validated on first `send()`) or a pre-parsed
   * {@link Discovery.HostDocument}. URL form is the 90% path;
   * pre-parsed is for deterministic tests, caching, pinning, or
   * rotating docs without reconstructing the transport.
   */
  host: string | Discovery.HostDocument
  /**
   * Optional callback invoked once `POST /register` succeeds and the
   * host returns a `verification_uri`. Use this to fan the URL out
   * to the user (CLI prompt, in-app overlay, QR code, etc.) so they
   * can approve the request out of band. The transport itself never
   * displays anything.
   */
  onPrompt?: ((prompt: Prompt) => void | Promise<void>) | undefined
  /**
   * Path the webhook listener responds on. Combined with the bound
   * `Wata.create({ baseUrl })` to derive the callback URL advertised
   * in `consumer.json` and sent to host `/register`.
   */
  path: string
  /**
   * Optional override for the host's `register_url`. When omitted,
   * derived from the host's `webhook-callback` discovery binding.
   * Useful for tests or hosts that haven't published a doc.
   */
  registerUrl?: string | undefined
  /**
   * Pluggable storage for per-`auth_req_id` replay-nonce tracking.
   * Must implement {@link Kv.Kv.take} for atomic one-time-consume
   * semantics — in-memory and Durable Object backends qualify; raw
   * Cloudflare KV does not.
   */
  store: Kv.Kv
}

/**
 * Webhook-callback transport extension: bare {@link Transport.Transport}
 * plus the `.fetch` / `.listener` pair the consumer needs to serve
 * incoming webhook deliveries, plus an explicit {@link cancel} hook.
 */
export type WebhookCallback = Transport.Transport<'consumer'> &
  Http.Server & {
    /**
     * RFC 9421-signed cancellation of the in-flight `auth_req_id`
     * (no-op when no request is pending). Mirrors the spec's
     * `DELETE <register_url>/<auth_req_id>` route.
     */
    cancel: () => Promise<void>
  }

/**
 * Create a consumer-side `webhook-callback` transport.
 *
 * @example
 * ```ts
 * import { webhookCallback, Kv } from 'wata'
 *
 * const transport = webhookCallback({
 *   host: 'https://wallet.example',
 *   path: '/cb',
 *   store: Kv.memory(),
 * })
 * ```
 */
export function webhookCallback(options: Options): WebhookCallback {
  const {
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    fetchTimeout = 30_000,
    host,
    onPrompt,
    path,
    store,
  } = options

  const webhookPath = Uri.normalizePath(path)
  let baseUrl_bound: string | undefined
  let identity_bound: Transport.Identity | undefined

  function getWebhookUrl(): string {
    if (baseUrl_bound) return `${baseUrl_bound}${webhookPath}`
    throw new Transport.TransportError(
      'webhook callback URL could not be derived before `Wata.create({ baseUrl })` bound the transport',
    )
  }

  function getCallbackUrls(): readonly string[] | undefined {
    return baseUrl_bound ? [`${baseUrl_bound}${webhookPath}`] : undefined
  }

  function getKeyid(): string {
    return identityKeyid(getWebhookUrl())
  }

  function getIdentity(): Transport.Identity {
    if (identity_bound) return identity_bound
    throw new Transport.TransportError(
      'webhook-callback identity could not be derived before `Wata.create({ privateKey })` bound the transport',
    )
  }

  const emitter = Events.create<Transport.EventMap>()

  // Single-exchange state. `inFlight` guards concurrent `send()`
  // calls; `closed` flips once the terminal response arrives.
  type State = {
    activeAuthReqId: string | undefined
    activeHostPubkey: string | undefined
    closed: boolean
    inFlight: boolean
    started: boolean
  }
  const state: State = {
    activeAuthReqId: undefined,
    activeHostPubkey: undefined,
    closed: false,
    inFlight: false,
    started: false,
  }

  /** Resolved host doc — eagerly fetched, then implicitly cached by the promise. */
  const resolvedHost = (async () => {
    if (typeof host === 'string') return Discovery.fetchHost(host, { fetch: fetchImpl })
    return host
  })()

  /** Host `register_url` — constructor override wins, else read from discovery binding. */
  const resolvedRegisterUrl = (async () => {
    if (options.registerUrl) return options.registerUrl
    const doc = await resolvedHost
    const binding = doc.transports['webhook-callback']
    if (!binding)
      throw new Transport.UnsupportedError(
        'host does not advertise a `webhook-callback` transport binding',
      )
    return binding.register_url
  })()

  function settle(message: Envelope.Envelope | undefined, cause?: Error) {
    if (state.closed) return
    state.inFlight = false
    state.closed = true
    // Clear the active intent so any subsequent inbound webhook for
    // the same `auth_req_id` is treated as a no-op (idempotent 200)
    // rather than re-emitting `message`.
    state.activeAuthReqId = undefined
    if (cause) emitter.emit('error', cause)
    if (message) emitter.emit('message', message)
    emitter.emit('close', cause)
  }

  const fetchWithTimeout = Fetch.withTimeout(fetchImpl, fetchTimeout)

  async function runRegister(envelope: Envelope.Envelope): Promise<void> {
    if (envelope.type !== 'rpc-requests')
      throw new Transport.UnsupportedError(
        `webhook-callback transport only carries rpc-requests envelopes; received \`${envelope.type}\``,
      )

    const hostDoc = await resolvedHost
    const identity = getIdentity()
    const registerUrl = await resolvedRegisterUrl
    const webhookUrl = getWebhookUrl()

    const body = JSON.stringify({
      message: envelope,
      webhook_url: webhookUrl,
    })
    const digest = MessageSig.contentDigest(body)
    const nonce = generateNonce()
    const created = Math.floor(Date.now() / 1000)
    const components = [
      '@method',
      '@target-uri',
      '@authority',
      'content-type',
      'content-digest',
      'urpc-public-key',
    ]
    const signedHeaders = MessageSig.sign({
      components,
      message: {
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          'urpc-public-key': identity.publicKey,
        },
        method: 'POST',
        url: registerUrl,
      },
      parameters: { alg: 'ed25519', created, keyid: getKeyid(), nonce },
      privateKey: identity.privateKey,
    })

    let response: Response
    try {
      response = await fetchWithTimeout(registerUrl, {
        body,
        headers: {
          'content-digest': digest,
          'content-type': 'application/json',
          signature: signedHeaders.signature,
          'signature-input': signedHeaders.signatureInput,
          'urpc-public-key': identity.publicKey,
        },
        method: 'POST',
      })
    } catch (cause) {
      throw new Transport.TransportError(
        `webhook-callback register failed: ${(cause as Error).message}`,
        { cause: cause as Error },
      )
    }

    if (response.status !== 200) {
      const text = await response.text().catch(() => '<no body>')
      throw new Transport.TransportError(
        `webhook-callback /register returned status ${response.status}: ${text}`,
      )
    }
    const data = (await response.json().catch(() => undefined)) as
      | {
          auth_req_id?: unknown
          expires_in?: unknown
          retry_seconds?: unknown
          verification_uri?: unknown
        }
      | undefined
    if (!data || typeof data !== 'object')
      throw new Transport.TransportError('webhook-callback /register returned a non-object body')
    if (typeof data.auth_req_id !== 'string')
      throw new Transport.TransportError('host /register response missing `auth_req_id`')
    if (typeof data.verification_uri !== 'string')
      throw new Transport.TransportError('host /register response missing `verification_uri`')

    const verificationUri = data.verification_uri
    const verificationOrigin = new URL(verificationUri).origin
    const hostOrigin = new URL(hostDoc.origin).origin
    if (verificationOrigin !== hostOrigin)
      throw new Errors.ProtocolError('verification_uri origin does not match host doc origin', {
        details: `expected ${hostOrigin}, host returned ${verificationOrigin}`,
      })

    state.activeAuthReqId = data.auth_req_id
    state.activeHostPubkey = hostDoc.identity_pubkey

    if (onPrompt)
      await onPrompt({
        authReqId: data.auth_req_id,
        expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
        retrySeconds: typeof data.retry_seconds === 'number' ? data.retry_seconds : undefined,
        verificationUri,
      })
  }

  // Inbound webhook listener. RFC 9421 §3.4.2 verification order:
  // 1. Resolve auth_req_id; unknown / already-consumed → 200 OK
  //    (idempotent).
  // 2. Constant-time compare uRPC-Public-Key against pinned key.
  // 3. Verify RFC 9421 signature.
  // 4. Verify Content-Digest.
  // 5. Idempotency: dedupe by uRPC-Idempotency-Key (per-auth_req_id).
  const app = new Hono()
  app.post(webhookPath, async (c) => {
    const request = c.req.raw
    const bodyText = await request.text()
    const authReqId = request.headers.get('urpc-auth-req-id')
    if (!authReqId) return c.json({ error: 'missing `uRPC-Auth-Req-Id`' }, { status: 400 })
    // §3.4.2 step 1: not the active intent → idempotent 200.
    if (state.activeAuthReqId !== authReqId)
      return c.json({ idempotent: true, ok: true }, { status: 200 })

    const declaredPubkey = request.headers.get('urpc-public-key')
    const pinned = state.activeHostPubkey
    if (!pinned)
      return c.json({ error: 'webhook arrived before register completed' }, { status: 401 })
    if (!declaredPubkey || !constantTimeEqual(declaredPubkey, pinned))
      return c.json(
        { error: 'uRPC-Public-Key does not match pinned host identity' },
        { status: 401 },
      )

    // Reconstruct an HttpMessage for verify(). The header map MUST
    // include the wire-form values for the components covered by the
    // signature (content-type, content-digest, urpc-auth-req-id,
    // urpc-public-key) plus the signature pair.
    const httpMessage: MessageSig.HttpMessage = {
      headers: Object.fromEntries(request.headers),
      method: 'POST',
      url: getWebhookUrl(),
    }
    const hostIdentityHex = Hex.fromBytes(Base64.toBytes(pinned))
    let verified: boolean
    try {
      verified = MessageSig.verify({
        message: httpMessage,
        publicKey: hostIdentityHex,
        requiredComponents: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-auth-req-id',
          'urpc-public-key',
        ],
      })
    } catch (cause) {
      return c.json(
        { details: (cause as Error).message, error: 'signature verification failed' },
        { status: 401 },
      )
    }
    if (!verified) return c.json({ error: 'signature verification failed' }, { status: 401 })

    // §3.4.2 step 4: re-compute body digest and compare against
    // Content-Digest header.
    const expectedDigest = MessageSig.contentDigest(bodyText)
    const actualDigest = (request.headers.get('content-digest') ?? '').trim()
    if (actualDigest !== expectedDigest)
      return c.json({ error: 'Content-Digest mismatch' }, { status: 400 })

    // §5.4 — per-(host identity, auth_req_id) nonce replay protection.
    const parsedInput = MessageSig.parseSignatureInput(request.headers.get('signature-input') ?? '')
    if (parsedInput.parameters.nonce) {
      const nonceKey = `webhook:nonce:${pinned}:${authReqId}:${parsedInput.parameters.nonce}`
      const take = store.take ?? store.get
      // Prefer `take` (atomic read+delete) when available; fall back
      // to get + set as best-effort.
      const seen = await take(nonceKey)
      if (seen) return c.json({ error: 'replay detected' }, { status: 401 })
      await store.set(nonceKey, true, { ttl: 86400 })
    }

    // §3.4.2 step 5: idempotency by uRPC-Idempotency-Key.
    const idemKey = request.headers.get('urpc-idempotency-key')
    if (idemKey) {
      const dedupKey = `webhook:idem:${authReqId}:${idemKey}`
      const existing = await store.get(dedupKey)
      if (existing) return c.json({ idempotent: true, ok: true }, { status: 200 })
      await store.set(dedupKey, true, { ttl: 86400 })
    }

    // Parse the body as an `rpc-responses` envelope and emit.
    let envelope: Envelope.Envelope
    try {
      envelope = Envelope.parse(JSON.parse(bodyText))
    } catch (cause) {
      return c.json(
        { details: (cause as Error).message, error: 'invalid envelope' },
        { status: 400 },
      )
    }
    if (envelope.type !== 'rpc-responses')
      return c.json({ error: 'expected `rpc-responses` envelope' }, { status: 400 })

    settle(envelope)
    return c.json({ ok: true }, { status: 200 })
  })

  const { fetch, listener } = Http.fromHono(app)

  async function cancel(): Promise<void> {
    if (!state.activeAuthReqId) return
    const authReqId = state.activeAuthReqId
    const registerUrl = await resolvedRegisterUrl
    const url = `${registerUrl}/${encodeURIComponent(authReqId)}`
    const nonce = generateNonce()
    const created = Math.floor(Date.now() / 1000)
    const identity = getIdentity()
    const components = ['@method', '@target-uri', '@authority', 'urpc-public-key']
    const signedHeaders = MessageSig.sign({
      components,
      message: { headers: { 'urpc-public-key': identity.publicKey }, method: 'DELETE', url },
      parameters: { alg: 'ed25519', created, keyid: getKeyid(), nonce },
      privateKey: identity.privateKey,
    })
    try {
      await fetchWithTimeout(url, {
        headers: {
          signature: signedHeaders.signature,
          'signature-input': signedHeaders.signatureInput,
          'urpc-public-key': identity.publicKey,
        },
        method: 'DELETE',
      })
    } catch (cause) {
      throw new Transport.TransportError(
        `webhook-callback cancel failed: ${(cause as Error).message}`,
        { cause: cause as Error },
      )
    }
  }

  return {
    bind(binding) {
      const { baseUrl, identity } = binding
      if (baseUrl && !baseUrl_bound)
        baseUrl_bound = Uri.trimTrailingSlash(baseUrl)
      if (identity && !identity_bound) identity_bound = identity
    },
    get callbackUrls() {
      return getCallbackUrls()
    },
    cancel,
    async close(cause) {
      if (state.closed) return
      state.inFlight = false
      state.closed = true
      emitter.emit('close', cause)
    },
    exchange: 'single_exchange',
    fetch,
    listener,
    on: emitter.on,
    get publicKey() {
      return identity_bound?.publicKey
    },
    role: 'consumer',
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('webhook-callback transport already closed')
      if (state.inFlight)
        throw new Transport.TransportError(
          'webhook-callback is single-exchange; a previous send is still in flight',
        )
      if (!state.started) state.started = true
      state.inFlight = true
      try {
        await runRegister(envelope)
      } catch (cause) {
        settle(undefined, cause as Error)
        throw cause
      }
      // `send()` returns once `/register` succeeded; the actual
      // `rpc-responses` envelope arrives later via the webhook
      // listener and is dispatched as a `'message'` event.
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('webhook-callback transport already closed')
      state.started = true
    },
  }
}

/** PKCE-style 32-byte random nonce, encoded as unpadded base64url. */
function generateNonce(): string {
  return Base64.fromBytes(Bytes.random(32), { pad: false, url: true })
}

function identityKeyid(url: string): string {
  return `${new URL(url).origin}#identity`
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}
