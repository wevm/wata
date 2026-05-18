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
 *   {@link html.Hooks.render} hook renders the page.
 * - `POST <path>/verify` — optionally calls
 *   {@link html.Hooks.authenticate} so hosts can handle form posts
 *   through {@link html.Actions}. Without a hook, or when the hook
 *   returns nothing, validates the browser-submitted `rpc-responses`
 *   body and forwards those exact bytes to the consumer's webhook
 *   (RFC 9421-signed under the host's long-term `identity` keypair).
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
 *     render: ({ record }) => new Response(`<form>...${record?.message ?? ''}</form>`, { headers: { 'content-type': 'text/html' } }),
 *   },
 *   path: '/auth/webhook',
 *   store: Kv.memory(),
 * })
 *
 * const wata = Wata.create({ privateKey, transport })
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
import * as Rpc from '../../core/Rpc.js'
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
    publicKey: string
  }
  /** Epoch-ms creation. */
  createdAt: number
  /** Epoch-ms expiry of the approval window. */
  expiresAt: number
  /** Consumer's `rpc-requests` envelope, queued for delivery on approval. */
  message: Envelope.Envelope
  /** Opaque single-use handle carried by `verification_uri` as `?code=...`. */
  code: string
  /** `rpc-responses` envelope submitted at the approval surface. */
  response?: Envelope.Envelope | undefined
  /** Verbatim approval-surface response body used for webhook retries. */
  responseBody?: string | undefined
  /** Retry budget (seconds) for outbound webhook delivery. */
  retrySeconds: number
  /** Epoch-ms approval / denial transition time. Starts the retry budget. */
  settledAt?: number | undefined
  /** Lifecycle status. */
  status: 'pending' | 'approved' | 'denied' | 'cancelled' | 'delivered' | 'undeliverable'
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
   * {@link Kv.memory} for tests. Must support atomic {@link Kv.Kv.take}
   * so approval codes can be consumed exactly once.
   */
  store: Kv.AtomicKv
}

export declare namespace html {
  /** Bring-your-own approval UI hooks. */
  type Hooks = {
    /**
     * Called for `POST /verify`. Hosts can inspect form submissions,
     * enforce session / CSRF checks, then settle with
     * `actions.approve(code, responseBody)` or
     * `actions.deny(code)`.
     * Return a `Response` to show the user the result; return nothing
     * to let the transport validate and deliver an `application/json`
     * `rpc-responses` request body verbatim.
     */
    authenticate?:
      | ((options: authenticate.Options) => Response | void | Promise<Response | void>)
      | undefined
    /**
     * Called for `GET /verify`. Receive the opaque code
     * from the URL's `?code=` query parameter, the resolved
     * {@link PendingRecord} (when present and pending), and return the
     * HTML form / page describing the queued requests.
     */
    render: (options: render.Options) => Response | Promise<Response>
  }

  namespace render {
    /** Argument passed to {@link html.Hooks.render}. */
    type Options = {
      /** Pending {@link PendingRecord} for the `code`, if found. */
      record: PendingRecord | undefined
      /** Opaque code from the URL query (`?code=...`), if any. */
      code: string | undefined
      /** The original `Request` passed to `transport.fetch`. */
      request: Request
    }
  }

  namespace authenticate {
    /** Argument passed to {@link html.Hooks.authenticate}. */
    type Options = {
      /** Approve / deny / look up actions for form-based approval. */
      actions: Actions
      /**
       * Pending {@link PendingRecord} for the `code`, if present
       * in the URL query and still pending.
       */
      record: PendingRecord | undefined
      /** Opaque code from the verification URI query (`?code=...`), if any. */
      code: string | undefined
      /** The `POST /verify` request from the user-agent. */
      request: Request
    }
  }

  /** Body accepted by {@link Actions.approve} / {@link Actions.deny}. */
  type ResponseBody = Extract<Envelope.Envelope, { type: 'rpc-responses' }> | string

