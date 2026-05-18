/**
 * Consumer-side `device-code` transport — HTTP client, single-exchange.
 *
 * Implements the consumer half of the uRPC `device-code` transport spec.
 * `transport.send(envelope)` runs the full lifecycle in one shot:
 *
 * 1. generate a fresh PKCE `code_verifier` + `code_challenge`,
 * 2. `POST <registerUrl>` with the JSON-RPC requests as `message`,
 * 3. surface `device_code` / `user_code` / `verification_uri` to the
 *    user via {@link Options.onPrompt} (defer to a CLI prompt, in-app
 *    UI, etc.),
 * 4. poll `POST <tokenUrl>` until the host returns the `rpc-responses`
 *    envelope (or denies / times out),
 * 5. emit a `'message'` event carrying the `rpc-responses` envelope and
 *    auto-close the transport.
 *
 * Single-exchange — concurrent `send()` calls reject immediately with
 * {@link Transport.TransportError}, and any `send()` after the terminal
 * response rejects with {@link Transport.ClosedError}. Mirrors the host
 * transport's behaviour so both sides agree on session lifetime.
 *
 * @example
 * ```ts
 * import { Wata, deviceCode } from 'wata'
 *
 * const wata = Wata.create({
 *   transport: deviceCode({
 *     url: 'https://wallet.example/auth/device',
 *     onPrompt: ({ userCode, verificationUri }) => {
 *       console.log(`Visit ${verificationUri} and enter ${userCode}`)
 *     },
 *   }),
 * })
 *
 * const { result } = await wata.send({ method: 'ping', params: [] })
 * ```
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { Base64, Bytes } from 'ox'

import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Transport from '../../core/Transport.js'

/** Information surfaced to {@link Options.onPrompt} once `/register` succeeds. */
export type Prompt = {
  /** Opaque identifier the consumer holds and presents on `/token`. */
  deviceCode: string
  /** Authorization intent lifetime (seconds). */
  expiresIn: number
  /** Suggested poll interval (milliseconds). */
  pollingInterval: number
  /** Short human-typed code the user enters at `verificationUri`. */
  userCode: string
  /** URL the user visits to approve the request. */
  verificationUri: string
  /** `verificationUri` with `?user_code=...` appended, when the host returned one. */
  verificationUriFull: string | undefined
}

/** Options accepted by {@link deviceCode}. */
export type Options = {
  /**
   * Optional `consumer.json` URL surfaced to the host alongside
   * `/register`. The host fetches this lazily on its approval page
   * to render `meta` when no inline {@link Options.meta} was
   * supplied. Set explicitly here OR inherit it from the wrapping
   * `Wata.create({ baseUrl })` (which uses `${baseUrl}/.well-known/
   * urpc/consumer.json`).
   */
  consumerUrl?: string | undefined
  /**
   * Override the `fetch` implementation. Defaults to `globalThis.fetch`.
   * Useful for tests, server-side proxies, or runtimes without a
   * global `fetch`.
   */
  fetch?: typeof globalThis.fetch | undefined
  /**
   * Inline {@link Discovery.Meta} serialized into the `/register`
   * payload. Takes precedence over any meta discovered via
   * {@link consumerUrl}. Reach for it when you want to label the
   * approval UI without publishing a `consumer.json` (or when the
   * inline value should override the published one). When this
   * transport is wrapped by `Wata.create({ meta })`, the parent
   * `meta` is lazy-injected here unless a constructor-level value
   * is already set.
   */
  meta?: Discovery.Meta | undefined
  /**
   * Called once the host accepts `/register` and returns user-facing
   * codes. Surface them to the user — CLI print, modal, deep-link, etc.
   * The transport then polls `${url}/token` until terminal.
   */
  onPrompt?: ((prompt: Prompt) => void | Promise<void>) | undefined
  /**
   * Override the polling cadence (milliseconds). Defaults to the
   * `interval` returned by the host on `/register` (converted from
   * seconds). Subject to a 1ms minimum to keep tests / playgrounds
   * deterministic.
   */
  pollingInterval?: number | undefined
  /**
   * Per-`/token`-poll request timeout (milliseconds). Defaults to
   * 30_000ms. Independent of the overall device-code expiry returned
   * by the host.
   */
  pollingTimeout?: number | undefined
  /**
   * Base URL of the host's device-code endpoints. The transport derives
   * `${url}/register` and `${url}/token` from it. Strips a trailing
   * slash automatically.
   */
  url: string
}

