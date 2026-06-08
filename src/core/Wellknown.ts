/**
 * Hono-free helpers used by both consumer-side and host-side
 * `Wata.create({ baseUrl, meta })` to auto-publish
 * `/.well-known/urpc/{host,consumer}.json` off the transport's
 * existing `.fetch` handler.
 *
 * Kept separate from `src/server/Discovery.ts` (which exposes the
 * standalone `hostWellknown` / `consumerWellknown` factories on
 * `wata/server`) so consumer browser/CLI bundles never pull in Hono
 * just to import `Wata.create`. The standalone factories are an
 * ops-side surface; the embedded `Wata.create({ baseUrl, meta })`
 * path needs only document construction + a small inline route check.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { Bytes, Hex } from 'ox'

import * as Discovery from './Discovery.js'
import * as Http from './Http.js'
import * as Schema from './Schema.js'

/** Public path of the host well-known document. */
export const hostPath = '/.well-known/urpc/host.json'

/** Public path of the consumer well-known document. */
export const consumerPath = '/.well-known/urpc/consumer.json'

/**
 * `Cache-Control` `max-age` (seconds) per [uRPC `discovery.md` §2.5](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md):
 *
 * - **host.json** SHOULD be `max-age=60` — short, because `identity_pubkey`
 *   is a trust anchor and consumers MUST revalidate before pinning.
 * - **consumer.json** SHOULD be `max-age=3600` — long, because
 *   `callback_urls` change rarely.
 */
export const hostMaxAge = 60
export const consumerMaxAge = 3600

/**
 * Compute a strong ETag for a serialized discovery document.
 *
 * Format: `"<hex-sha256>"` — quoted per [RFC 9110 §8.8.3](https://www.rfc-editor.org/rfc/rfc9110#name-etag).
 * Strong validators (no `W/` prefix) are appropriate because the body
 * is byte-stable: the same input always produces the same output.
 */
export function etag(serialized: string): string {
  return `"${Hex.fromBytes(sha256(Bytes.fromString(serialized))).slice(2)}"`
}

/**
 * Conditional-request handler.
 *
 * Returns `304 Not Modified` (no body) when `If-None-Match` matches the
 * supplied `currentEtag` — per [RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110#name-if-none-match).
 * Returns `undefined` when the caller should send the full `200`
 * response.
 */
export function notModified(request: Request, currentEtag: string): Response | undefined {
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch && ifNoneMatch === currentEtag)
    return new Response(null, { headers: { etag: currentEtag }, status: 304 })
  return undefined
}

/**
 * Build the {@link Discovery.HostDocument} that
 * `Wata.create({ baseUrl, meta })` publishes when wrapping an
 * HTTP-server-shaped host transport.
 */
export function buildHostDocument(options: {
  baseUrl: string
  meta: Discovery.Meta
  publicKey: string
  transports: Record<string, unknown>
}): Discovery.HostDocument {
  const { baseUrl, meta, publicKey, transports } = options
  const origin = new URL(baseUrl).origin
  return Schema.validate(Discovery.schema.hostDocument, {
    id: new URL(origin).hostname,
    identity_pubkey: publicKey,
    name: meta.name,
    origin,
    transports,
    version: Discovery.version,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.icon ? { icon: meta.icon } : {}),
    ...(meta.websiteUrl ? { website_url: meta.websiteUrl } : {}),
  })
}

/**
 * Build the {@link Discovery.ConsumerDocument} that
 * `Wata.create({ baseUrl, meta })` publishes when wrapping an
 * HTTP-server-shaped consumer transport.
 */
export function buildConsumerDocument(options: {
  baseUrl: string
  callbackUrls?: readonly string[] | undefined
  meta: Discovery.Meta
  publicKey?: string | undefined
}): Discovery.ConsumerDocument {
  const { baseUrl, callbackUrls, meta, publicKey } = options
  const origin = new URL(baseUrl).origin
  return Schema.validate(Discovery.schema.consumerDocument, {
    id: new URL(origin).hostname,
    name: meta.name,
    origin,
    version: Discovery.version,
    ...(callbackUrls && callbackUrls.length > 0 ? { callback_urls: callbackUrls } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.icon ? { icon: meta.icon } : {}),
    ...(publicKey ? { identity_pubkey: publicKey } : {}),
    ...(meta.websiteUrl ? { website_url: meta.websiteUrl } : {}),
  })
}

/**
 * Wrap a base `.fetch` handler so that GET requests to `wellknownPath`
 * serve the supplied `document` and everything else falls through to
 * `base.fetch`. When `base.fetch` is omitted (the wrapped transport
 * doesn't expose HTTP handlers), non-well-known requests return `404`.
 */
export function wrapFetch(options: {
  base: { fetch?: ((request: Request) => Promise<Response>) | undefined } | undefined
  document: Discovery.HostDocument | Discovery.ConsumerDocument
  wellknownPath: string
}): Http.Server {
  const { base, document, wellknownPath } = options
  const serialized = JSON.stringify(document)
  const baseFetch = base?.fetch
  const maxAge = wellknownPath === hostPath ? hostMaxAge : consumerMaxAge
  const documentEtag = etag(serialized)

  const fetch: (request: Request) => Promise<Response> = async (request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === wellknownPath) {
      const notModifiedResponse = notModified(request, documentEtag)
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
    if (baseFetch) return baseFetch(request)
    return new Response(null, { status: 404 })
  }

  return { fetch }
}
