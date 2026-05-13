/**
 * TempoCP discovery-document fetcher and parser.
 *
 * Each peer publishes a small JSON manifest at a well-known path so the
 * other side can pin its identity key, allowed callback URLs, and (for
 * relay-using hosts) its preferred relay endpoint:
 *
 * - `https://<host>/.well-known/tempocp/host.json`     ({@link HostDocument})
 * - `https://<consumer>/.well-known/tempocp/consumer.json` ({@link ConsumerDocument})
 *
 * Phases that auto-fetch (e.g. `mobileLink({ host: 'https://wallet.example' })`)
 * call {@link fetchHost} / {@link fetchConsumer}. Pre-parsed callers can
 * skip the fetch and pass a {@link HostDocument} directly.
 */

import { z } from 'zod'

import * as Errors from './Errors.js'

const wellKnownPath = '/.well-known/tempocp'

/** Zod schemas for the published discovery documents. */
export namespace schema {
  /** 32-byte `0x`-prefixed hex public key. */
  export const hexPubkey = z.templateLiteral(
    ['0x', z.string().regex(/^[0-9a-fA-F]{64}$/)],
    'expected 32-byte 0x-prefixed hex pubkey',
  )

  /** Plain `https://`-only URL. */
  export const httpsUrl = z.url({
    protocol: /^https$/,
    error: 'expected an https:// URL',
  })

  /** Host-side discovery manifest published at `host.json`. */
  export const hostDocument = z.object({
    /** Spec version of the document (currently `1`). */
    version: z.literal(1),
    /** Host's long-term Ed25519 identity public key, 32 bytes hex. */
    identity_pubkey: hexPubkey,
    /**
     * Optional relay endpoint the host advertises for `relay`-based pairing.
     * Required for `relay()` consumer-side bootstrap; ignored otherwise.
     */
    relay_url: httpsUrl.optional(),
    /**
     * Optional deep-link / Universal-Link URL the host listens on for
     * `mobileLink`. Required for `mobileLink({ host })` flow.
     */
    deep_link_url: httpsUrl.optional(),
    /**
     * Allowlist of `webhook_url` prefixes the host will deliver outbound
     * `webhookCallback` traffic to. Required for `webhookCallback()` host-side.
     */
    callback_urls: z.array(httpsUrl).optional(),
  })

  /** Consumer-side discovery manifest published at `consumer.json`. */
  export const consumerDocument = z.object({
    /** Spec version of the document (currently `1`). */
    version: z.literal(1),
    /** Consumer's long-term Ed25519 identity public key, 32 bytes hex. */
    identity_pubkey: hexPubkey,
    /**
     * Allowlist of `webhook_url` prefixes the consumer accepts. Hosts MUST
     * verify the consumer's `webhook_url` matches one of these.
     */
    callback_urls: z.array(httpsUrl).optional(),
  })
}

/** Parsed `host.json`. */
export type HostDocument = z.output<typeof schema.hostDocument>

/** Parsed `consumer.json`. */
export type ConsumerDocument = z.output<typeof schema.consumerDocument>

/**
 * Compose the full discovery URL for a host's `host.json`.
 *
 * @example
 * ```ts
 * Discovery.hostUrl('https://wallet.example')
 * // 'https://wallet.example/.well-known/tempocp/host.json'
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
 * Fetch and parse a host's `host.json`. The optional `fetch` override is
 * primarily for tests — production code uses the platform `fetch`.
 *
 * @example
 * ```ts
 * import { Discovery } from 'handshakes'
 *
 * const host = await Discovery.fetchHost('https://wallet.example')
 * ```
 */
export async function fetchHost(
  origin: string,
  options: fetchHost.Options = {},
): Promise<HostDocument> {
  return parseHost(await fetchJson(hostUrl(origin), options))
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
 * Fetch and parse a consumer's `consumer.json`.
 */
export async function fetchConsumer(
  origin: string,
  options: fetchConsumer.Options = {},
): Promise<ConsumerDocument> {
  return parseConsumer(await fetchJson(consumerUrl(origin), options))
}

export declare namespace fetchConsumer {
  /** Options for {@link fetchConsumer}. */
  type Options = fetchHost.Options
}

async function fetchJson(
  url: string,
  options: { fetch?: typeof fetch | undefined; signal?: AbortSignal | undefined },
): Promise<unknown> {
  const fetchFn = options.fetch ?? fetch
  let response: Response
  try {
    response = await fetchFn(url, {
      headers: { accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (cause) {
    throw new Errors.ProtocolError('discovery fetch failed', {
      details: `${url}: ${(cause as Error).message}`,
      cause: cause as Error,
    })
  }
  if (!response.ok)
    throw new Errors.ProtocolError('discovery fetch returned non-2xx', {
      details: `${url}: ${response.status} ${response.statusText}`,
    })
  try {
    return await response.json()
  } catch (cause) {
    throw new Errors.ProtocolError('discovery response is not valid JSON', {
      details: `${url}: ${(cause as Error).message}`,
      cause: cause as Error,
    })
  }
}

function joinOrigin(origin: string, path: string): string {
  return origin.replace(/\/+$/, '') + path
}

function assertParse<schema extends z.ZodType>(
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
