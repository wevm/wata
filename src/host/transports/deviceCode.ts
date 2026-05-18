/**
 * Host-side `device-code` transport — HTTP-server-shaped, single-exchange.
 *
 * Implements the host half of the uRPC `device-code` transport spec.
 * Routing is handled by an internal `Hono` sub-app mounted at
 * {@link Options.path}; consumers never see Hono in the public type
 * surface — they get web-standard primitives:
 *
 * - {@link DeviceCode.fetch} — `(req: Request) => Promise<Response>`.
 *   The canonical fetch-style handler. Same code runs on Cloudflare
 *   Workers, Bun, Deno, Vercel Edge, or `Hono` mounted at any path.
 * - {@link DeviceCode.listener} — Node `http.RequestListener`
 *   adapter, powered by `@hono/node-server`'s `getRequestListener`.
 *
 * Routes (all under {@link Options.path}, defaults to `/`):
 *
 * | Route             | Handled by transport | Purpose |
 * |-------------------|----------------------|---------|
 * | `POST /register`  | yes                  | Consumer registers an authorization intent. |
 * | `POST /token`     | yes                  | Consumer polls for the host's response. |
 * | `GET  /verify`    | via {@link html.render}      | Renders the user's approval UI. |
 * | `POST /verify`    | via {@link html.authenticate} | Handles the user's approval submission. |
 *
 * The verification UI is intentionally bring-your-own — the host owns the
 * approval page (login state, branding, phishing wording, etc.), the
 * transport owns routing, PKCE, and the device-code lifecycle.
 *
 * @example minimal Node host
 * ```ts
 * import { createServer } from 'node:http'
 * import { Wata, Kv, deviceCode } from 'wata/host'
 *
 * const transport = deviceCode({
 *   store: Kv.memory(),
 *   baseUrl: 'https://wallet.example',
 *   path: '/auth/device',
 *   html: {
 *     render: ({ userCode }) => new Response(`<form>...code=${userCode ?? ''}</form>`, { headers: { 'content-type': 'text/html' } }),
 *     authenticate: async ({ request, actions }) => {
 *       const body = await request.formData()
 *       await actions.approve(String(body.get('user_code')))
 *       return new Response('approved')
 *     },
 *   },
 * })
 *
 * const wata = Wata.create({ transport })
 * wata.on('request', async (event) => {
 *   await event.respond({ ok: true })
 * })
 *
 * createServer(transport.listener).listen(3000)
 * ```
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { Hono } from 'hono'
import { Base64, Bytes } from 'ox'

import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Http from '../../core/Http.js'
import * as Kv from '../../core/Kv.js'
import * as Transport from '../../core/Transport.js'
import * as Uri from '../../internal/Uri.js'

/** Persisted device-code lifecycle record. */
export type PendingRecord = {
  /** PKCE challenge (`base64url(SHA-256(code_verifier))`). */
  codeChallenge: string
  /** PKCE challenge method. v1 only allows `S256`. */
  codeChallengeMethod: 'S256'
  /**
   * Optional `consumer.json` URL supplied by the consumer at
   * `/register` time. When set and no inline `meta` is present, the
   * host fetches this once via {@link Discovery.fetchConsumer} to read
   * the consumer's `meta` block. `undefined` when the consumer didn't
   * advertise one.
   */
  consumerUrl?: string | undefined
  /** Epoch-ms creation. */
  createdAt: number
  /** Random opaque identifier the consumer holds and presents on `/token`. */
  deviceCode: string
  /** Epoch-ms expiry. */
  expiresAt: number
  /**
   * Epoch-ms of the most recent `/token` poll for this `device_code`,
   * used by the `slow_down` rate limiter (RFC 8628 §3.5). `undefined`
   * before the first poll.
   */
  lastPolledAt?: number | undefined
  /**
   * Inline {@link Discovery.Meta} supplied by the consumer at
   * `/register` time. Takes precedence over any `meta` resolved
   * lazily from `consumerUrl`. `undefined` when the consumer didn't
   * advertise inline meta.
   */
  meta?: Discovery.Meta | undefined
  /** Pending JSON-RPC `rpc-requests` envelope queued by the consumer. */
  message: Envelope.Envelope
  /** Host's `rpc-responses` envelope, populated once the user approves. */
  response?: Envelope.Envelope | undefined
  /** Lifecycle status. Terminal values are `approved`, `denied`, `expired`. */
  status: 'pending' | 'approved' | 'denied' | 'expired'
  /** Short human-typed identifier the user enters on the approval page. */
  userCode: string
}