/**
 * Create a consumer-side `device-code` transport.
 *
 * @example
 * ```ts
 * import { deviceCode } from 'wata'
 *
 * const transport = deviceCode({
 *   url: 'https://wallet.example/auth/device',
 *   onPrompt: console.log,
 * })
 * ```
 */
export function deviceCode(options: Options): Transport.Transport<'consumer'> {
  const {
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    onPrompt,
    pollingInterval,
    pollingTimeout = 30_000,
    url,
  } = options
  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url
  const registerUrl = `${baseUrl}/register`
  const tokenUrl = `${baseUrl}/token`

  // Constructor-level `meta` / `consumerUrl` are sticky. `bind()`
  // (from a wrapping `Wata.create({ baseUrl, meta })`) only fills in
  // values that weren't set explicitly.
  const meta_ctor = options.meta
  let meta_bound: Discovery.Meta | undefined
  const consumerUrl_ctor = options.consumerUrl
  let consumerUrl_bound: string | undefined

  function resolveMeta(): Discovery.Meta | undefined {
    return meta_ctor ?? meta_bound
  }
  function resolveConsumerUrl(): string | undefined {
    return consumerUrl_ctor ?? consumerUrl_bound
  }

  const emitter = Events.create<Transport.EventMap>()

  // Single-exchange transport state. `inFlight` guards concurrent
  // `send()` calls; `closed` flips once the terminal response (or any
  // error / explicit `close`) settles the exchange.
  type State = { closed: boolean; inFlight: boolean; started: boolean }
  const state: State = {
    closed: false,
    inFlight: false,
    started: false,
  }

  /** Settle the transport and emit the corresponding lifecycle events. */
  function settle(message: Envelope.Envelope | undefined, cause?: Error) {
    if (state.closed) return
    state.inFlight = false
    state.closed = true
    if (cause) emitter.emit('error', cause)
    if (message) emitter.emit('message', message)
    emitter.emit('close', cause)
  }

  async function pollForResponse(
    deviceCodeValue: string,
    codeVerifier: string,
    initialInterval: number,
  ): Promise<Envelope.Envelope> {
    // RFC 8628 §3.5 — `interval` may grow over the life of the
    // exchange (`slow_down` adds ≥5s each time). Track consecutive
    // `slow_down` responses so we can give up if the host signals
    // indefinite throttling.
    let interval = initialInterval
    let consecutiveSlowDown = 0
    while (!state.closed) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), pollingTimeout)
      let response: Response
      try {
        response = await fetchImpl(tokenUrl, {
          body: JSON.stringify({
            // RFC 8628 §3.4 — `grant_type` is REQUIRED on the token
            // endpoint and must be the device-code grant URN.
            code_verifier: codeVerifier,
            device_code: deviceCodeValue,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          method: 'POST',
          signal: controller.signal,
        })
      } catch (cause) {
        clearTimeout(timeout)
        if (state.closed)
          throw new Transport.ClosedError('device-code transport closed before response arrived')
        // Network / timeout / abort — propagate as a transport error and
        // tear the session down. Don't loop forever on a flap.
        throw new Transport.TransportError(`device-code poll failed: ${(cause as Error).message}`, {
          cause: cause as Error,
        })
      }
      clearTimeout(timeout)

      const body = await safeJson(response)

      if (response.status === 200) {
        try {
          return Envelope.parse(body)
        } catch (cause) {
          throw new Transport.TransportError(
            `host returned an invalid response envelope: ${(cause as Error).message}`,
            { cause: cause as Error },
          )
        }
      }
      if (response.status === 400 && readError(body) === 'authorization_pending') {
        // RFC 8628 §3.5 — host hasn't been approved yet. Sleep and try
        // again at the current cadence. Reset the `slow_down` streak —
        // the host has resumed accepting polls at the normal rate.
        consecutiveSlowDown = 0
        await sleep(Math.max(1, interval))
        continue
      }
      if (response.status === 400 && readError(body) === 'slow_down') {
        // RFC 8628 §3.5 — `slow_down` is a non-terminal throttling
        // signal. The consumer MUST add at least 5 seconds to the
        // polling interval and continue. After three consecutive
        // `slow_down`s with no intervening `authorization_pending`,
        // treat the exchange as indefinitely throttled and tear it
        // down with a transport-level error.
        consecutiveSlowDown += 1
        if (consecutiveSlowDown >= 3)
          throw new Transport.TransportError(
            'device-code host is signalling indefinite throttling (3 consecutive `slow_down` responses)',
          )
        interval += 5_000
        await sleep(interval)
        continue
      }
      if (response.status === 400 && readError(body) === 'invalid_grant')
        throw new Errors.ProtocolError('device-code PKCE verification failed', {
          details: readErrorDescription(body),
        })
      if (response.status === 400 && readError(body) === 'access_denied')
        throw new UserRejectedError(
          readErrorDescription(body) ?? 'user denied the device-code request',
        )
      if (response.status === 400 && readError(body) === 'expired_token')
        throw new Transport.ClosedError('device-code expired or not found')
      throw new Transport.TransportError(
        `unexpected device-code /token status ${response.status}: ${readErrorDescription(body) ?? '<no body>'}`,
      )
    }
    throw new Transport.ClosedError('device-code transport closed before response arrived')
  }

  async function runExchange(envelope: Envelope.Envelope): Promise<Envelope.Envelope> {
    if (envelope.type !== 'rpc-requests')
      throw new Transport.UnsupportedError(
        `device-code transport only carries rpc-requests envelopes; received \`${envelope.type}\``,
      )

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = pkceChallenge(codeVerifier)

    const meta = resolveMeta()
    const consumerUrl = resolveConsumerUrl()

    let response: Response
    try {
      response = await fetchImpl(registerUrl, {
        body: JSON.stringify({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          message: envelope,
          ...(consumerUrl ? { consumer_url: consumerUrl } : {}),
          ...(meta
            ? {
                meta: {
                  name: meta.name,
                  ...(meta.description ? { description: meta.description } : {}),
                  ...(meta.icon ? { icon: meta.icon } : {}),
                  ...(meta.websiteUrl ? { website_url: meta.websiteUrl } : {}),
                },
              }
            : {}),
        }),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        method: 'POST',
      })
    } catch (cause) {
      throw new Transport.TransportError(
        `device-code register failed: ${(cause as Error).message}`,
        { cause: cause as Error },
      )
    }

    const body = await safeJson(response)
    if (response.status !== 200) {
      if (response.status === 400)
        throw new Errors.ProtocolError(
          `host rejected device-code /register: ${readErrorDescription(body) ?? '<no body>'}`,
        )
      throw new Transport.TransportError(
        `device-code /register returned status ${response.status}: ${readErrorDescription(body) ?? '<no body>'}`,
      )
    }

    if (!body || typeof body !== 'object')
      throw new Transport.TransportError('device-code /register returned a non-object body')
    const fields = body as {
      device_code?: unknown
      expires_in?: unknown
      interval?: unknown
      user_code?: unknown
      verification_uri?: unknown
      verification_uri_complete?: unknown
    }
    if (typeof fields.device_code !== 'string')
      throw new Transport.TransportError('host /register response missing `device_code`')
    if (typeof fields.user_code !== 'string')
      throw new Transport.TransportError('host /register response missing `user_code`')
    if (typeof fields.verification_uri !== 'string')
      throw new Transport.TransportError('host /register response missing `verification_uri`')

    // Wire `interval` is in seconds per the OAuth device-code spec;
    // surface it to the user (and downstream poll loop) in ms.
    const interval =
      pollingInterval ??
      // RFC 8628 §3.5 — when the host omits `interval`, the consumer
      // MUST default to 5 seconds.
      (typeof fields.interval === 'number' && fields.interval > 0 ? fields.interval * 1000 : 5000)

    const prompt: Prompt = {
      deviceCode: fields.device_code,
      expiresIn: typeof fields.expires_in === 'number' ? fields.expires_in : 600,
      pollingInterval: interval,
      userCode: fields.user_code,
      verificationUri: fields.verification_uri,
      verificationUriFull:
        typeof fields.verification_uri_complete === 'string'
          ? fields.verification_uri_complete
          : undefined,
    }
    if (onPrompt) await onPrompt(prompt)

    return await pollForResponse(prompt.deviceCode, codeVerifier, interval)
  }

  return {
    bind(binding) {
      const { baseUrl, meta } = binding
      if (baseUrl && !consumerUrl_ctor && !consumerUrl_bound) {
        const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
        consumerUrl_bound = `${trimmed}/.well-known/urpc/consumer.json`
      }
      if (meta && !meta_ctor && !meta_bound) meta_bound = meta as Discovery.Meta
    },
    async close(cause) {
      if (state.closed) return
      state.inFlight = false
      state.closed = true
      emitter.emit('close', cause)
    },
    exchange: 'single_exchange',
    on: emitter.on,
    role: 'consumer',
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('device-code transport already closed')
      if (state.inFlight)
        throw new Transport.TransportError(
          'device-code is single-exchange; a previous send is still in flight',
        )
      if (!state.started) state.started = true
      state.inFlight = true

      // Run the register + poll exchange asynchronously. `send()` returns
      // as soon as the exchange has been kicked off; the response (or any
      // failure) arrives via `'message'` / `'error'` / `'close'` events
      // — matching the contract of every other transport. While the
      // exchange is in flight, a second `send()` rejects with
      // `TransportError` (concurrency); once it settles, the transport
      // auto-closes and any further `send()` rejects with `ClosedError`.
      void runExchange(envelope).then(
        (response) => settle(response),
        (cause) => settle(undefined, cause as Error),
      )
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('device-code transport already closed')
      state.started = true
    },
  }
}

