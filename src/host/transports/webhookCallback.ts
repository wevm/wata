/**
 * Host-side `webhook-callback` transport — HTTP-server-shaped,
 * single-exchange.
 *
 * Implements the host half of the uRPC `webhook-callback` spec:
 *
 * - `POST <path>/register` — consumer registers an authorization
 *   intent (RFC 9421-signed by the consumer's `identity_pubkey`).
 *   Validates the signature, validates `webhook_url` against the
 *   consumer's `consumer.json` `callback_urls` allowlist, snapshots
 *   the consumer's identity / matched callback URL / queued message
 *   for the lifetime of the intent, returns
 *   `{ auth_req_id, verification_uri, expires_in, retry_seconds }`.
 * - `DELETE <path>/register/:auth_req_id` — RFC 9421-signed
 *   cancellation. Effective only before approval. Idempotent.
 * - `GET <path>/verify` — bring-your-own approval UI. The host's
 *   {@link html.Hooks.render} hook renders the page; {@link html.Hooks.authenticate}
 *   handles the POST submission and calls `actions.approve` /
 *   `actions.deny` to settle the intent.
 * - On approval, the wrapping `Wata` runs the consumer's queued
 *   `rpc-requests` and replies via `transport.send(envelope)`, which
 *   triggers the outbound `POST <webhook_url>` driver (RFC 9421-signed
 *   under the host's long-term `identity` keypair).
 *
 * The verify UI is intentionally bring-your-own — the host owns
 * branding, sign-in state, CSP / `SameSite` / `Origin` enforcement,
 * etc. The transport owns routing, signature verification, intent
 * lifecycle, and outbound delivery.
 *
 * @example minimal Node host
 * ```ts
 * import { createServer } from 'node:http'
 * import { Wata, Kv, webhookCallback } from 'wata/host'
 *
 * const transport = webhookCallback({
 *   baseUrl: 'https://wallet.example',
 *   html: {
 *     authenticate: async ({ request, actions }) => {
 *       const body = await request.formData()
 *       await actions.approve(String(body.get('req')))
 *       return new Response('approved')
 *     },
 *     render: ({ record }) => new Response(`<form>...${record?.message ?? ''}</form>`, { headers: { 'content-type': 'text/html' } }),
 *   },
 *   path: '/auth/webhook',
 *   store: Kv.memory(),
 * })
 *
 * const wata = Wata.create({ privateKey, transport })
 * wata.on('request', (event) => event.respond({ ok: true }))
 *
 * createServer(transport.listener).listen(3000)
 * ```
 */

import { Hono } from 'hono'
import { Base64, Bytes, Hex } from 'ox'

import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Http from '../../core/Http.js'
import * as Kv from '../../core/Kv.js'
import * as MessageSig from '../../core/MessageSig.js'
import * as Transport from '../../core/Transport.js'
import * as Uri from '../../internal/Uri.js'

/** Persisted pending-intent record. */
export type PendingRecord = {
  /** Opaque correlation id echoed back on webhook delivery. */
  authReqId: string
  /**
   * Display identity snapshotted from the consumer's `consumer.json`
   * at registration time. Used for the approval surface — MUST NOT
   * be re-fetched or replaced for the lifetime of the intent.
   */
  consumer: {
    /** Consumer's self-asserted `id` (typically hostname). */
    id: string
    /** Optional meta block, when published. */
    meta?: Discovery.Meta | undefined
    /** Self-asserted origin from the doc. */
    origin: string
    /**
     * Long-term Ed25519 identity public key, unpadded base64url —
     * not directly used after registration but persisted so audit
     * logs can correlate.
     */
    publicKey?: string | undefined
  }
  /** Epoch-ms creation. */
  createdAt: number
  /** Epoch-ms expiry of the approval window. */
  expiresAt: number
  /** Consumer's `rpc-requests` envelope, queued for delivery on approval. */
  message: Envelope.Envelope
  /** Opaque single-use handle visible in `verification_uri`. */
  req: string
  /**
   * `rpc-responses` envelope produced by the wrapping `Wata` once the
   * user approves and the host-side `'request'` listener fires.
   * `undefined` until delivery.
   */
  response?: Envelope.Envelope | undefined
  /** Retry budget (seconds) for outbound webhook delivery. */
  retrySeconds: number
  /** Lifecycle status. */
  status: 'pending' | 'approved' | 'denied' | 'cancelled' | 'delivered'
  /** Pre-validated callback URL (byte-equal to a `consumer.json` entry). */
  webhookUrl: string
}