  /** Actions exposed inside {@link html.Hooks.authenticate}. */
  type Actions = {
    /**
     * Approve a pending request. Passing a `responseBody` validates
     * and delivers that body immediately. Omitting it dispatches the
     * queued request through the host `Wata` request listener, which
     * is suitable for simple server-side approval flows.
     */
    approve: (code: string, responseBody?: ResponseBody | undefined) => Promise<void>
    /**
     * Deny a pending request. When `responseBody` is omitted, the
     * transport creates `-32000 denied by user` responses for every
     * queued JSON-RPC request id and delivers them.
     */
    deny: (code: string, responseBody?: ResponseBody | undefined) => Promise<void>
    /** Look up the {@link PendingRecord} associated with a code. */
    get: (code: string) => Promise<PendingRecord | undefined>
  }
}

/** `transport.fetch` / `transport.listener`-augmented {@link Transport.Transport}. */
export type WebhookCallback = Transport.Transport<'host'> & Http.Server

type DeliveryAttempt = { type: 'delivered' } | { error: Error; retryable: boolean; type: 'failed' }

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
  const take = (() => {
    const take = store.take?.bind(store)
    if (!take)
      throw new Transport.TransportError(
        'webhook-callback host store must implement `take` for single-use approval codes',
      )
    return take
  })()

  const baseUrl_ctor = options.baseUrl ? Uri.trimTrailingSlash(options.baseUrl) : undefined
  const effectiveExpiresIn = Math.min(
    600,
    Math.max(60, Number.isFinite(expiresIn) ? Math.floor(expiresIn) : 600),
  )
  const effectiveRetrySeconds = Math.min(
    86400,
    Math.max(300, Number.isFinite(retrySeconds) ? Math.floor(retrySeconds) : 900),
  )
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

  function verificationUriFor(requestUrl: string, code: string): string {
    const url = new URL(`${resolveBaseUrl(requestUrl)}${path ?? ''}/verify`)
    url.searchParams.set('code', code)
    return url.toString()
  }

  const emitter = Events.create<Transport.EventMap>()

  // Single-exchange transport. Direct approval delivery goes through
  // POST /verify and raw body forwarding. Form-based
  // `actions.approve(code)` dispatches into Wata, so response
  // ids are temporarily mapped back to their pending auth_req_id for
  // the generic `transport.send`.
  type State = {
    activeAuthReqIds: Map<string, string>
    closed: boolean
    started: boolean
  }
  const state: State = {
    activeAuthReqIds: new Map(),
    closed: false,
    started: false,
  }

  const actions: html.Actions = {
    async approve(code, responseBody?) {
      const record = await requirePendingRecord(code)
      if (responseBody !== undefined) {
        assertValidResponseBody(record, responseBody)
        await settleWithResponse(await consumePendingRecord(code, record.authReqId), responseBody)
        return
      }
      const ids = requestIdsFor(record)
      if (ids.length !== 1)
        throw new Transport.TransportError(
          '`actions.approve(code)` without a response body requires exactly one queued JSON-RPC request',
        )
      const consumedRecord = await consumePendingRecord(code, record.authReqId)
      consumedRecord.status = 'approved'
      consumedRecord.settledAt = Date.now()
      await persist(consumedRecord)
      activateDispatch(consumedRecord)
      emitter.emit('message', consumedRecord.message)
    },
    async deny(code, responseBody) {
      const record = await requirePendingRecord(code)
      const body = responseBody ?? deniedResponseFor(record)
      assertValidResponseBody(record, body)
      await settleWithResponse(await consumePendingRecord(code, record.authReqId), body)
    },
    async get(code) {
      return await store.get<PendingRecord>(codeKey(code))
    },
  }

  const app = path ? new Hono().basePath(path) : new Hono()

  // Approval-surface hardening that is safe for the transport to
  // apply centrally. Session cookies and CSRF remain the wallet app's
  // responsibility, but URL leakage and framing protections are
  // universal for this endpoint family.
  app.use('*', async (c, next) => {
    await next()
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store')
    if (!c.res.headers.has('Content-Security-Policy'))
      c.res.headers.set('Content-Security-Policy', approvalSurfaceCsp)
    if (!c.res.headers.has('Pragma')) c.res.headers.set('Pragma', 'no-cache')
    if (!c.res.headers.has('Referrer-Policy')) c.res.headers.set('Referrer-Policy', 'no-referrer')
    if (!c.res.headers.has('X-Frame-Options')) c.res.headers.set('X-Frame-Options', 'DENY')
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
    if (!envelope.payload.some((entry) => 'id' in entry))
      return c.json(
        {
          error: 'invalid_request',
          error_description: '`message` must contain at least one JSON-RPC request id',
        },
        { status: 400 },
      )

    // §3.1.2 — validate webhook_url against the consumer's
    // `consumer.json` `callback_urls` allowlist (byte-equal + same-
    // origin). Fetch the consumer doc once at registration.
    const webhookUrl = (() => {
      try {
        return new URL(body.webhook_url)
      } catch {
        return undefined
      }
    })()
    if (!webhookUrl)
      return c.json(
        { error: 'invalid_request', error_description: 'invalid `webhook_url`' },
        { status: 400 },
      )
    if (!isAllowedWebhookUrl(webhookUrl, new URL(resolveBaseUrl(c.req.url))))
      return c.json(
        {
          error: 'forbidden',
          error_description:
            '`webhook_url` must use a public https URL (http allowed only for loopback development)',
        },
        { status: 403 },
      )

    let consumerDoc: Discovery.ConsumerDocument | undefined
    try {
      consumerDoc = await Discovery.fetchConsumer(webhookUrl.origin, { fetch: fetchImpl })
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
    if (webhookUrl.origin !== new URL(consumerDoc.origin).origin)
      return c.json(
        {
          error: 'forbidden',
          error_description: '`webhook_url` must share the consumer.json origin',
        },
        { status: 403 },
      )

    if (!consumerDoc.identity_pubkey)
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'consumer.json missing `identity_pubkey` for webhook-callback',
        },
        { status: 401 },
      )
    if (consumerDoc.identity_pubkey !== declaredPubkey)
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'uRPC-Public-Key does not match consumer.json identity_pubkey',
        },
        { status: 401 },
      )

    const expectedKeyid = identityKeyid(consumerDoc.origin)
    try {
      assertSignatureKeyid(request, expectedKeyid)
    } catch (cause) {
      return c.json(
        { error: 'unauthorized', error_description: (cause as Error).message },
        { status: 401 },
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
        publicKey: base64urlToHex(consumerDoc.identity_pubkey),
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
    const nonceError = await consumeSignatureNonce(request, consumerDoc.identity_pubkey)
    if (nonceError)
      return c.json(
        { error: 'unauthorized', error_description: nonceError },
        { status: 401 },
      )

    // Mint fresh opaque identifiers. Spec §3.1.3 — `auth_req_id` and
    // the `?code=` handle MUST each carry ≥128 bits of CSPRNG entropy
    // and MUST NOT be the same value.
    const authReqId = generateOpaque(16)
    const code = generateOpaque(16)
    const now = Date.now()
    const requestedExpiry =
      typeof body.expiry === 'number' && Number.isFinite(body.expiry)
        ? body.expiry
        : effectiveExpiresIn
    const effectiveExpiry = Math.min(Math.max(60, Math.floor(requestedExpiry)), effectiveExpiresIn)

    const record: PendingRecord = {
      authReqId,
      consumer: {
        id: consumerDoc.id,
        origin: consumerDoc.origin,
        publicKey: consumerDoc.identity_pubkey,
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
      },
      createdAt: now,
      expiresAt: now + effectiveExpiry * 1000,
      message: envelope,
      code,
      retrySeconds: effectiveRetrySeconds,
      status: 'pending',
      webhookUrl: body.webhook_url,
    }
    await store.set(codeKey(code), record, {
      ttl: effectiveExpiry + effectiveRetrySeconds,
    })
    await store.set(authReqIdKey(authReqId), record, {
      ttl: effectiveExpiry + effectiveRetrySeconds,
    })

    return c.json({
      auth_req_id: authReqId,
      expires_in: effectiveExpiry,
      retry_seconds: effectiveRetrySeconds,
      verification_uri: verificationUriFor(c.req.url, code),
    })
  })

  app.delete('/register/:authReqId', async (c) => {
    const authReqId = c.req.param('authReqId')
    const record = await store.get<PendingRecord>(authReqIdKey(authReqId))
    // §3.5 — idempotent. Unknown / already-cancelled / already-approved
    // all collapse into 204 No Content without revealing which case applied.
    if (!record || record.status !== 'pending') return new Response(null, { status: 204 })

    const request = c.req.raw
    const declaredPubkey = request.headers.get('urpc-public-key')
    if (!declaredPubkey)
      return c.json(
        { error: 'invalid_request', error_description: 'missing `uRPC-Public-Key`' },
        { status: 400 },
      )

    if (declaredPubkey !== record.consumer.publicKey)
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'uRPC-Public-Key does not match registered consumer identity_pubkey',
        },
        { status: 401 },
      )

    const expectedKeyid = identityKeyid(record.consumer.origin)
    try {
      assertSignatureKeyid(request, expectedKeyid)
    } catch (cause) {
      return c.json(
        { error: 'unauthorized', error_description: (cause as Error).message },
        { status: 401 },
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
        publicKey: base64urlToHex(record.consumer.publicKey),
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
    const nonceError = await consumeSignatureNonce(request, record.consumer.publicKey)
    if (nonceError)
      return c.json(
        { error: 'unauthorized', error_description: nonceError },
        { status: 401 },
      )

    record.status = 'cancelled'
    await persist(record)
    return new Response(null, { status: 204 })
  })

  app.get('/verify', async (c) => {
    const code = c.req.query('code') ?? undefined
    if (!code) return await html.render({ record: undefined, request: c.req.raw, code })

    const record = await store.get<PendingRecord>(codeKey(code))
    if (!record || record.status !== 'pending') return invalidVerificationUriResponse()
    if (Date.now() >= record.expiresAt) {
      record.status = 'cancelled'
      await persist(record)
      return invalidVerificationUriResponse()
    }

    return await html.render({ record, request: c.req.raw, code })
  })

  app.post('/verify', async (c) => {
    const code = c.req.query('code') ?? undefined
    const request = c.req.raw
    const metadataError = approvalMetadataError(request, new URL(resolveBaseUrl(c.req.url)).origin)
    if (metadataError)
      return c.json({ error: 'forbidden', error_description: metadataError }, { status: 403 })

    const record = code ? await store.get<PendingRecord>(codeKey(code)) : undefined
    const pendingRecord =
      record && record.status === 'pending' && Date.now() < record.expiresAt ? record : undefined

    if (html.authenticate) {
      const authResponse = await html.authenticate({
        actions,
        record: pendingRecord,
        request: request.clone(),
        code,
      })
      if (authResponse) return authResponse
    }

    if (!code)
      return c.json(
        { error: 'invalid_request', error_description: 'missing `code` query parameter' },
        { status: 400 },
      )
    if (!record)
      return c.json(
        { error: 'not_found', error_description: 'unknown or expired approval request' },
        { status: 404 },
      )
    if (record.status !== 'pending')
      return c.json(
        { error: 'conflict', error_description: 'approval request is no longer pending' },
        { status: 409 },
      )
    if (Date.now() >= record.expiresAt) {
      record.status = 'cancelled'
      await persist(record)
      return c.json(
        { error: 'conflict', error_description: 'approval request expired' },
        { status: 409 },
      )
    }

    const bodyText = await request.text()
    let responseEnvelope: Extract<Envelope.Envelope, { type: 'rpc-responses' }>
    try {
      const envelope = Envelope.parse(JSON.parse(bodyText))
      if (envelope.type !== 'rpc-responses')
        throw new Errors.ProtocolError('approval body must be an `rpc-responses` envelope')
      responseEnvelope = envelope
    } catch (cause) {
      return c.json(
        { error: 'invalid_request', error_description: (cause as Error).message },
        { status: 400 },
      )
    }

    const correlationError = validateApprovalResponse(record, responseEnvelope)
    if (correlationError)
      return c.json(
        { error: 'invalid_request', error_description: correlationError },
        { status: 400 },
      )

    let consumedRecord: PendingRecord
    try {
      consumedRecord = await consumePendingRecord(code, record.authReqId)
    } catch (cause) {
      if (cause instanceof ApprovalConflictError)
        return c.json({ error: 'conflict', error_description: cause.message }, { status: 409 })
      throw cause
    }

    await settleWithResponse(consumedRecord, bodyText)
    return c.json({ closeTab: true })
  })

  const { fetch, listener } = Http.fromHono(app)

  // ── outbound webhook delivery ───────────────────────────────────────

  /**
   * Sign and POST the approval-surface `rpc-responses` body to the
   * consumer's pre-registered `webhook_url` under the host's identity key.
   */
  async function deliverOnce(
    record: PendingRecord,
    body: string,
    response: Envelope.Envelope,
  ): Promise<DeliveryAttempt> {
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
      return {
        error: new Transport.TransportError(
          `webhook delivery failed: ${(cause as Error).message}`,
          {
            cause: cause as Error,
          },
        ),
        retryable: true,
        type: 'failed',
      }
    }
    // §5.9 / §3.4.3 — never follow 3xx redirects.
    if (httpResponse.status >= 300 && httpResponse.status < 400)
      return {
        error: new Transport.TransportError(
          `webhook delivery refused — cross-origin / same-origin redirect ${httpResponse.status} forbidden`,
        ),
        retryable: true,
        type: 'failed',
      }
    if (!httpResponse.ok)
      return {
        error: new Transport.TransportError(
          `webhook delivery returned non-2xx status ${httpResponse.status}`,
        ),
        retryable:
          httpResponse.status === 408 || httpResponse.status === 429 || httpResponse.status >= 500,
        type: 'failed',
      }
    await completeDelivery(record, body, response)
    return { type: 'delivered' }
  }

  async function deliverWithRetry(
    record: PendingRecord,
    body: string,
    response: Envelope.Envelope,
  ): Promise<void> {
    const settledAt = record.settledAt ?? Date.now()
    const deadline = settledAt + record.retrySeconds * 1000
    let attempt = 0
    for (;;) {
      const current = await store.get<PendingRecord>(authReqIdKey(record.authReqId))
      if (!current || current.status === 'delivered' || current.status === 'undeliverable') return
      if (current.status !== 'approved' && current.status !== 'denied') return
      if (Date.now() >= deadline) {
        current.status = 'undeliverable'
        await persist(current)
        return
      }

      const result = await deliverOnce(current, body, response)
      if (result.type === 'delivered') return
      emitter.emit('error', result.error)
      if (!result.retryable) {
        current.status = 'undeliverable'
        await persist(current)
        return
      }

      const delay = deliveryRetryDelay(attempt)
      attempt += 1
      if (Date.now() + delay >= deadline) {
        current.status = 'undeliverable'
        await persist(current)
        return
      }
      await sleep(delay)
    }
  }

  function scheduleDelivery(
    record: PendingRecord,
    body: string,
    response: Envelope.Envelope,
  ): void {
    void deliverWithRetry(record, body, response).catch((cause) => {
      emitter.emit('error', cause as Error)
    })
  }

  async function persist(record: PendingRecord): Promise<void> {
    const retentionUntil =
      record.status === 'pending'
        ? record.expiresAt + record.retrySeconds * 1000
        : (record.settledAt ?? Date.now()) + record.retrySeconds * 1000
    const ttl = Math.ceil(Math.max(60, (retentionUntil - Date.now()) / 1000))
    await store.set(codeKey(record.code), record, { ttl })
    await store.set(authReqIdKey(record.authReqId), record, { ttl })
  }

  async function completeDelivery(
    record: PendingRecord,
    body: string,
    response: Envelope.Envelope,
  ): Promise<void> {
    const current = await take<PendingRecord>(authReqIdKey(record.authReqId))
    if (!current) return
    if (current.status !== 'approved' && current.status !== 'denied') {
      await persist(current)
      return
    }
    current.response = response
    current.responseBody = body
    current.status = 'delivered'
    await persist(current)
  }

  async function consumeSignatureNonce(
    request: Request,
    publicKey: string,
  ): Promise<string | undefined> {
    let parsedInput: MessageSig.ParsedSignatureInput
    try {
      parsedInput = MessageSig.parseSignatureInput(request.headers.get('signature-input') ?? '')
    } catch (cause) {
      return (cause as Error).message
    }
    const nonce = parsedInput.parameters.nonce
    if (!nonce) return 'missing signature nonce'
    const key = signatureNonceKey(publicKey, nonce)
    if (await store.get(key)) return 'replay detected'
    await store.set(key, true, { ttl: signatureNonceTtl })
    return undefined
  }

  async function requirePendingRecord(code: string): Promise<PendingRecord> {
    const record = await store.get<PendingRecord>(codeKey(code))
    if (!record) throw new UnknownCodeError(code)
    if (record.status !== 'pending')
      throw new Transport.TransportError('approval request is no longer pending')
    if (Date.now() >= record.expiresAt) {
      record.status = 'cancelled'
      await persist(record)
      throw new Transport.TransportError('approval request expired')
    }
    return record
  }

  async function consumePendingRecord(
    code: string,
    expectedAuthReqId: string,
  ): Promise<PendingRecord> {
    const record = await take<PendingRecord>(codeKey(code))
    if (!record) throw new ApprovalConflictError('approval request is no longer pending')
    if (record.authReqId !== expectedAuthReqId) {
      await persist(record)
      throw new ApprovalConflictError('approval request is no longer pending')
    }
    if (record.status !== 'pending') {
      await persist(record)
      throw new ApprovalConflictError('approval request is no longer pending')
    }
    if (Date.now() >= record.expiresAt) {
      record.status = 'cancelled'
      await persist(record)
      throw new ApprovalConflictError('approval request expired')
    }
    return record
  }

  function assertValidResponseBody(record: PendingRecord, responseBody: html.ResponseBody): void {
    const { envelope } = parseResponseBody(responseBody)
    const correlationError = validateApprovalResponse(record, envelope)
    if (correlationError) throw new Errors.ProtocolError(correlationError)
  }

  async function settleWithResponse(
    record: PendingRecord,
    responseBody: html.ResponseBody,
  ): Promise<void> {
    const { body, envelope } = parseResponseBody(responseBody)
    const correlationError = validateApprovalResponse(record, envelope)
    if (correlationError) throw new Errors.ProtocolError(correlationError)
    record.response = envelope
    record.responseBody = body
    record.settledAt = Date.now()
    record.status = isDeniedResponse(envelope) ? 'denied' : 'approved'
    await persist(record)
    scheduleDelivery(record, body, envelope)
  }

  function activateDispatch(record: PendingRecord): void {
    for (const id of requestIdsFor(record))
      state.activeAuthReqIds.set(rpcIdKey(id), record.authReqId)
  }

  function deactivateDispatch(record: PendingRecord): void {
    for (const id of requestIdsFor(record)) {
      const key = rpcIdKey(id)
      if (state.activeAuthReqIds.get(key) === record.authReqId) state.activeAuthReqIds.delete(key)
    }
  }

  function resolveActiveAuthReqId(envelope: Envelope.Envelope): string | undefined {
    if (envelope.type !== 'rpc-responses') return undefined
    let authReqId: string | undefined
    for (const response of envelope.payload) {
      if (response.id === null) continue
      const next = state.activeAuthReqIds.get(rpcIdKey(response.id))
      if (!next) continue
      if (authReqId && authReqId !== next)
        throw new Transport.TransportError('response envelope spans multiple auth_req_id values')
      authReqId = next
    }
    return authReqId
  }

  return {
    bind(binding) {
      const { baseUrl, identity } = binding
      if (baseUrl && !baseUrl_ctor && !baseUrl_bound) baseUrl_bound = Uri.trimTrailingSlash(baseUrl)
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
      const authReqId = resolveActiveAuthReqId(envelope)
      if (!authReqId)
        throw new Transport.TransportError(
          'no active auth_req_id for response; `transport.send` was called before any approval',
        )
      const record = await store.get<PendingRecord>(authReqIdKey(authReqId))
      if (!record)
        throw new Transport.ClosedError(
          'pending intent disappeared from store before response delivery',
        )
      try {
        if (envelope.type !== 'rpc-responses')
          throw new Transport.TransportError(
            `webhook-callback transport only sends rpc-responses envelopes; received \`${envelope.type}\``,
          )
        const correlationError = validateApprovalResponse(record, envelope)
        if (correlationError) throw new Errors.ProtocolError(correlationError)
        const body = JSON.stringify(envelope)
        record.response = envelope
        record.responseBody = body
        record.settledAt ??= Date.now()
        await persist(record)
        scheduleDelivery(record, body, envelope)
      } finally {
        // `single_exchange` is per `auth_req_id`, not per transport
        // lifetime: the wallet server is long-running and handles
        // many sequential intents. Clear the slot so the next
        // approval can dispatch through, but keep the transport open.
        deactivateDispatch(record)
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

function isAllowedWebhookUrl(url: URL, hostUrl: URL): boolean {
  if (isReservedHost(url.hostname))
    return (
      isLoopbackHost(url.hostname) &&
      isLoopbackHost(hostUrl.hostname) &&
      (url.protocol === 'http:' || url.protocol === 'https:')
    )
  if (url.protocol === 'https:') return true
  return false
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function isReservedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isLoopbackHost(host)) return true
  const ipv4 = parseIpv4(host)
  if (ipv4) {
    const [a, b, c, d] = ipv4
    if (a === 0) return true
    if (a === 10) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0 && c === 2) return true
    if (a === 198 && b === 51 && c === 100) return true
    if (a === 203 && b === 0 && c === 113) return true
    if (a >= 224) return true
    if (a === 255 && b === 255 && c === 255 && d === 255) return true
    return false
  }
  if (host === '::') return true
  if (host.startsWith('fe80:')) return true
  if (host.startsWith('fc') || host.startsWith('fd')) return true
  if (host.startsWith('ff')) return true
  if (host.startsWith('2001:db8:')) return true
  return host === 'fd00:ec2::254'
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split('.')
  if (parts.length !== 4) return undefined
  const bytes = parts.map((part) => Number(part))
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined
  return bytes as [number, number, number, number]
}

function codeKey(code: string): string {
  return `webhook:code:${code}`
}

function authReqIdKey(authReqId: string): string {
  return `webhook:authReqId:${authReqId}`
}

function signatureNonceKey(publicKey: string, nonce: string): string {
  return `webhook:signatureNonce:${publicKey}:${nonce}`
}

function generateOpaque(byteCount: number): string {
  return Base64.fromBytes(Bytes.random(byteCount), { pad: false, url: true })
}

function deliveryRetryDelay(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** Math.min(attempt, 5))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validateApprovalResponse(
  record: PendingRecord,
  response: Extract<Envelope.Envelope, { type: 'rpc-responses' }>,
): string | undefined {
  if (record.message.type !== 'rpc-requests')
    return 'pending intent is not an `rpc-requests` envelope'

  const expected = new Map<string, Rpc.Id>()
  for (const request of record.message.payload) {
    if (!('id' in request)) continue
    expected.set(rpcIdKey(request.id), request.id)
  }
  if (expected.size === 0) return 'pending intent contains no JSON-RPC requests to correlate'

  const seen = new Set<string>()
  for (const item of response.payload) {
    if (item.id === null) return 'response id `null` does not correlate to a queued request'
    const key = rpcIdKey(item.id)
    if (!expected.has(key)) return `response id ${formatRpcId(item.id)} is not queued`
    if (seen.has(key)) return `response id ${formatRpcId(item.id)} appears more than once`
    seen.add(key)
  }
  for (const [key, id] of expected) {
    if (!seen.has(key)) return `missing response for request id ${formatRpcId(id)}`
  }
  return undefined
}

function parseResponseBody(responseBody: html.ResponseBody): {
  body: string
  envelope: Extract<Envelope.Envelope, { type: 'rpc-responses' }>
} {
  const body = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)
  const envelope = Envelope.parse(
    typeof responseBody === 'string' ? JSON.parse(body) : responseBody,
  )
  if (envelope.type !== 'rpc-responses')
    throw new Errors.ProtocolError('approval body must be an `rpc-responses` envelope')
  return { body, envelope }
}

