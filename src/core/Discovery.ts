/**
 * uRPC discovery-document fetcher and parser.
 *
 * Per [uRPC `discovery.md`](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md),
 * each peer publishes a small JSON manifest at a well-known path so the
 * other side can pin its identity, transport bindings, and (consumer-side)
 * allowed callback URLs:
 *
 * - `https://<host>/.well-known/urpc/host.json`         ({@link HostDocument})
 * - `https://<consumer>/.well-known/urpc/consumer.json` ({@link ConsumerDocument})
 *
 * Both documents share `version`, `origin`, and `id`. The `origin` field
 * MUST exactly match the fetch origin (RFC 8414-style self-validation):
 * {@link fetchHost} / {@link fetchConsumer} reject documents whose
 * `origin` does not equal `new URL(url).origin`.
 *
 * `host.json` carries the host's long-term `identity_pubkey` plus a
 * `transports` map keyed by transport name (`relay`, `mobile-link`,
 * `mobile-web-auth`, `device-code`, `window`, `webhook-callback`, …).
 * Unknown transports are preserved verbatim for forward compatibility;
 * known transports with malformed bindings are silently dropped (graceful
 * degradation — the host is treated as not advertising that transport).
 *
 * `consumer.json` is intentionally minimal — just the shared header plus
 * an exact-match `callback_urls` allowlist (no wildcards).
 *
 * Phases that auto-fetch (e.g. `mobileLink({ host: 'https://wallet.example' })`)
 * call {@link fetchHost} / {@link fetchConsumer}. Pre-parsed callers can
 * skip the fetch and pass a {@link HostDocument} directly.
 */

import { z } from 'zod/mini'

import * as Uri from '../internal/Uri.js'
import * as Errors from './Errors.js'

const wellKnownPath = '/.well-known/urpc'

/** Spec version literal carried in every discovery document. */
export const version = '1.0'

/** Zod schemas for the published discovery documents. */
export namespace schema {
  /**
   * Long-term Ed25519 public key, encoded per
   * [uRPC `discovery.md` §2.2](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md):
   * **unpadded base64url**, 32 raw bytes → exactly 43 characters from
   * the URL-safe alphabet `[A-Za-z0-9_-]`.
   */
  export const identityPubkey = z.string().check(
    z.regex(/^[A-Za-z0-9_-]{43}$/, {
      error: 'expected 32-byte unpadded base64url Ed25519 pubkey (43 chars)',
    }),
  )

  /**
   * `https://` URL, with the standard loopback exception for local
   * development (matches OAuth 2.0 RFC 8252 §7.3, WebAuthn, Service
   * Workers, etc.): `http://` is accepted iff the host is `localhost`,
   * `127.0.0.1`, or `[::1]`. Everything else MUST be `https://`.
   */
  export const httpsUrl = z.url({ error: 'expected an https:// URL' }).check(
    z.refine(
      (value) => {
        const url = new URL(value)
        if (url.protocol === 'https:') return true
        if (url.protocol !== 'http:') return false
        return (
          url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
        )
      },
      { error: 'expected an https:// URL (http:// allowed only for loopback)' },
    ),
  )

  /**
   * Callback URI allowlist entry. Claimed HTTPS URLs are preferred, but
   * native-app transports can also publish private-use URI schemes. In
   * all cases the value must be a concrete exact-match URI with no
   * wildcard glob tokens.
   */
  export const callbackUrl = z.url().check(
    z.refine(
      (value) => {
        const url = new URL(value)
        return Uri.isAllowedAppCallback(url)
      },
      {
        error:
          'expected an https:// URL, loopback http:// URL, or reverse-DNS private-use URI scheme',
      },
    ),
    z.refine((value) => !value.includes('*'), {
      error: 'callback_urls must not contain wildcard tokens',
    }),
  )

  /** `mobile-link` transport binding. */
  export const mobileLinkTransport = z.object({
    /** Custom URL scheme registered by the host app (e.g. `examplewallet`). */
    scheme: z.string().check(z.minLength(1)),
    /** HTTPS universal/app-link prefix the host responds to. */
    universal_link: httpsUrl,
  })