/** Options accepted by {@link webhookCallback}. */
export type Options = {
  /**
   * Public origin of the host. Used to construct `verification_uri`.
   * Falls back to the request URL origin when omitted; the wrapping
   * `Wata.create({ baseUrl })` also lazy-injects its own value via
   * {@link Transport.Transport.bind}.
   */
  baseUrl?: string | undefined
  /**
   * Approval-intent lifetime (seconds). Spec RECOMMENDS ≤600.
   * Defaults to 600 (10 minutes).
   */
  expiresIn?: number | undefined
  /**
   * Override the `fetch` implementation used for outbound webhook
   * delivery and (when needed) for fetching the consumer's
   * `consumer.json`. Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch | undefined
  /** Bring-your-own approval UI hooks. */
  html: html.Hooks
  /**
   * Optional path-prefix overlap with the wrapping app — for example
   * `/auth/webhook` so routes resolve to `POST /auth/webhook/register`,
   * `DELETE /auth/webhook/register/:authReqId`, `GET /auth/webhook/verify`,
   * `POST /auth/webhook/verify`. Defaults to `''` (mount at the root
   * of whatever the caller hands `transport.fetch`).
   */
  path?: string | undefined
  /**
   * Retry budget surfaced in the `/register` response (seconds).
   * Defaults to 900 (15 minutes). Spec minimum: 300; maximum: 86400.
   */
  retrySeconds?: number | undefined
  /**
   * Pluggable persistence for {@link PendingRecord}s. Use
   * {@link Kv.memory} for tests.
   */
  store: Kv.Kv
}

export declare namespace html {
  /** Bring-your-own approval UI hooks. */
  type Hooks = {
    /**
     * Called for `POST /verify`. Inspect the `request` (form POST
     * with `req` handle plus your own auth fields), then call
     * `actions.approve(req)` / `actions.deny(req)` with a Core
     * `rpc-responses` envelope or none (the wrapping `Wata` will
     * compute it). Return a `Response` describing what to show.
     */
    authenticate: (options: authenticate.Options) => Response | Promise<Response>
    /**
     * Called for `GET /verify`. Receive the `req` query handle, the
     * resolved {@link PendingRecord} (when present and pending), and
     * return the HTML form / page describing the queued requests.
     */
    render: (options: render.Options) => Response | Promise<Response>
  }

  namespace render {
    /** Argument passed to {@link html.Hooks.render}. */
    type Options = {
      /** Pending {@link PendingRecord} for `req`, if found. */
      record: PendingRecord | undefined
      /** `req` from the URL query (`?req=...`), if any. */
      req: string | undefined
      /** The original `Request` passed to `transport.fetch`. */
      request: Request
    }
  }

  namespace authenticate {
    /** Argument passed to {@link html.Hooks.authenticate}. */
    type Options = {
      /** Approve / deny / look up actions exposed to the host's auth handler. */
      actions: Actions
      /** The form-POST `Request` from the user-agent. */
      request: Request
    }
  }

  /** Actions exposed inside {@link html.Hooks.authenticate}. */
  type Actions = {
    /**
     * Mark the intent as approved by `req` handle. The transport
     * then emits the queued `rpc-requests` envelope as a `'message'`
     * event so the wrapping `Wata` dispatches it and produces a
     * response; the response triggers outbound delivery.
     */
    approve: (req: string) => Promise<void>
    /**
     * Mark the intent as denied. The transport emits a JSON-RPC
     * `-32000` error response back to the consumer for every queued
     * request and triggers outbound delivery.
     */
    deny: (req: string) => Promise<void>
    /** Look up the {@link PendingRecord} associated with a `req` handle. */
    get: (req: string) => Promise<PendingRecord | undefined>
  }
}

/** `transport.fetch` / `transport.listener`-augmented {@link Transport.Transport}. */
export type WebhookCallback = Transport.Transport<'host'> & Http.Server

/**
 * Create a host-side `webhook-callback` transport.
 *
 * @example
 * ```ts
 * import { Wata, Kv, webhookCallback } from 'wata/host'
 *
 * const transport = webhookCallback({
 *   baseUrl: 'https://wallet.example',
 *   html: { render, authenticate },
 *   path: '/auth/webhook',
 *   store: Kv.memory(),
 * })
 * ```
 */