function invalidVerificationUriResponse(): Response {
  return Response.json(
    { error: 'gone', error_description: 'approval request is no longer available' },
    { status: 410 },
  )
}

function deniedResponseFor(
  record: PendingRecord,
): Extract<Envelope.Envelope, { type: 'rpc-responses' }> {
  return Envelope.rpcResponses(
    requestIdsFor(record).map((id) =>
      Rpc.error({
        code: -32000,
        id,
        message: 'denied by user',
      }),
    ),
  )
}

function approvalMetadataError(request: Request, expectedOrigin: string): string | undefined {
  const origin = request.headers.get('origin')
  if (origin && origin !== expectedOrigin) return 'approval origin does not match host origin'

  const referer = request.headers.get('referer')
  if (!origin) {
    if (!referer) return 'approval submission must include a same-origin `Origin` or `Referer`'
    const refererOrigin = (() => {
      try {
        return new URL(referer).origin
      } catch {
        return undefined
      }
    })()
    if (refererOrigin !== expectedOrigin) return 'approval referer does not match host origin'
  }

  if (request.headers.get('sec-fetch-user') === '?0')
    return 'approval submission requires an explicit user gesture'
  return undefined
}

function requestIdsFor(record: PendingRecord): Rpc.Id[] {
  if (record.message.type !== 'rpc-requests') return []
  const ids: Rpc.Id[] = []
  for (const request of record.message.payload) if ('id' in request) ids.push(request.id)
  return ids
}