  /** `mobile-web-auth` transport binding. */
  export const mobileWebAuthTransport = z.object({
    /** Fully-qualified HTTPS URL of the host's authorization endpoint (same-origin). */
    auth_url: httpsUrl,
  })

  /** `relay` transport binding. */
  export const relayTransport = z.object({
    /** Fully-qualified HTTPS URL of the relay endpoint. */
    url: httpsUrl,
  })

  /** `device-code` transport binding. */
  export const deviceCodeTransport = z.object({
    /** HTTPS URL the consumer POSTs to for device-code authorization intent registration. */
    register_url: httpsUrl,
    /** HTTPS URL the consumer long-polls for the delivered JSON-RPC response. */
    token_url: httpsUrl,
  })

  /** `window` transport binding. */
  export const windowTransport = z.object({
    /** HTTPS URL loaded as the embedded host browsing context. */
    url: httpsUrl,
  })

  /** `webhook-callback` transport binding. */
  export const webhookCallbackTransport = z.object({
    /** Origin under which the host's `/auth` route lives. */
    auth_url_origin: httpsUrl,
    /** HTTPS URL the consumer POSTs to for webhook-callback authorization intent registration. */
    register_url: httpsUrl,
  })

  /**
   * Human-facing app metadata. Carried symmetrically on both
   * `host.json` and `consumer.json` so the opposite side can render
   * "App XYZ is requesting …" in approval / connection chrome.
   */
  export const meta = z.pipe(
    z.object({
      /** Short human-facing description shown alongside `name`. */
      description: z.optional(z.string()),
      /** Absolute URL to a square icon (PNG / SVG / WebP). */
      icon: z.optional(httpsUrl),
      /** Display name shown in approval / connection UIs. */
      name: z.string().check(z.minLength(1)),
      /**
       * Canonical homepage / marketing URL for the app. MAY differ
       * from the document's `origin`.
       */
      website_url: z.optional(httpsUrl),
    }),
    z.transform(
      (
        wire,
      ): {
        description?: string | undefined
        icon?: string | undefined
        name: string
        websiteUrl?: string | undefined
      } => ({
        name: wire.name,
        ...(wire.description !== undefined ? { description: wire.description } : {}),
        ...(wire.icon !== undefined ? { icon: wire.icon } : {}),
        ...(wire.website_url !== undefined ? { websiteUrl: wire.website_url } : {}),
      }),
    ),
  )

  /**
   * `transports` map. Known keys are validated against their per-transport
   * binding shape; unknown keys are preserved verbatim. Per the spec,
   * known keys whose value fails to validate are silently dropped (the
   * host is treated as not advertising that transport) — `z.catch(..., undefined)`
   * absorbs the parse failure without aborting the document.
   */
  export const transports = z.looseObject({
    'device-code': z.catch(z.optional(deviceCodeTransport), undefined),
    'mobile-link': z.catch(z.optional(mobileLinkTransport), undefined),
    'mobile-web-auth': z.catch(z.optional(mobileWebAuthTransport), undefined),
    relay: z.catch(z.optional(relayTransport), undefined),
    'webhook-callback': z.catch(z.optional(webhookCallbackTransport), undefined),
    window: z.catch(z.optional(windowTransport), undefined),
  })

  /**
   * Header fields shared by `host.json` and `consumer.json`.
   *
   * `origin` is the document's self-asserted origin and MUST equal the
   * scheme + host + port of the URL it was fetched from. {@link fetchHost} /
   * {@link fetchConsumer} enforce this.
   */
  const sharedHeader = {
    /** Stable identifier (RECOMMENDED to be the bare hostname). */
    id: z.string().check(z.minLength(1)),
    /** Self-asserted origin (`scheme + host + port`); checked against the fetch URL. */
    origin: httpsUrl,
    /** Spec version of the document (currently `'1.0'`). */
    version: z.literal(version),
  } as const

