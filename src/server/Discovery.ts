/**
 * Standalone publishers for `/.well-known/urpc/host.json` and
 * `/.well-known/urpc/consumer.json`.
 *
 * The 90% path is `Wata.create({ baseUrl, meta })` — the wrapping
 * `Wata` instance auto-mounts both the well-known endpoint and the
 * transport routes off a single `.fetch` handler. These standalone
 * factories cover the long tail:
 *
 * - CLI consumers with no HTTP transport that still want to publish a
 *   `consumer.json` from a separate static site.
 * - Ops teams hosting docs on a separate origin from the wallet itself.
 * - Multi-tenant servers where the doc is assembled per tenant.
 * - Pre-route-mount inspection in tests.
 *
 * Both factories return the same fetch-first {@link Http.Server} shape
 * that every HTTP-shaped surface in the library exposes. Node
 * `http.RequestListener` adapters live behind `wata/server`
 * `Handler` helpers.
 *
 * @example minimal Cloudflare Worker publishing `consumer.json`
 * ```ts
 * import { consumerWellknown } from 'wata/server'
 *
 * const consumer = consumerWellknown({
 *   meta: { name: 'Acme CLI', icon: 'https://acme.dev/icon.png' },
 *   callbackUrls: ['https://acme.dev/cb'],
 * })
 *
 * export default { fetch: consumer.fetch }
 * ```
 */

import { Hono } from 'hono'

import * as Discovery from '../core/Discovery.js'
import * as Errors from '../core/Errors.js'
import * as Http from '../core/Http.js'
import * as Schema from '../core/Schema.js'
import * as Wellknown from '../core/Wellknown.js'

// Re-export the shared embedded-document builders + path constants
// (defined in `core/Wellknown` so consumer/browser bundles don't pull
// in Hono just to use `Wata.create({ baseUrl, meta })`).
export const hostWellknownPath = Wellknown.hostPath
export const consumerWellknownPath = Wellknown.consumerPath
export const buildEmbeddedHostDocument = Wellknown.buildHostDocument
export const buildEmbeddedConsumerDocument = Wellknown.buildConsumerDocument
export const wrapFetchWithWellknown = Wellknown.wrapFetch

/** Options accepted by {@link hostWellknown}. */
export type HostOptions = {
  /** Optional `capabilities` tags surfaced on the doc. */
  capabilities?: readonly string[] | undefined
  /**
   * Pre-built {@link Discovery.HostDocument}. When provided, served
   * as-is (validated once at construction) and all other options are
   * ignored. Use this when you need full control over the doc shape
   * (custom fields, hand-rolled origin pinning, etc.).
   */
  document?: Discovery.HostDocument | undefined
  /** Optional `icon` URL. Defaults to `meta.icon`. */
  icon?: string | undefined
  /**
   * Override the document's `id` field. Defaults to the request URL's
   * hostname so a single server can publish without hard-coding its
   * identity.
   */
  id?: string | undefined
  /** Human-facing metadata block (passes through to `meta`). */
  meta?: Discovery.Meta | undefined
  /**
   * Optional `name` override. Defaults to `meta.name`; one of the two
   * MUST resolve to a non-empty string.
   */
  name?: string | undefined
  /**
   * Override the document's `origin` field. Defaults to the request
   * URL's origin (`scheme + host + port`).
   */
  origin?: string | undefined
  /**
   * Long-term Ed25519 identity public key, **unpadded base64url** (32
   * raw bytes → 43 characters). REQUIRED per [uRPC `discovery.md`
   * §2.2](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md).
   * Either `publicKey` or a pre-built `document` carrying one
   * MUST be supplied — `host.json` cannot be served without it.
   */
  publicKey?: string | undefined
  /**
   * Per-transport bindings (e.g. `{ 'device-code': { register_url,
   * token_url } }`). At least one binding MUST be present.
   */
  transports?: Record<string, unknown> | undefined
}

/** Options accepted by {@link consumerWellknown}. */
export type ConsumerOptions = {
  /**
   * Optional callback URL allowlist. Each entry must be an exact-match
   * `https://` URL with no wildcard segments.
   */
  callbackUrls?: readonly string[] | undefined
  /**
   * Pre-built {@link Discovery.ConsumerDocument}. When provided, served
   * as-is (validated once at construction) and all other options are
   * ignored.
   */
  document?: Discovery.ConsumerDocument | undefined
  /**
   * Override the document's `id` field. Defaults to the request URL's
   * hostname.
   */
  id?: string | undefined
  /** Human-facing metadata block. */
  meta?: Discovery.Meta | undefined
  /**
   * Override the document's `origin` field. Defaults to the request
   * URL's origin.
   */
  origin?: string | undefined
}