/** PKCE verifier (43+ char base64url string from 32 random bytes). */
function generateCodeVerifier(): string {
  return Base64.fromBytes(Bytes.random(32), { pad: false, url: true })
}

/** PKCE challenge from `code_verifier` (`base64url(SHA-256(verifier))`). */
function pkceChallenge(verifier: string): string {
  const digest = sha256(Bytes.fromString(verifier))
  return Base64.fromBytes(digest, { pad: false, url: true })
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function readError(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const value = (body as { error: unknown }).error
    if (typeof value === 'string') return value
  }
  return undefined
}

function readErrorDescription(body: unknown): string | undefined {
  // Per uRPC Device Code §5 (RFC 6749 §5.2 shape), human-readable
  // diagnostic text on a transport error lives in `error_description`.
  // The legacy non-standard `message` field is not consulted.
  if (body && typeof body === 'object' && 'error_description' in body) {
    const value = (body as { error_description: unknown }).error_description
    if (typeof value === 'string') return value
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Thrown when the host's verification UI denies the device-code request
 * (the user clicked "deny" / signed out / failed auth). Distinct from
 * {@link Transport.ClosedError} (intent expired) and
 * {@link Errors.ProtocolError} (PKCE / shape failure) so consumer apps
 * can surface a "user rejected" message specifically.
 */
export class UserRejectedError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'DeviceCode.UserRejectedError'
}