  /**
   * Top-level app-launch descriptor (`deep_link`). Tells consumers how to
   * open the host's native app and is used as the default link `target`
   * when pairing. At least one of `scheme` / `universal_link` MUST be
   * present.
   */
  export const deepLink = z
    .object({
      /** Custom URL scheme registered by the host app (e.g. `examplewallet`). */
      scheme: z.optional(z.string().check(z.minLength(1))),
      /** HTTPS universal/app-link prefix the host responds to. */
      universal_link: z.optional(httpsUrl),
    })
    .check(
      z.refine((value) => value.scheme !== undefined || value.universal_link !== undefined, {
        error: 'deep_link must contain `scheme` or `universal_link`',
      }),
    )

  /** Host-side discovery manifest published at `host.json`. */
  export const hostDocument = z.object({
    ...sharedHeader,
    /** Optional capability tags for coarse-grained directory filtering. */
    capabilities: z.optional(z.array(z.string())),
    /**
     * How to launch the host's native app when pairing. Used as the
     * default link `target` for transports that emit deep links.
     */
    deep_link: z.optional(deepLink),
    /** Short human-facing description shown alongside `name`. */
    description: z.optional(z.string()),
    /** Optional URL of a square icon. */
    icon: z.optional(httpsUrl),
    /**
     * Host's long-term Ed25519 identity public key, **unpadded base64url**
     * (32 raw bytes → 43 characters). REQUIRED per [uRPC `discovery.md`
     * §2.2](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md);
     * consumers use it to pin and verify the host's signature on session
     * key shares. MUST be stable across sessions — rotation requires a
     * new well-known publication.
     */
    identity_pubkey: identityPubkey,
    /** Human-readable display name. */
    name: z.string().check(z.minLength(1)),
    /**
     * Per-transport binding map. MUST contain at least one usable entry —
     * known transports with malformed bindings are silently dropped, so
     * the refine counts only entries whose value is defined.
     */
    transports: transports.check(
      z.refine((value) => Object.values(value).some((binding) => binding !== undefined), {
        error: 'transports must contain at least one valid entry',
      }),
    ),
    /**
     * Canonical homepage / marketing URL for this host app. MAY differ
     * from `origin`. Named `website_url` to disambiguate from the
     * protocol-level `origin` field.
     */
    website_url: z.optional(httpsUrl),
  })

  /** Consumer-side discovery manifest published at `consumer.json`. */
  export const consumerDocument = z.object({
    ...sharedHeader,
    /**
     * Allowlist of fully-qualified callback URLs the consumer accepts.
     * Hosts MUST verify the consumer's `webhook_url` exact-matches one
     * of these. Wildcard segments are rejected.
     */
    callback_urls: z.optional(z.array(callbackUrl)),
    /** Short human-facing description shown alongside `name`. */
    description: z.optional(z.string()),
    /** Optional URL of a square icon. */
    icon: z.optional(httpsUrl),
    /**
     * Consumer's long-term Ed25519 identity public key, **unpadded
     * base64url** (32 raw bytes → 43 characters). REQUIRED for the
     * `webhook-callback` transport — per [`transport-webhook-callback.md`
     * §5.8](https://github.com/tempoxyz/urpc/blob/main/specs/transport-webhook-callback.md):
     * "A consumer without a `consumer.json` carrying an
     * `identity_pubkey` cannot use Webhook Callback." Hosts pin this
     * value at registration time and use it to verify every signed
     * `POST <register_url>` / `DELETE <register_url>/<auth_req_id>`.
     * Optional for consumers that only use transports without
     * RFC 9421 signing (e.g. `device-code`, `window`).
     */
    identity_pubkey: z.optional(identityPubkey),
    /** Human-readable display name shown in host approval chrome. */
    name: z.optional(z.string().check(z.minLength(1))),
    /**
     * Canonical homepage / marketing URL for this consumer app. MAY
     * differ from `origin`. Named `website_url` to disambiguate from
     * the protocol-level `origin` field.
     */
    website_url: z.optional(httpsUrl),
  })
}

/** Parsed `host.json`. */
export type HostDocument = z.output<typeof schema.hostDocument>

/** Parsed `consumer.json`. */
export type ConsumerDocument = z.output<typeof schema.consumerDocument>

/** Parsed `host.json` `transports` map. */
export type Transports = HostDocument['transports']