/** Options accepted by {@link deviceCode}. */
export type Options = {
  /**
   * Public origin of the host (e.g. `https://wallet.example`). Combined
   * with {@link path} to derive the `verification_uri` returned to the
   * consumer in the `/register` response. Strips a trailing slash.
   *
   * Optional — when omitted, the transport falls back to the incoming
   * request's URL origin. The parent `Wata.create({ baseUrl })` also
   * lazy-injects its own value through {@link Transport.Transport.bind}.
   * A constructor-level value wins over both fallbacks; reach for it
   * in multi-tenant servers where each tenant has a fixed origin.
   */
  baseUrl?: string | undefined
  /**
   * Authorization intent lifetime in seconds. Records past `expiresAt`
   * are GC'd lazily on next access and surface as `410 Gone` on
   * `/token`. Defaults to 600 (10 minutes).
   */
  expiresIn?: number | undefined
  /**
   * Override the `fetch` implementation used for the discovery-based
   * `consumer.json` fallback. Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch | undefined
  /** Bring-your-own verification UI hooks. See {@link html}. */
  html: html.Hooks
  /**
   * Path prefix for the four device-code routes. Defaults to `/` so the
   * routes are `POST /register`, `POST /token`, `GET /verify`,
   * `POST /verify`. Set to `/auth/device` to mount under
   * `/auth/device/...` and to derive `verification_uri` as
   * `${baseUrl}/auth/device/verify`.
   */
  path?: string | undefined
  /**
   * Suggested poll interval (milliseconds) returned to the consumer in
   * the `/register` response (converted to seconds on the wire to
   * match RFC 8628 §3.2). Consumers MUST honour the larger of this
   * value and any `slow_down`-derived cadence (RFC 8628 §3.5).
   * Defaults to 5000, matching the RFC 8628 §3.5 default that
   * consumers apply when the host omits `interval`.
   */
  pollingInterval?: number | undefined
  /** Pluggable persistence for {@link PendingRecord}s. Use {@link Kv.memory} for tests. */
  store: Kv.Kv
}

export declare namespace html {
  /** Bring-your-own approval UI hooks. */
  type Hooks = {
    /**
     * Called for `POST /verify`. Inspect the `request` (typically a form
     * POST with `user_code`, plus your own auth fields), then call
     * `actions.approve(userCode)` or `actions.deny(userCode)` and return
     * a `Response` describing what to show the user.
     */
    authenticate: (options: authenticate.Options) => Response | Promise<Response>
    /**
     * Called for `GET /verify`. Receive the requested `user_code` (URL
     * `?user_code=...`), the resolved {@link PendingRecord} (when present
     * and pending), and return the HTML form / JSON / whatever you want
     * to show the user. Return any web-standard `Response`.
     */
    render: (options: render.Options) => Response | Promise<Response>
  }

  namespace render {
    /** Argument passed to {@link html.Hooks.render}. */
    type Options = {
      /**
       * Resolved {@link Discovery.Meta} for the pending consumer, if
       * any. Resolution order: inline `meta` on the queued register
       * payload wins; otherwise fetched lazily from the consumer's
       * `consumer_url` via {@link Discovery.fetchConsumer}. `undefined`
       * when the consumer advertised neither.
       */
      meta: Discovery.Meta | undefined
      /** Pending {@link PendingRecord} for `userCode`, if found. */
      record: PendingRecord | undefined
      /** The original `Request` passed to `transport.fetch`. */
      request: Request
      /** `user_code` from the URL query (`?user_code=...`), if any. */
      userCode: string | undefined
    }
  }

  namespace authenticate {
    /** Argument passed to {@link html.Hooks.authenticate}. */
    type Options = {
      /**
       * Approve / deny / look up actions exposed to the host's auth
       * handler. Approve / deny mutate the persisted {@link PendingRecord}
       * and trigger the host-side `'request'` dispatch. Idempotent —
       * calling `approve` twice is a no-op after the first.
       */
      actions: Actions
      /** The form-POST `Request` from the user-agent. */
      request: Request
    }
  }