function isDeniedResponse(
  response: Extract<Envelope.Envelope, { type: 'rpc-responses' }>,
): boolean {
  return response.payload.every(
    (item) =>
      'error' in item && item.error.code === -32000 && item.error.message === 'denied by user',
  )
}

function rpcIdKey(id: Rpc.Id): string {
  return `${typeof id}:${String(id)}`
}

function formatRpcId(id: Rpc.Id): string {
  return typeof id === 'string' ? JSON.stringify(id) : String(id)
}

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

const approvalSurfaceCsp = [
  "default-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "style-src 'self' 'unsafe-inline'",
].join('; ')

const signatureNonceTtl = 86400

function assertSignatureKeyid(request: Request, expectedKeyid: string): void {
  const parsedInput = MessageSig.parseSignatureInput(request.headers.get('signature-input') ?? '')
  if (parsedInput.parameters.keyid !== expectedKeyid)
    throw new MessageSig.InvalidSignatureError(
      `signature keyid mismatch: expected \`${expectedKeyid}\`, received \`${parsedInput.parameters.keyid ?? '<missing>'}\``,
    )
}

function base64urlToHex(value: string): Hex.Hex {
  return Hex.fromBytes(Base64.toBytes(value))
}

/** Thrown when a supplied code does not match any pending record. */
export class UnknownCodeError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'WebhookCallback.UnknownCodeError'

  constructor(code: string, options: Errors.BaseError.Options<cause> = {} as never) {
    super(`no pending intent for code \`${code}\``, options)
  }
}

/** Thrown when an approval code has already been consumed. */
export class ApprovalConflictError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'WebhookCallback.ApprovalConflictError'
}