/**
 * Human-facing app metadata carried symmetrically on both `host.json`
 * and `consumer.json`. Used by host approval chrome to label the
 * consumer and by consumer connection chrome to label the host.
 */
export type Meta = z.output<typeof schema.meta>

/**
 * Compose the full discovery URL for a host's `host.json`.
 *
 * @example
 * ```ts
 * Discovery.hostUrl('https://wallet.example')
 * // 'https://wallet.example/.well-known/urpc/host.json'
 * ```
 */
export function hostUrl(origin: string): string {
  return joinOrigin(origin, `${wellKnownPath}/host.json`)
}

/**
 * Compose the full discovery URL for a consumer's `consumer.json`.
 */
export function consumerUrl(origin: string): string {
  return joinOrigin(origin, `${wellKnownPath}/consumer.json`)
}

/**
 * Validate an arbitrary JSON value as a {@link HostDocument}.
 */
export function parseHost(value: unknown): HostDocument {
  return assertParse(schema.hostDocument, value, 'host.json')
}

/**
 * Validate an arbitrary JSON value as a {@link ConsumerDocument}.
 */
export function parseConsumer(value: unknown): ConsumerDocument {
  return assertParse(schema.consumerDocument, value, 'consumer.json')
}

/**
 * Fetch and parse a host's `host.json`. Validates that the document's
 * self-asserted `origin` matches the fetch origin (RFC 8414-style).
 * The optional `fetch` override is primarily for tests — production
 * code uses the platform `fetch`.
 *
 * @example
 * ```ts
 * import { Discovery } from 'wata'
 *
 * const host = await Discovery.fetchHost('https://wallet.example')
 * ```
 */
export async function fetchHost(
  origin: string,
  options: fetchHost.Options = {},
): Promise<HostDocument> {
  const url = hostUrl(origin)
  const document = parseHost(await fetchJson(url, options))
  assertOrigin(document.origin, url, 'host.json')
  return document
}

export declare namespace fetchHost {
  /** Options for {@link fetchHost}. */
  type Options = {
    /** Override the global `fetch` (test injection). */
    fetch?: typeof fetch | undefined
    /** Optional abort signal. */
    signal?: AbortSignal | undefined
  }
}

/**
 * Fetch and parse a consumer's `consumer.json`. Validates that the
 * document's self-asserted `origin` matches the fetch origin.
 */
export async function fetchConsumer(
  origin: string,
  options: fetchConsumer.Options = {},
): Promise<ConsumerDocument> {
  const url = consumerUrl(origin)
  const document = parseConsumer(await fetchJson(url, options))
  assertOrigin(document.origin, url, 'consumer.json')
  return document
}

export declare namespace fetchConsumer {
  /** Options for {@link fetchConsumer}. */
  type Options = fetchHost.Options
}

/**
 * Per-URL in-process cache used for `ETag` / `If-None-Match`
 * revalidation per [uRPC `discovery.md` §2.5](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md):
 * servers SHOULD emit a strong validator and consumers SHOULD revalidate
 * with `If-None-Match`. On a `304 Not Modified` response, the cached
 * body is returned without re-parsing.
 */
const etagCache = new Map<string, { body: unknown; etag: string }>()

/**
 * Maximum response body size for well-known fetches.
 *
 * Per [uRPC `discovery.md` §2.5](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md):
 * consumers MUST enforce a limit; RECOMMENDED 64 KiB. Defends against
 * a host returning an oversized payload that exhausts memory before
 * Zod parsing has a chance to bail.
 */
const maxResponseBytes = 64 * 1024