export function webhookCallback(options: Options): WebhookCallback {
  const {
    expiresIn = 600,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    html,
    path,
    retrySeconds = 900,
    store,
  } = options

  const baseUrl_ctor = options.baseUrl ? Uri.trimTrailingSlash(options.baseUrl) : undefined
  let baseUrl_bound: string | undefined
  let identity_bound: Transport.Identity | undefined

  function resolveBaseUrl(requestUrl: string): string {
    if (baseUrl_ctor) return baseUrl_ctor
    if (baseUrl_bound) return baseUrl_bound
    baseUrl_bound = Uri.trimTrailingSlash(new URL(requestUrl).origin)
    return baseUrl_bound
  }

  function resolveKeyid(): string {
    const baseUrl = baseUrl_ctor ?? baseUrl_bound
    if (!baseUrl)
      throw new Transport.TransportError(
        'webhook-callback host `keyid` could not be derived before `baseUrl` was known',
      )
    return identityKeyid(baseUrl)
  }

  function getIdentity(): Transport.Identity {
    if (identity_bound) return identity_bound
    throw new Transport.TransportError(
      'webhook-callback host identity could not be derived before `Wata.create({ privateKey })` bound the transport',
    )
  }

  function verificationUriFor(requestUrl: string, req: string): string {
    const url = new URL(`${resolveBaseUrl(requestUrl)}${path ?? ''}/verify`)
    url.searchParams.set('req', req)
    return url.toString()
  }

  const emitter = Events.create<Transport.EventMap>()

  // Single-exchange transport: tracks the in-flight auth_req_id so the
  // user-supplied `'request'` listener's response is keyed back to the
  // correct pending record on `transport.send()`.
  type State = { activeAuthReqId: string | undefined; closed: boolean; started: boolean }
  const state: State = {
    activeAuthReqId: undefined,
    closed: false,
    started: false,
  }

  const actions: html.Actions = {
    async approve(req) {
      const record = await store.get<PendingRecord>(reqKey(req))
      if (!record) throw new UnknownReqError(req)
      if (record.status !== 'pending') return
      record.status = 'approved'
      await persist(record)
      state.activeAuthReqId = record.authReqId
      emitter.emit('message', record.message)
    },
    async deny(req) {
      const record = await store.get<PendingRecord>(reqKey(req))
      if (!record) throw new UnknownReqError(req)
      if (record.status !== 'pending') return
      record.status = 'denied'
      await persist(record)
      // Synthesize a JSON-RPC error response for every queued request.
      const denials = (record.message.type === 'rpc-requests' ? record.message.payload : []).map(
        (entry) => ({
          error: { code: -32000, message: 'denied by user' },
          id: 'id' in entry ? entry.id : null,
          jsonrpc: '2.0' as const,
        }),
      )
      state.activeAuthReqId = record.authReqId
      // Skip Wata dispatch — drive the outbound webhook directly.
      await deliver(record, Envelope.rpcResponses(denials))
    },
    async get(req) {
      return await store.get<PendingRecord>(reqKey(req))
    },
  }

  const app = path ? new Hono().basePath(path) : new Hono()

  // Spec §3.3.1.1 — approval-surface hardening. We can't enforce
  // CSP / SameSite cookies from inside the transport (those belong
  // to the wallet's full app shell), but `Cache-Control: no-store`
  // is universally applicable.
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  app.onError((cause, c) => {
    emitter.emit('error', cause as Error)
    return c.json(
      { error: 'server_error', error_description: (cause as Error).message },
      { status: 500 },
    )
  })

  app.post('/register', async (c) => {
    const request = c.req.raw
    const bodyText = await request.text()
    // Verify RFC 9421 signature before any state change.
    const declaredPubkey = request.headers.get('urpc-public-key')
    if (!declaredPubkey)
      return c.json(
        { error: 'invalid_request', error_description: 'missing `uRPC-Public-Key`' },
        { status: 400 },
      )

    // Verify Content-Digest before reading body.
    const expectedDigest = MessageSig.contentDigest(bodyText)
    const actualDigest = (request.headers.get('content-digest') ?? '').trim()
    if (actualDigest !== expectedDigest)
      return c.json(
        { error: 'invalid_request', error_description: 'Content-Digest mismatch' },
        { status: 400 },
      )

    let consumerKeyHex: Hex.Hex
    try {
      consumerKeyHex = base64urlToHex(declaredPubkey)
    } catch (cause) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `invalid uRPC-Public-Key: ${(cause as Error).message}`,
        },
        { status: 400 },
      )
    }

    const httpMessage: MessageSig.HttpMessage = {
      headers: collectHeaders(request.headers),
      method: 'POST',
      url: c.req.url,
    }
    let verified: boolean
    try {
      verified = MessageSig.verify({
        message: httpMessage,
        publicKey: consumerKeyHex,
        requiredComponents: [
          '@method',
          '@target-uri',
          '@authority',
          'content-type',
          'content-digest',
          'urpc-public-key',
        ],
      })
    } catch (cause) {
      return c.json(
        { error: 'unauthorized', error_description: (cause as Error).message },
        { status: 401 },
      )
    }
    if (!verified)
      return c.json(
        { error: 'unauthorized', error_description: 'signature verification failed' },
        { status: 401 },
      )

    let body: { consumer_url?: unknown; expiry?: unknown; message?: unknown; webhook_url?: unknown }
    try {
      body = JSON.parse(bodyText) as never
    } catch (cause) {
      return c.json(
        { error: 'invalid_request', error_description: (cause as Error).message },
        { status: 400 },
      )
    }
    if (!body || typeof body !== 'object')
      return c.json(
        { error: 'invalid_request', error_description: 'expected JSON object body' },
        { status: 400 },
      )
    if (typeof body.webhook_url !== 'string')
      return c.json(
        { error: 'invalid_request', error_description: 'missing `webhook_url`' },
        { status: 400 },
      )

    let envelope: Envelope.Envelope
    try {
      envelope = Envelope.parse(body.message)
    } catch (cause) {
      return c.json(
        { error: 'invalid_request', error_description: (cause as Error).message },
        { status: 400 },
      )
    }
    if (envelope.type !== 'rpc-requests')
      return c.json(
        {
          error: 'invalid_request',
          error_description: '`message` must be an `rpc-requests` envelope',
        },
        { status: 400 },
      )

    // §3.1.2 — validate webhook_url against the consumer's
    // `consumer.json` `callback_urls` allowlist (byte-equal + same-
    // origin). Fetch the consumer doc once at registration.
    const webhookUrlOrigin = (() => {
      try {
        return new URL(body.webhook_url).origin
      } catch {
        return undefined
      }
    })()
    if (!webhookUrlOrigin)
      return c.json(
        { error: 'invalid_request', error_description: 'invalid `webhook_url`' },
        { status: 400 },
      )

    let consumerDoc: Discovery.ConsumerDocument | undefined
    try {
      consumerDoc = await Discovery.fetchConsumer(webhookUrlOrigin, { fetch: fetchImpl })
    } catch (cause) {
      return c.json(
        {
          error: 'forbidden',
          error_description: `consumer discovery fetch failed: ${(cause as Error).message}`,
        },
        { status: 403 },
      )
    }
    if (consumerDoc.identity_pubkey && consumerDoc.identity_pubkey !== declaredPubkey)
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'uRPC-Public-Key does not match consumer.json identity_pubkey',
        },
        { status: 401 },
      )
    const callbackUrls = consumerDoc.callback_urls
    if (!callbackUrls || !callbackUrls.includes(body.webhook_url))
      return c.json(
        {
          error: 'forbidden',
          error_description: '`webhook_url` not present in consumer.json `callback_urls` allowlist',
        },
        { status: 403 },
      )
    if (new URL(body.webhook_url).origin !== new URL(consumerDoc.origin).origin)
      return c.json(
        {
          error: 'forbidden',
          error_description: '`webhook_url` must share the consumer.json origin',
        },
        { status: 403 },
      )

    // Mint fresh opaque identifiers. Spec §3.1.3 — `auth_req_id` and
    // `req` MUST each carry ≥128 bits of CSPRNG entropy and MUST NOT
    // be the same value.
    const authReqId = generateOpaque(16)
    const req = generateOpaque(16)
    const now = Date.now()
    const requestedExpiry =
      typeof body.expiry === 'number' && Number.isFinite(body.expiry) ? body.expiry : expiresIn
    const effectiveExpiry = Math.min(Math.max(60, Math.floor(requestedExpiry)), expiresIn)

    const record: PendingRecord = {
      authReqId,
      consumer: {
        id: consumerDoc.id,
        origin: consumerDoc.origin,
        ...(consumerDoc.name ||
        consumerDoc.icon ||
        consumerDoc.description ||
        consumerDoc.website_url
          ? {
              meta: {
                name: consumerDoc.name ?? consumerDoc.id,
                ...(consumerDoc.description ? { description: consumerDoc.description } : {}),
                ...(consumerDoc.icon ? { icon: consumerDoc.icon } : {}),
                ...(consumerDoc.website_url ? { websiteUrl: consumerDoc.website_url } : {}),
              },
            }
          : {}),
        ...(consumerDoc.identity_pubkey ? { publicKey: consumerDoc.identity_pubkey } : {}),
      },
      createdAt: now,
      expiresAt: now + effectiveExpiry * 1000,
      message: envelope,
      req,
      retrySeconds,
      status: 'pending',
      webhookUrl: body.webhook_url,
    }
    await store.set(reqKey(req), record, { ttl: effectiveExpiry + retrySeconds })
    await store.set(authReqIdKey(authReqId), record, { ttl: effectiveExpiry + retrySeconds })

    return c.json({
      auth_req_id: authReqId,
      expires_in: effectiveExpiry,
      retry_seconds: retrySeconds,
      verification_uri: verificationUriFor(c.req.url, req),
    })
  })

  app.delete('/register/:authReqId', async (c) => {
    const authReqId = c.req.param('authReqId')
    // Verify signature first.
    const request = c.req.raw
    const declaredPubkey = request.headers.get('urpc-public-key')
    if (!declaredPubkey)
      return c.json(
        { error: 'invalid_request', error_description: 'missing `uRPC-Public-Key`' },
        { status: 400 },
      )
    let consumerKeyHex: Hex.Hex
    try {
      consumerKeyHex = base64urlToHex(declaredPubkey)
    } catch (cause) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `invalid uRPC-Public-Key: ${(cause as Error).message}`,
        },
        { status: 400 },
      )
    }
    let verified: boolean
    try {
      verified = MessageSig.verify({
        message: {
          headers: collectHeaders(request.headers),
          method: 'DELETE',
          url: c.req.url,
        },
        publicKey: consumerKeyHex,
        requiredComponents: ['@method', '@target-uri', '@authority', 'urpc-public-key'],
      })
    } catch (cause) {
      return c.json(
        { error: 'unauthorized', error_description: (cause as Error).message },
        { status: 401 },
      )
    }
    if (!verified)
      return c.json(
        { error: 'unauthorized', error_description: 'signature verification failed' },
        { status: 401 },
      )

    const record = await store.get<PendingRecord>(authReqIdKey(authReqId))
    // §3.5 — idempotent. Unknown / already-cancelled / already-approved
    // all collapse into 204 No Content.
    if (!record) return new Response(null, { status: 204 })
    if (record.status === 'pending') {
      record.status = 'cancelled'
      await persist(record)
    }
    return new Response(null, { status: 204 })
  })

  app.get('/verify', async (c) => {
    const req = c.req.query('req') ?? undefined
    const record = req ? await store.get<PendingRecord>(reqKey(req)) : undefined
    const pendingRecord = record && record.status === 'pending' ? record : undefined
    return await html.render({ record: pendingRecord, req, request: c.req.raw })
  })

  app.post('/verify', (c) => html.authenticate({ actions, request: c.req.raw }))

  const { fetch, listener } = Http.fromHono(app)

  // ── outbound webhook delivery ───────────────────────────────────────

  /**
   * Sign and POST the `rpc-responses` envelope to the consumer's
   * pre-registered `webhook_url` under the host's identity key.
   */
  async function deliver(record: PendingRecord, response: Envelope.Envelope): Promise<void> {
    const body = JSON.stringify(response)
    const digest = MessageSig.contentDigest(body)
    const created = Math.floor(Date.now() / 1000)
    const nonce = generateOpaque(16)
    const components = [
      '@method',
      '@target-uri',
      '@authority',
      'content-type',
      'content-digest',
      'urpc-auth-req-id',
      'urpc-public-key',
    ]
    const identity = getIdentity()
    const headers: Record<string, string> = {
      'content-digest': digest,
      'content-type': 'application/json',
      'urpc-auth-req-id': record.authReqId,
      'urpc-idempotency-key': record.authReqId,
      'urpc-public-key': identity.publicKey,
    }
    const signedHeaders = MessageSig.sign({
      components,
      message: { headers, method: 'POST', url: record.webhookUrl },
      parameters: { alg: 'ed25519', created, keyid: resolveKeyid(), nonce },
      privateKey: identity.privateKey,
    })
    headers['signature'] = signedHeaders.signature
    headers['signature-input'] = signedHeaders.signatureInput

    let httpResponse: Response
    try {
      httpResponse = await fetchImpl(record.webhookUrl, {
        body,
        headers,
        method: 'POST',
        redirect: 'manual',
      })
    } catch (cause) {
      emitter.emit(
        'error',
        new Transport.TransportError(`webhook delivery failed: ${(cause as Error).message}`, {
          cause: cause as Error,
        }),
      )
      throw cause
    }
    // §5.9 / §3.4.3 — never follow 3xx redirects.
    if (httpResponse.status >= 300 && httpResponse.status < 400)
      throw new Transport.TransportError(
        `webhook delivery refused — cross-origin / same-origin redirect ${httpResponse.status} forbidden`,
      )
    if (!httpResponse.ok)
      throw new Transport.TransportError(
        `webhook delivery returned non-2xx status ${httpResponse.status}`,
      )
    record.status = 'delivered'
    record.response = response
    await persist(record)
  }

  async function persist(record: PendingRecord): Promise<void> {
    const ttl =
      Math.ceil(Math.max(60, (record.expiresAt - Date.now()) / 1000)) + record.retrySeconds
    await store.set(reqKey(record.req), record, { ttl })
    await store.set(authReqIdKey(record.authReqId), record, { ttl })
  }

  return {
    bind(binding) {
      const { baseUrl, identity } = binding
      if (baseUrl && !baseUrl_ctor && !baseUrl_bound)
        baseUrl_bound = Uri.trimTrailingSlash(baseUrl)
      if (identity && !identity_bound) identity_bound = identity
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
      emitter.emit('close', cause)
    },
    discovery: {
      binding(baseUrl) {
        const prefix = `${Uri.trimTrailingSlash(baseUrl)}${path ?? ''}`
        return {
          auth_url_origin: new URL(baseUrl).origin,
          register_url: `${prefix}/register`,
        }
      },
      id: 'webhook-callback',
    },
    exchange: 'single_exchange',
    fetch,
    listener,
    on: emitter.on,
    role: 'host',
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('webhook-callback transport already closed')
      if (!state.started) throw new Transport.ClosedError('webhook-callback transport not started')
      const authReqId = state.activeAuthReqId
      if (!authReqId)
        throw new Transport.TransportError(
          'no active auth_req_id; `transport.send` was called before any approval',
        )
      const record = await store.get<PendingRecord>(authReqIdKey(authReqId))
      if (!record)
        throw new Transport.ClosedError(
          'pending intent disappeared from store before response delivery',
        )
      try {
        await deliver(record, envelope)
      } finally {
        // `single_exchange` is per `auth_req_id`, not per transport
        // lifetime: the wallet server is long-running and handles
        // many sequential intents. Clear the slot so the next
        // approval can dispatch through, but keep the transport open.
        state.activeAuthReqId = undefined
      }
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('webhook-callback transport already closed')
      state.started = true
    },
  }
}

function identityKeyid(url: string): string {
  return `${new URL(url).origin}#identity`
}

function reqKey(req: string): string {
  return `webhook:req:${req}`
}

function authReqIdKey(authReqId: string): string {
  return `webhook:authReqId:${authReqId}`
}

function generateOpaque(byteCount: number): string {
  return Base64.fromBytes(Bytes.random(byteCount), { pad: false, url: true })
}

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function base64urlToHex(value: string): Hex.Hex {
  return Hex.fromBytes(Base64.toBytes(value))
}

/**
 * Thrown by {@link html.Actions} when the supplied `req` handle
 * doesn't match any pending record.
 */
export class UnknownReqError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'WebhookCallback.UnknownReqError'

  constructor(req: string, options: Errors.BaseError.Options<cause> = {} as never) {
    super(`no pending intent for req \`${req}\``, options)
  }
}
