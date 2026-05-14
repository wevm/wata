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

import { z } from 'zod'

import * as Errors from './Errors.js'

const wellKnownPath = '/.well-known/urpc'

/** Spec version literal carried in every discovery document. */
export const version = '1.0'

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

  /**
   * `https://`-only URL that additionally rejects wildcard glob tokens
   * (`*`) anywhere in the URL string. Used for `callback_urls`, where
   * the spec mandates fully-qualified, exact-match entries.
   */
  export const callbackUrl = httpsUrl.refine((value) => !value.includes('*'), {
    message: 'callback_urls must not contain wildcard tokens',
  })

  /** `mobile-link` transport binding. */
  export const mobileLinkTransport = z.object({
    /** Custom URL scheme registered by the host app (e.g. `examplewallet`). */
    scheme: z.string().min(1),
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
    /** HTTPS URL the consumer POSTs to for webhook-callback authorization intent registration. */
    register_url: httpsUrl,
    /** Origin under which the host's `/auth` route lives. */
    auth_url_origin: httpsUrl,
  })

  /**
   * `transports` map. Known keys are validated against their per-transport
   * binding shape; unknown keys are preserved verbatim. Per the spec,
   * known keys whose value fails to validate are silently dropped (the
   * host is treated as not advertising that transport) — `.catch(undefined)`
   * absorbs the parse failure without aborting the document.
   */
  export const transports = z.looseObject({
    'mobile-link': mobileLinkTransport.optional().catch(undefined),
    'mobile-web-auth': mobileWebAuthTransport.optional().catch(undefined),
    relay: relayTransport.optional().catch(undefined),
    'device-code': deviceCodeTransport.optional().catch(undefined),
    window: windowTransport.optional().catch(undefined),
    'webhook-callback': webhookCallbackTransport.optional().catch(undefined),
  })

  /**
   * Header fields shared by `host.json` and `consumer.json`.
   *
   * `origin` is the document's self-asserted origin and MUST equal the
   * scheme + host + port of the URL it was fetched from. {@link fetchHost} /
   * {@link fetchConsumer} enforce this.
   */
  const sharedHeader = {
    /** Spec version of the document (currently `'1.0'`). */
    version: z.literal(version),
    /** Self-asserted origin (`scheme + host + port`); checked against the fetch URL. */
    origin: httpsUrl,
    /** Stable identifier (RECOMMENDED to be the bare hostname). */
    id: z.string().min(1),
  } as const

  /** Host-side discovery manifest published at `host.json`. */
  export const hostDocument = z.object({
    ...sharedHeader,
    /** Human-readable display name. */
    name: z.string().min(1),
    /** Optional URL of a square icon. */
    icon: httpsUrl.optional(),
    /** Optional capability tags for coarse-grained directory filtering. */
    capabilities: z.array(z.string()).optional(),
    /** Host's long-term Ed25519 identity public key, 32 bytes hex. */
    identity_pubkey: hexPubkey,
    /**
     * Per-transport binding map. MUST contain at least one usable entry —
     * known transports with malformed bindings are silently dropped, so
     * the refine counts only entries whose value is defined.
     */
    transports: transports.refine(
      (value) => Object.values(value).some((binding) => binding !== undefined),
      { message: 'transports must contain at least one valid entry' },
    ),
  })

  /** Consumer-side discovery manifest published at `consumer.json`. */
  export const consumerDocument = z.object({
    ...sharedHeader,
    /**
     * Allowlist of fully-qualified callback URLs the consumer accepts.
     * Hosts MUST verify the consumer's `webhook_url` exact-matches one
     * of these. Wildcard segments are rejected.
     */
    callback_urls: z.array(callbackUrl).optional(),
  })
}

/** Parsed `host.json`. */
export type HostDocument = z.output<typeof schema.hostDocument>

/** Parsed `consumer.json`. */
export type ConsumerDocument = z.output<typeof schema.consumerDocument>

/** Parsed `host.json` `transports` map. */
export type Transports = HostDocument['transports']

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
 * import { Discovery } from 'handshakes'
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
