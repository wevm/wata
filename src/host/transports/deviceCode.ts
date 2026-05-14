/**
 * Host-side `device-code` transport — HTTP-server-shaped, single-exchange.
 *
 * Implements the host half of the uRPC `device-code` transport spec.
 * Routing is handled by an internal `Hono` sub-app mounted at
 * {@link Options.path}; consumers never see Hono in the public type
 * surface — they get web-standard primitives:
 *
 * - {@link DeviceCodeTransport.fetch} — `(req: Request) => Promise<Response>`.
 *   The canonical fetch-style handler. Same code runs on Cloudflare
 *   Workers, Bun, Deno, Vercel Edge, or `Hono` mounted at any path.
 * - {@link DeviceCodeTransport.listener} — Node `http.RequestListener`
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
 * import { Handshake, Kv, deviceCode } from 'handshakes/host'
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
 * const handshake = Handshake.create({ transport })
 * handshake.on('request', (event) => event.respond({ ok: true }))
 *
 * createServer(transport.listener).listen(3000)
 * ```
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { Hono } from 'hono'
import { Base64, Bytes } from 'ox'

import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Kv from '../../core/Kv.js'
import * as Transport from '../../core/Transport.js'
import * as HttpServer from './internal/HttpServer.js'

/** Persisted device-code lifecycle record. */
export type PendingRecord = {
  /** PKCE challenge (`base64url(SHA-256(code_verifier))`). */
  codeChallenge: string
  /** PKCE challenge method. v1 only allows `S256`. */
  codeChallengeMethod: 'S256'
  /** Epoch-ms creation. */
  createdAt: number
  /** Random opaque identifier the consumer holds and presents on `/token`. */
  deviceCode: string
  /** Epoch-ms expiry. */
  expiresAt: number
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
   */
  baseUrl: string
  /**
   * Authorization intent lifetime in seconds. Records past `expiresAt`
   * are GC'd lazily on next access and surface as `410 Gone` on
   * `/token`. Defaults to 600 (10 minutes).
   */
  expiresIn?: number | undefined
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
   * match the OAuth device-code spec). Consumers may honour or ignore
   * this; the transport doesn't enforce server-side rate limiting
   * itself. Defaults to 2000.
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
     * host-side `Handshake` dispatches it and produces a response.
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
export type DeviceCodeTransport = Transport.Transport<'host'> & HttpServer.HttpServer

/**
 * Create a host-side `device-code` transport.
 *
 * @example
 * ```ts
 * import { Handshake, Kv, deviceCode } from 'handshakes/host'
 *
 * const transport = deviceCode({
 *   store: Kv.memory(),
 *   baseUrl: 'https://wallet.example',
 *   path: '/auth/device',
 *   html: { render, authenticate },
 * })
 * ```
 */
export function deviceCode(options: Options): DeviceCodeTransport {
  const {
    baseUrl,
    expiresIn = 600,
    html,
    path,
    pollingInterval = 2000,
    store,
  } = options
  const origin = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const verificationUri = `${origin}${path ?? ''}/verify`

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
      // Hand the queued requests to `Handshake` for dispatch. The
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

  app.onError((cause, c) => {
    emitter.emit('error', cause as Error)
    return c.json({ error: 'server_error', message: (cause as Error).message }, { status: 500 })
  })

  app.post('/register', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { code_challenge?: unknown; code_challenge_method?: unknown; message?: unknown }
      | undefined
    if (!body || typeof body !== 'object')
      return c.json(
        { error: 'invalid_request', message: 'expected JSON object body' },
        { status: 400 },
      )
    if (typeof body.code_challenge !== 'string' || body.code_challenge.length === 0)
      return c.json(
        { error: 'invalid_request', message: 'expected non-empty `code_challenge`' },
        { status: 400 },
      )
    if (body.code_challenge_method !== 'S256')
      return c.json(
        { error: 'invalid_request', message: 'expected `code_challenge_method` of `S256`' },
        { status: 400 },
      )

    let envelope: Envelope.Envelope
    try {
      envelope = Envelope.parse(body.message)
    } catch (cause) {
      return c.json(
        { error: 'invalid_request', message: (cause as Error).message },
        { status: 400 },
      )
    }
    if (envelope.type !== 'rpc-requests')
      return c.json(
        { error: 'invalid_request', message: '`message` must be an `rpc-requests` envelope' },
        { status: 400 },
      )

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
    }

    await store.set(deviceCodeKey(deviceCodeValue), record, { ttl: expiresIn })
    await store.set(userCodeKey(userCodeValue), record, { ttl: expiresIn })

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
      | { code_verifier?: unknown; device_code?: unknown }
      | undefined
    if (!body || typeof body !== 'object')
      return c.json(
        { error: 'invalid_request', message: 'expected JSON object body' },
        { status: 400 },
      )
    if (typeof body.device_code !== 'string' || body.device_code.length === 0)
      return c.json(
        { error: 'invalid_request', message: 'expected non-empty `device_code`' },
        { status: 400 },
      )
    if (typeof body.code_verifier !== 'string' || body.code_verifier.length === 0)
      return c.json(
        { error: 'invalid_request', message: 'expected non-empty `code_verifier`' },
        { status: 400 },
      )

    const record = await store.get<PendingRecord>(deviceCodeKey(body.device_code))
    if (!record)
      return c.json(
        { error: 'expired_token', message: 'unknown or expired `device_code`' },
        { status: 404 },
      )

    if (Date.now() >= record.expiresAt) {
      await store.delete(deviceCodeKey(record.deviceCode))
      await store.delete(userCodeKey(record.userCode))
      return c.json(
        { error: 'expired_token', message: '`device_code` has expired' },
        { status: 410 },
      )
    }

    // PKCE verification — must be checked on every poll, atomically with
    // the response delivery, so a leaked `device_code` alone can't be
    // used to fetch the response without the consumer's `code_verifier`.
    const computed = pkceChallenge(body.code_verifier)
    if (!constantTimeEqual(computed, record.codeChallenge))
      return c.json(
        { error: 'invalid_grant', message: 'PKCE verifier does not match recorded challenge' },
        { status: 400 },
      )

    if (record.status === 'pending')
      return c.json(
        { error: 'authorization_pending', interval: Math.max(1, Math.round(pollingInterval / 1000)) },
        { status: 202 },
      )
    if (record.status === 'denied')
      return c.json({ error: 'access_denied', message: 'user denied the request' }, { status: 403 })
    if (record.status === 'expired')
      return c.json(
        { error: 'expired_token', message: '`device_code` has expired' },
        { status: 410 },
      )

    if (!record.response)
      return c.json(
        { error: 'server_error', message: 'approved but no response queued' },
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
    return await html.render({
      record: record && record.status === 'pending' ? record : undefined,
      request: c.req.raw,
      userCode,
    })
  })

  app.post('/verify', (c) => html.authenticate({ actions, request: c.req.raw }))

  // Bundle the Hono app into the standard `.fetch` + `.listener` pair
  // that every HTTP-server-shaped host transport exposes. The Node
  // `.listener` is lazy-loaded on first invocation; see
  // {@link HttpServer.fromHono} for details.
  const { fetch, listener } = HttpServer.fromHono(app)

  return {
    async close(cause) {
      if (state.closed) return
      state.closed = true
      emitter.emit('close', cause)
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
  return Base64.fromBytes(Bytes.random(32), { url: true, pad: false })
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
  return Base64.fromBytes(digest, { url: true, pad: false })
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