  /** Actions exposed inside {@link html.Hooks.authenticate}. */
  type Actions = {
    /**
     * Mark the device-code as approved. The transport then emits the
     * pending `rpc-requests` envelope as a `'message'` event so the
     * host-side `Wata` dispatches it and produces a response.
     */
    approve: (userCode: string) => Promise<void>
    /**
     * Mark the device-code as denied. The transport emits a JSON-RPC
     * `-32001` error response back to the consumer for every queued
     * request and tears the session down.
     */
    deny: (userCode: string) => Promise<void>
    /** Look up the {@link PendingRecord} associated with a `user_code`. */
    get: (userCode: string) => Promise<PendingRecord | undefined>
  }
}

/** `transport.fetch` / `transport.listener`-augmented {@link Transport.Transport}. */
export type DeviceCode = Transport.Transport<'host'> & Http.Server

/**
 * Create a host-side `device-code` transport.
 *
 * @example
 * ```ts
 * import { Wata, Kv, deviceCode } from 'wata/host'
 *
 * const transport = deviceCode({
 *   store: Kv.memory(),
 *   baseUrl: 'https://wallet.example',
 *   path: '/auth/device',
 *   html: { render, authenticate },
 * })
 * ```
 */
export function deviceCode(options: Options): DeviceCode {
  const {
    expiresIn = 600,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    html,
    path,
    pollingInterval = 5000,
    store,
  } = options

  // Constructor-level `baseUrl` is sticky and wins over any later
  // `bind()` call from a wrapping `Wata.create({ baseUrl })`.
  // When neither is set, the request-handler falls back to the
  // incoming request URL's origin.
  const baseUrl_ctor = options.baseUrl ? Uri.trimTrailingSlash(options.baseUrl) : undefined
  let baseUrl_bound: string | undefined

  function resolveBaseUrl(requestUrl: string): string {
    if (baseUrl_ctor) return baseUrl_ctor
    if (baseUrl_bound) return baseUrl_bound
    return new URL(requestUrl).origin
  }

  function verificationUriFor(requestUrl: string): string {
    return `${resolveBaseUrl(requestUrl)}${path ?? ''}/verify`
  }

  const emitter = Events.create<Transport.EventMap>()

  // Single-exchange transport: tracks the in-flight device_code so the
  // user-supplied `'request'` listener's response is keyed back to the
  // correct pending record on `transport.send()`.
  type State = { activeDeviceCode: string | undefined; closed: boolean; started: boolean }
  const state: State = {
    activeDeviceCode: undefined,
    closed: false,
    started: false,
  }

  const actions: html.Actions = {
    async approve(userCode) {
      const record = await store.get<PendingRecord>(userCodeKey(userCode))
      if (!record) throw new UnknownUserCodeError(userCode)
      // Idempotent — a second `approve` after approval is a no-op.
      if (record.status !== 'pending') return
      record.status = 'approved'
      await store.set(deviceCodeKey(record.deviceCode), record)
      await store.set(userCodeKey(record.userCode), record)
      // Hand the queued requests to `Wata` for dispatch. The
      // host-side `'request'` listener responds via `transport.send`,
      // which is keyed back to this `device_code`.
      state.activeDeviceCode = record.deviceCode
      emitter.emit('message', record.message)
    },
    async deny(userCode) {
      const record = await store.get<PendingRecord>(userCodeKey(userCode))
      if (!record) throw new UnknownUserCodeError(userCode)
      if (record.status !== 'pending') return
      record.status = 'denied'
      await store.set(deviceCodeKey(record.deviceCode), record, { ttl: 60 })
      await store.set(userCodeKey(record.userCode), record, { ttl: 60 })
    },
    async get(userCode) {
      return await store.get<PendingRecord>(userCodeKey(userCode))
    },
  }

  // Build the Hono sub-app. The base path defaults to `''` (mount at the
  // root of whatever the caller hands `transport.fetch`) but callers can
  // also keep their own router and mount under any prefix they want.
  const app = path ? new Hono().basePath(path) : new Hono()

  // RFC 8628 §3.2 / §3.5 (via RFC 6749 §5.1, §5.2) and uRPC Device
  // Code §6.7 — every registration, token, and verification response
  // MUST set `Cache-Control: no-store` and `Pragma: no-cache` so that
  // intermediaries (CDNs, reverse proxies, browser caches) cannot
  // cache them. Apply via global middleware so every route, including
  // the `onError` 500 fallback, gets the headers.
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
    c.res.headers.set('Pragma', 'no-cache')
  })

  app.onError((cause, c) => {
    emitter.emit('error', cause as Error)
    return c.json(
      { error: 'server_error', error_description: (cause as Error).message },
      { status: 500 },
    )
  })

  app.post('/register', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | {
          code_challenge?: unknown
          code_challenge_method?: unknown
          consumer_url?: unknown
          message?: unknown
          meta?: unknown
        }
      | undefined
    if (!body || typeof body !== 'object')
      return c.json(
        { error: 'invalid_request', error_description: 'expected JSON object body' },
        { status: 400 },
      )
    if (typeof body.code_challenge !== 'string' || body.code_challenge.length === 0)
      return c.json(
        { error: 'invalid_request', error_description: 'expected non-empty `code_challenge`' },
        { status: 400 },
      )
    if (body.code_challenge_method !== 'S256')
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'expected `code_challenge_method` of `S256`',
        },
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

    // Validate inline `meta` against the discovery schema so a
    // malformed metadata block fails fast (and isn't surfaced to the
    // host's approval UI in a half-broken shape).
    let meta: Discovery.Meta | undefined
    if (body.meta !== undefined) {
      try {
        meta = Discovery.schema.meta.parse(body.meta)
      } catch (cause) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `invalid \`meta\`: ${(cause as Error).message}`,
          },
          { status: 400 },
        )
      }
    }
    // `consumer_url` is purely a discovery hint — validated as a
    // string here, fetched/parsed lazily on the verification page.
    let consumerUrl: string | undefined
    if (body.consumer_url !== undefined) {
      if (typeof body.consumer_url !== 'string')
        return c.json(
          {
            error: 'invalid_request',
            error_description: '`consumer_url` must be a string',
          },
          { status: 400 },
        )
      consumerUrl = body.consumer_url
    }

    const deviceCodeValue = generateDeviceCode()
    const userCodeValue = generateUserCode()
    const now = Date.now()
    const record: PendingRecord = {
      codeChallenge: body.code_challenge,
      codeChallengeMethod: 'S256',
      createdAt: now,
      deviceCode: deviceCodeValue,
      expiresAt: now + expiresIn * 1000,
      message: envelope,
      status: 'pending',
      userCode: userCodeValue,
      ...(consumerUrl ? { consumerUrl } : {}),
      ...(meta ? { meta } : {}),
    }

    await store.set(deviceCodeKey(deviceCodeValue), record, { ttl: expiresIn })
    await store.set(userCodeKey(userCodeValue), record, { ttl: expiresIn })

    const verificationUri = verificationUriFor(c.req.url)
    return c.json({
      device_code: deviceCodeValue,
      expires_in: expiresIn,
      interval: Math.max(1, Math.round(pollingInterval / 1000)),
      user_code: userCodeValue,
      verification_uri: verificationUri,
      verification_uri_complete: appendUserCode(verificationUri, userCodeValue),
    })
  })

  app.post('/token', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { code_verifier?: unknown; device_code?: unknown; grant_type?: unknown }
      | undefined
    if (!body || typeof body !== 'object')
      return c.json(
        { error: 'invalid_request', error_description: 'expected JSON object body' },
        { status: 400 },
      )
    // RFC 8628 §3.4 + uRPC §3.3.1 — `grant_type` is REQUIRED and must
    // be exactly the device-code grant URN. Validate before any
    // device-code lookup so malformed callers cannot probe for
    // identifiers.
    if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code')
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'expected `grant_type` of `urn:ietf:params:oauth:grant-type:device_code`',
        },
        { status: 400 },
      )
    if (typeof body.device_code !== 'string' || body.device_code.length === 0)
      return c.json(
        { error: 'invalid_request', error_description: 'expected non-empty `device_code`' },
        { status: 400 },
      )
    if (typeof body.code_verifier !== 'string' || body.code_verifier.length === 0)
      return c.json(
        { error: 'invalid_request', error_description: 'expected non-empty `code_verifier`' },
        { status: 400 },
      )

    // RFC 8628 §3.5 + uRPC §3.3.2 step 1 — unknown, expired, or
    // already-consumed `device_code`s collapse into a single response
    // (`400` + `{ error: "expired_token" }`) so the host doesn't leak
    // which polling identifiers were once valid.
    const record = await store.get<PendingRecord>(deviceCodeKey(body.device_code))
    if (!record) return c.json({ error: 'expired_token' }, { status: 400 })

    if (Date.now() >= record.expiresAt) {
      await store.delete(deviceCodeKey(record.deviceCode))
      await store.delete(userCodeKey(record.userCode))
      return c.json({ error: 'expired_token' }, { status: 400 })
    }

    // PKCE verification — must be checked on every poll, atomically with
    // the response delivery, so a leaked `device_code` alone can't be
    // used to fetch the response without the consumer's `code_verifier`.
    const computed = pkceChallenge(body.code_verifier)
    if (!constantTimeEqual(computed, record.codeChallenge))
      // RFC 7636 §4.6 + uRPC §3.3.2 step 3 — PKCE failure returns
      // `400` + `{ error: "invalid_grant" }`. Diagnostic text goes in
      // `error_description` per RFC 6749 §5.2; the non-standard
      // `message` field MUST NOT be used.
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'PKCE verifier does not match recorded challenge',
        },
        { status: 400 },
      )

    if (record.status === 'pending') {
      // RFC 8628 §3.5 — `slow_down` is a variant of
      // `authorization_pending` returned when the consumer polls faster
      // than the advertised cadence. Heuristic: a poll arriving within
      // half of the registration `interval` of the previous poll for
      // this `device_code` is "too fast". Always update `lastPolledAt`
      // before responding so the next poll measures from this moment.
      const now = Date.now()
      const pollingIntervalMs = pollingInterval
      const last = record.lastPolledAt
      const tooFast = last !== undefined && now - last < pollingIntervalMs / 2
      record.lastPolledAt = now
      await store.set(deviceCodeKey(record.deviceCode), record)
      await store.set(userCodeKey(record.userCode), record)
      if (tooFast) return c.json({ error: 'slow_down' }, { status: 400 })
      // RFC 8628 §3.5 — pending polls return `400` + the OAuth-style
      // `{ error: "authorization_pending" }`. The polling cadence is
      // carried in `/register`'s `interval`, not echoed here.
      return c.json({ error: 'authorization_pending' }, { status: 400 })
    }
    if (record.status === 'denied')
      // RFC 8628 §3.5 — denied polls return `400` + the OAuth-style
      // `{ error: "access_denied" }`. Body MUST NOT carry any other
      // field; the human-readable text belongs in `error_description`
      // if present at all.
      return c.json({ error: 'access_denied' }, { status: 400 })
    if (record.status === 'expired') return c.json({ error: 'expired_token' }, { status: 400 })

    if (!record.response)
      return c.json(
        { error: 'server_error', error_description: 'approved but no response queued' },
        { status: 500 },
      )

    // Terminal: deliver the response, clean up the record. Subsequent
    // `transport.send()` rejects with `ClosedError` because the host
    // side already settled the exchange via `send()`.
    await store.delete(deviceCodeKey(record.deviceCode))
    await store.delete(userCodeKey(record.userCode))
    return c.json(record.response)
  })

  app.get('/verify', async (c) => {
    const userCode = c.req.query('user_code') ?? undefined
    const record = userCode ? await store.get<PendingRecord>(userCodeKey(userCode)) : undefined
    const pendingRecord = record && record.status === 'pending' ? record : undefined
    const meta = await resolveMeta(pendingRecord)
    return await html.render({
      meta,
      record: pendingRecord,
      request: c.req.raw,
      userCode,
    })
  })

  app.post('/verify', (c) => html.authenticate({ actions, request: c.req.raw }))

  // Cache consumer-discovery lookups per pending record so repeat
  // renders of the same approval page don't refetch the consumer's
  // `consumer.json` on every keystroke.
  const consumerCache = new Map<string, Discovery.Meta | undefined>()
  async function resolveMeta(
    record: PendingRecord | undefined,
  ): Promise<Discovery.Meta | undefined> {
    if (!record) return undefined
    if (record.meta) return record.meta
    if (!record.consumerUrl) return undefined
    if (consumerCache.has(record.consumerUrl)) return consumerCache.get(record.consumerUrl)
    let resolved: Discovery.Meta | undefined
    try {
      const document = await Discovery.fetchConsumer(record.consumerUrl, { fetch: fetchImpl })
      resolved = document.name
        ? {
            name: document.name,
            ...(document.description ? { description: document.description } : {}),
            ...(document.icon ? { icon: document.icon } : {}),
            ...(document.website_url ? { websiteUrl: document.website_url } : {}),
          }
        : undefined
    } catch (cause) {
      // Surface as a transport-level error but don't block the
      // approval UI — the host can still render without `meta`.
      emitter.emit('error', cause as Error)
      resolved = undefined
    }
    consumerCache.set(record.consumerUrl, resolved)
    return resolved
  }

  // Bundle the Hono app into the standard `.fetch` + `.listener` pair
  // that every HTTP-server-shaped host transport exposes. The Node
  // `.listener` is lazy-loaded on first invocation; see
  // {@link Http.fromHono} for details.
  const { fetch, listener } = Http.fromHono(app)

  return {
    bind(binding) {
      // Constructor-level `baseUrl` wins; bound value is a one-time
      // injection from `Wata.create({ baseUrl })` and a later call
      // is a no-op so the first parent binding sticks.
      const baseUrl = binding.baseUrl
      if (!baseUrl) return
      if (baseUrl_ctor) return
      if (baseUrl_bound) return
      baseUrl_bound = Uri.trimTrailingSlash(baseUrl)
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
      emitter.emit('close', cause)
    },
    discovery: {
      binding(baseUrl) {
        const prefix = `${Uri.trimTrailingSlash(baseUrl)}${path ?? ''}`
        return { register_url: `${prefix}/register`, token_url: `${prefix}/token` }
      },
      id: 'device-code',
    },
    exchange: 'single_exchange',
    fetch,
    listener,
    on: emitter.on,
    role: 'host',
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('device-code transport already closed')
      if (!state.started) throw new Transport.ClosedError('device-code transport not started')
      const deviceCodeValue = state.activeDeviceCode
      if (!deviceCodeValue)
        throw new Transport.TransportError(
          'no active device-code; `transport.send` was called before any user approval',
        )
      const record = await store.get<PendingRecord>(deviceCodeKey(deviceCodeValue))
      if (!record)
        throw new Transport.ClosedError(
          'pending device-code disappeared from store before response delivery',
        )
      record.response = envelope
      await store.set(deviceCodeKey(record.deviceCode), record)
      await store.set(userCodeKey(record.userCode), record)
      // Single-exchange: the transport is now done. Mirror the consumer
      // side — subsequent `send()` rejects with `ClosedError`.
      state.activeDeviceCode = undefined
      state.closed = true
      emitter.emit('close', undefined)
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('device-code transport already closed')
      state.started = true
    },
  }
}