/**
 * Create a `{ fetch }` server that serves
 * `/.well-known/urpc/host.json` for a host wallet.
 *
 * @example
 * ```ts
 * import { hostWellknown } from 'wata/server'
 *
 * const host = hostWellknown({
 *   meta: { name: 'Example Wallet', icon: 'https://wallet.example/logo.png' },
 *   publicKey: 'MCowBQYDK2VwAyEA...', // unpadded base64url Ed25519
 *   transports: { 'device-code': { register_url: '...', token_url: '...' } },
 * })
 *
 * export default { fetch: host.fetch }
 * ```
 */
export function hostWellknown(options: HostOptions = {}): Http.Server {
  // Validate the pre-built doc upfront so a misshapen `document` fails
  // at construction time rather than per-request.
  if (options.document) Schema.validate(Discovery.schema.hostDocument, options.document)

  const app = new Hono()
  app.get('/.well-known/urpc/host.json', (c) => {
    let doc: Discovery.HostDocument
    try {
      doc = options.document ?? buildHostDocument(options, c.req.url)
    } catch (cause) {
      return jsonError(cause)
    }
    return jsonOk(c.req.raw, doc, Wellknown.hostMaxAge)
  })

  return Http.fromHono(app)
}

/**
 * Create a `{ fetch }` server that serves
 * `/.well-known/urpc/consumer.json` for a consumer app.
 *
 * @example
 * ```ts
 * import { consumerWellknown } from 'wata/server'
 *
 * const consumer = consumerWellknown({
 *   meta: { name: 'Acme CLI', icon: 'https://acme.dev/icon.png' },
 *   callbackUrls: ['https://acme.dev/cb'],
 * })
 * ```
 */
export function consumerWellknown(options: ConsumerOptions = {}): Http.Server {
  if (options.document) Schema.validate(Discovery.schema.consumerDocument, options.document)

  const app = new Hono()
  app.get('/.well-known/urpc/consumer.json', (c) => {
    let doc: Discovery.ConsumerDocument
    try {
      doc = options.document ?? buildConsumerDocument(options, c.req.url)
    } catch (cause) {
      return jsonError(cause)
    }
    return jsonOk(c.req.raw, doc, Wellknown.consumerMaxAge)
  })

  return Http.fromHono(app)
}

function buildHostDocument(options: HostOptions, requestUrl: string): Discovery.HostDocument {
  const { id, origin } = resolveOriginAndId(options.origin, options.id, requestUrl)
  const name = options.name ?? options.meta?.name
  if (!name)
    throw new Errors.ProtocolError('`name` is required (pass `name` directly or via `meta.name`)')
  if (!options.publicKey)
    throw new Errors.ProtocolError(
      '`publicKey` is required (unpadded base64url Ed25519 public key, 43 chars)',
    )
  if (!options.transports || Object.keys(options.transports).length === 0)
    throw new Errors.ProtocolError('`transports` map must contain at least one entry')
  const icon = options.icon ?? options.meta?.icon
  const description = options.meta?.description
  const websiteUrl = options.meta?.websiteUrl
  return Schema.validate(Discovery.schema.hostDocument, {
    id,
    identity_pubkey: options.publicKey,
    name,
    origin,
    transports: options.transports,
    version: Discovery.version,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(websiteUrl ? { website_url: websiteUrl } : {}),
  })
}

function buildConsumerDocument(
  options: ConsumerOptions,
  requestUrl: string,
): Discovery.ConsumerDocument {
  const { id, origin } = resolveOriginAndId(options.origin, options.id, requestUrl)
  const meta = options.meta
  return Schema.validate(Discovery.schema.consumerDocument, {
    id,
    origin,
    version: Discovery.version,
    ...(options.callbackUrls ? { callback_urls: options.callbackUrls } : {}),
    ...(meta?.description ? { description: meta.description } : {}),
    ...(meta?.icon ? { icon: meta.icon } : {}),
    ...(meta?.name ? { name: meta.name } : {}),
    ...(meta?.websiteUrl ? { website_url: meta.websiteUrl } : {}),
  })
}

function resolveOriginAndId(
  origin: string | undefined,
  id: string | undefined,
  requestUrl: string,
): { id: string; origin: string } {
  const parsed = new URL(requestUrl)
  const resolvedOrigin = origin ?? parsed.origin
  const resolvedId = id ?? new URL(resolvedOrigin).hostname
  return { id: resolvedId, origin: resolvedOrigin }
}

function jsonOk(request: Request, body: unknown, maxAge: number): Response {
  const serialized = JSON.stringify(body)
  const documentEtag = Wellknown.etag(serialized)
  const notModifiedResponse = Wellknown.notModified(request, documentEtag)
  if (notModifiedResponse) return notModifiedResponse
  return new Response(serialized, {
    headers: {
      'cache-control': `public, max-age=${maxAge}`,
      'content-type': 'application/json',
      etag: documentEtag,
    },
    status: 200,
  })
}

function jsonError(cause: unknown): Response {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Response(JSON.stringify({ error: 'invalid_request', error_description: message }), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    status: 400,
  })
}