async function fetchJson(
  url: string,
  options: { fetch?: typeof fetch | undefined; signal?: AbortSignal | undefined },
): Promise<unknown> {
  const fetchFn = options.fetch ?? fetch
  const cached = etagCache.get(url)
  let response: Response
  try {
    response = await fetchFn(url, {
      headers: {
        accept: 'application/json',
        ...(cached ? { 'if-none-match': cached.etag } : {}),
      },
      // Spec §2.5: servers MUST NOT redirect across origins; we surface
      // a `ProtocolError` for any cross-origin 3xx and follow same-origin
      // redirects manually below.
      redirect: 'manual',
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (cause) {
    throw new Errors.ProtocolError('discovery fetch failed', {
      cause: cause as Error,
      details: `${url}: ${(cause as Error).message}`,
    })
  }
  // RFC 9110 §15.4.5 — 304 means the cached representation is still
  // current. Spec §2.5 says consumers SHOULD revalidate with
  // `If-None-Match`; the server's 304 means our cached body is good.
  if (response.status === 304 && cached) return cached.body
  // `redirect: 'manual'` surfaces 3xx as `response.type === 'opaqueredirect'`
  // in browsers (status 0, no headers) and as a real 3xx in Node. Either
  // way the spec rule is the same: reject. We can't safely follow
  // because we can't compare origins on the opaque case.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
    throw new Errors.ProtocolError('discovery fetch redirected', {
      details: `${url}: ${response.status} (cross-origin redirects forbidden per spec §2.5)`,
    })
  if (!response.ok)
    throw new Errors.ProtocolError('discovery fetch returned non-2xx', {
      details: `${url}: ${response.status} ${response.statusText}`,
    })
  // Enforce the spec §2.5 RECOMMENDED 64 KiB response-size cap. Prefer
  // the advertised `content-length` so we can refuse before reading;
  // fall back to a byte-counting stream reader to defend against
  // missing / lying headers (e.g. chunked transfer with no length).
  const advertisedLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertisedLength) && advertisedLength > maxResponseBytes)
    throw new Errors.ProtocolError('discovery response exceeds size limit', {
      details: `${url}: content-length ${advertisedLength} > ${maxResponseBytes}`,
    })
  let raw: string
  try {
    raw = await readBoundedText(response, maxResponseBytes)
  } catch (cause) {
    if (cause instanceof Errors.ProtocolError) throw cause
    throw new Errors.ProtocolError('discovery response read failed', {
      cause: cause as Error,
      details: `${url}: ${(cause as Error).message}`,
    })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (cause) {
    throw new Errors.ProtocolError('discovery response is not valid JSON', {
      cause: cause as Error,
      details: `${url}: ${(cause as Error).message}`,
    })
  }
  // Cache the parsed body keyed by URL + the server's strong validator
  // so the next call can revalidate via `If-None-Match` and short-
  // circuit on 304.
  const responseEtag = response.headers.get('etag')
  if (responseEtag) etagCache.set(url, { body, etag: responseEtag })
  return body
}

/**
 * Read a `Response` body as UTF-8 text, aborting if it exceeds
 * `maxBytes`. Defends against missing or lying `content-length`
 * headers by counting bytes as they arrive (chunked transfer
 * encoding, no advertised length, etc.).
 *
 * Falls back to `response.text()` when the body isn't streamable
 * (e.g. mocked `Response` in older test harnesses); the byte cap
 * is then enforced post-decode.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Errors.ProtocolError('discovery response exceeds size limit', {
        details: `decoded ${text.length} chars exceeds ${maxBytes}-byte cap`,
      })
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new Errors.ProtocolError('discovery response exceeds size limit', {
        details: `received ${received} bytes exceeds ${maxBytes}-byte cap`,
      })
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function joinOrigin(origin: string, path: string): string {
  return origin.replace(/\/+$/, '') + path
}

function assertOrigin(declared: string, fetchUrl: string, label: string): void {
  const expected = new URL(fetchUrl).origin
  let normalized: string
  try {
    normalized = new URL(declared).origin
  } catch {
    throw new Errors.ProtocolError(`${label} origin is not a valid URL`, {
      details: `expected ${expected}, document declared ${declared}`,
    })
  }
  if (normalized !== expected)
    throw new Errors.ProtocolError(`${label} origin mismatch`, {
      details: `expected ${expected}, document declared ${normalized}`,
    })
}

function assertParse<schema extends z.ZodMiniType>(
  schema: schema,
  value: unknown,
  label: string,
): z.output<schema> {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new Errors.ProtocolError(`invalid ${label}`, {
      details: result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    })
  return result.data
}