function deviceCodeKey(deviceCode: string): string {
  return `device:${deviceCode}`
}

function userCodeKey(userCode: string): string {
  return `user:${userCode.toUpperCase()}`
}

function appendUserCode(verificationUri: string, userCode: string): string {
  const url = new URL(verificationUri)
  url.searchParams.set('user_code', userCode)
  return url.toString()
}

function generateDeviceCode(): string {
  return Base64.fromBytes(Bytes.random(32), { pad: false, url: true })
}

const userCodeAlphabet = 'BCDFGHJKLMNPQRSTVWXZ'

/** 8-char Crockford-like alphabet (no vowels, no I/O/U/Y) — easy to type. */
function generateUserCode(): string {
  const buf = Bytes.random(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += userCodeAlphabet[buf[i]! % userCodeAlphabet.length]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/** PKCE challenge from `code_verifier` (`base64url(SHA-256(verifier))`). */
export function pkceChallenge(verifier: string): string {
  const digest = sha256(Bytes.fromString(verifier))
  return Base64.fromBytes(digest, { pad: false, url: true })
}

/** Length-checked constant-time string equality. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

/**
 * Thrown by {@link html.Actions} when the supplied `user_code` doesn't
 * match any pending record. Surfaces in the `html.authenticate`
 * handler so the host can show a "code not recognized" message.
 */
export class UnknownUserCodeError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'DeviceCode.UnknownUserCodeError'

  constructor(userCode: string, options: Errors.BaseError.Options<cause> = {} as never) {
    super(`no pending device-code for user_code \`${userCode}\``, options)
  }
}
