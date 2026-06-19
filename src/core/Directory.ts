/**
 * Consumer-side directory client and unified item model.
 *
 * Lists connectable peers for the transports named in {@link query} and merges
 * them into one homogeneous {@link Item} list. Each item advertises what it
 * speaks via {@link Item.transports}: uRPC transports (`relay`, `mobile-link`,
 * …) are presence markers -- connect by re-fetching the item's `host.json`
 * from its `origin`; `walletConnect` carries its deep links inline. The
 * built-in {@link urpc} source queries a uRPC directory server's
 * `GET /v1/hosts`; `'walletConnect'` lists wallets from the WalletConnect
 * registry (a small, SDK-free client). Custom {@link Source}s merge via
 * {@link query.Options.sources}.
 *
 * The directory is non-authoritative -- before connecting to a uRPC host,
 * re-fetch its `host.json` via {@link Discovery.fetchHost}.
 *
 * @example
 * ```ts
 * import { Directory } from 'wata'
 *
 * const { items } = await Directory.query({
 *   url: 'https://directory.example',
 *   transports: ['relay', 'walletConnect'],
 *   walletConnect: { projectId },
 * })
 * for (const item of items) {
 *   if (item.transports.walletConnect) {
 *     // connect via walletConnect(), target = item.transports.walletConnect.mobile?.native
 *   } else if (item.origin) {
 *     // re-fetch host.json from item.origin, then connect via relay() / mobileLink()
 *   }
 * }
 * ```
 */

import { z } from 'zod/mini'

import * as Discovery from './Discovery.js'
import * as Errors from './Errors.js'

/** Per-platform deep links. */
export type Platform = {
  /** Native scheme (e.g. `metamask://`). Preferred for `target` on mobile. */
  native?: string | undefined
  /** Universal/app link (e.g. `https://metamask.app.link`). */
  universal?: string | undefined
}

/** WalletConnect transport binding -- deep links + chains from the wallet registry. */
export type WalletConnect = {
  /** Supported CAIP-2 chains, when advertised. */
  chains?: readonly string[] | undefined
  /** Desktop deep links. */
  desktop?: Platform | undefined
  /** Mobile deep links -- feed `native` (preferred) or `universal` to a `walletConnect()` `target`. */
  mobile?: Platform | undefined
}

/**
 * Transports a directory item speaks, keyed by transport name. uRPC transports
 * are a presence marker -- re-fetch the item's `host.json` (via
 * {@link Item.origin}) for their bindings; `walletConnect` carries its deep
 * links inline.
 */
export type Transports = {
  [transport: string]: Record<string, never> | WalletConnect | undefined
  walletConnect?: WalletConnect | undefined
}

/** A directory item -- a connectable peer and the transports it speaks. */
export type Item = {
  /** Capability tags advertised by a uRPC host. */
  capabilities?: readonly string[] | undefined
  /** Absolute URL of a square icon, when available. */
  icon?: string | undefined
  /** Stable identifier. */
  id: string
  /** Human-facing display name. */
  name: string
  /**
   * uRPC host origin -- re-fetch `host.json` here for identity + authoritative
   * bindings. Absent for peers without one (e.g. WalletConnect wallets).
   */
  origin?: string | undefined
  /** Transports this peer speaks. */
  transports: Transports
  /** Absolute URL of the host's `host.json`. Absent for peers without one. */
  wellKnownUrl?: string | undefined
}

/**
 * A directory source: queries some backend and yields {@link Item}s. The
 * built-in source is {@link urpc}; others (e.g. the WalletConnect registry via
 * {@link walletConnectSource}) produce the same {@link Item} shape.
 */
export type Source = (options?: Source.Options) => Promise<Source.Result>

export declare namespace Source {
  /** Per-call options forwarded to every source by {@link query}. */
  type Options = {
    /** Override the global `fetch` (test injection). */
    fetch?: typeof globalThis.fetch | undefined
    /** Optional abort signal. */
    signal?: AbortSignal | undefined
  }
  /** One batch of items produced by a source. */
  type Result = {
    /** Opaque next-page cursor, when the source paginates. */
    cursor?: string | null | undefined
    /** Items for this batch. */
    items: readonly Item[]
  }
}

/** Zod schemas for the directory wire shapes. */
export namespace schema {
  /** A single `/v1/hosts` result row (uRPC, wire shape). */
  export const host = z.object({
    capabilities: z.optional(z.array(z.string())),
    icon: z.optional(Discovery.schema.httpsUrl),
    id: z.string().check(z.minLength(1)),
    name: z.string().check(z.minLength(1)),
    origin: Discovery.schema.httpsUrl,
    well_known_url: Discovery.schema.httpsUrl,
  })

  /** `/v1/hosts` response envelope. */
  export const hostsResponse = z.object({
    cursor: z.optional(z.nullable(z.string())),
    items: z.array(host),
  })

  const walletConnectPlatform = z.object({
    native: z.optional(z.string()),
    universal: z.optional(z.string()),
  })

  /** A single WalletConnect `/v3/wallets` listing (subset wata consumes). */
  export const walletConnectListing = z.object({
    chains: z.optional(z.array(z.string())),
    desktop: z.optional(walletConnectPlatform),
    homepage: z.optional(z.string()),
    id: z.string(),
    image_id: z.optional(z.string()),
    mobile: z.optional(walletConnectPlatform),
    name: z.string(),
  })
}

/**
 * Build a {@link Source} over a uRPC directory server's `GET /v1/hosts`. Items
 * carry `origin` / `wellKnownUrl` (re-fetch `host.json` for bindings + identity)
 * and a presence entry under `transports` for the queried transport.
 */
export function urpc(options: urpc.Options): Source {
  return async (sourceOptions = {}) => {
    const fetchImpl = sourceOptions.fetch ?? globalThis.fetch
    const url = new URL('/v1/hosts', options.url)
    if (options.transport) url.searchParams.set('transport', options.transport)
    for (const capability of options.capability ?? [])
      url.searchParams.append('capability', capability)
    if (options.q) url.searchParams.set('q', options.q)
    if (options.cursor) url.searchParams.set('cursor', options.cursor)

    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        ...(sourceOptions.signal ? { signal: sourceOptions.signal } : {}),
      })
    } catch (cause) {
      throw new Errors.BaseError('directory request failed', { cause: cause as Error })
    }
    if (!response.ok)
      throw new Errors.BaseError('directory returned non-2xx', {
        details: `${url.pathname}: ${response.status} ${response.statusText}`,
      })

    const parsed = schema.hostsResponse.safeParse(await response.json())
    if (!parsed.success)
      throw new Errors.BaseError('invalid directory response', {
        details: parsed.error.issues.map((issue) => issue.message).join('; '),
      })
    const items: Item[] = parsed.data.items.map((wire) => ({
      id: wire.id,
      name: wire.name,
      origin: wire.origin,
      transports: options.transport ? { [options.transport]: {} } : {},
      wellKnownUrl: wire.well_known_url,
      ...(wire.capabilities !== undefined ? { capabilities: wire.capabilities } : {}),
      ...(wire.icon !== undefined ? { icon: wire.icon } : {}),
    }))
    return { cursor: parsed.data.cursor ?? null, items }
  }
}

export declare namespace urpc {
  /** Options for {@link urpc}. */
  type Options = {
    /** Repeatable capability filter (host must advertise all). */
    capability?: readonly string[] | undefined
    /** Opaque pagination cursor from a previous result. */
    cursor?: string | undefined
    /** Free-text filter over id / name. */
    q?: string | undefined
    /** Keep only hosts advertising this transport binding (recorded on each item). */
    transport?: string | undefined
    /** Directory server base URL (serving `/v1/hosts`). */
    url: string
  }
}

const walletConnectExplorerUrl = 'https://explorer-api.walletconnect.com'

/** Compose a WalletConnect registry logo URL for a listing `image_id`. */
export function logoUrl(
  imageId: string,
  projectId: string,
  size: 'lg' | 'md' | 'sm' = 'md',
  origin: string = walletConnectExplorerUrl,
): string {
  return `${origin}/v3/logo/${size}/${imageId}?projectId=${encodeURIComponent(projectId)}`
}

/**
 * Build a {@link Source} over the existing WalletConnect directory (Reown
 * Explorer / [WalletGuide](https://walletguide.walletconnect.network/))
 * `/v3/wallets` API. Each item advertises a `walletConnect` transport whose
 * binding carries the wallet's deep links. No WalletConnect SDK dependency;
 * just the public REST registry, gated by `projectId`.
 */
export function walletConnectSource(options: walletConnectSource.Options): Source {
  const {
    apiUrl = walletConnectExplorerUrl,
    chains,
    entries,
    page,
    platforms,
    projectId,
    search,
  } = options
  return async (sourceOptions = {}) => {
    const fetchImpl = sourceOptions.fetch ?? globalThis.fetch
    const url = new URL('/v3/wallets', apiUrl)
    url.searchParams.set('projectId', projectId)
    if (entries !== undefined) url.searchParams.set('entries', String(entries))
    if (page !== undefined) url.searchParams.set('page', String(page))
    if (search) url.searchParams.set('search', search)
    if (chains?.length) url.searchParams.set('chains', chains.join(','))
    if (platforms?.length) url.searchParams.set('platforms', platforms.join(','))

    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        ...(sourceOptions.signal ? { signal: sourceOptions.signal } : {}),
      })
    } catch (cause) {
      throw new Errors.BaseError('WalletConnect directory request failed', {
        cause: cause as Error,
      })
    }
    if (!response.ok)
      throw new Errors.BaseError('WalletConnect directory returned non-2xx', {
        details: `${url.pathname}: ${response.status} ${response.statusText}`,
      })

    const body = (await response.json()) as { listings?: Record<string, unknown> }
    const items: Item[] = []
    for (const raw of Object.values(body.listings ?? {})) {
      const parsed = schema.walletConnectListing.safeParse(raw)
      if (!parsed.success) continue
      const entry = parsed.data
      const walletConnect: WalletConnect = {
        desktop: entry.desktop ?? {},
        mobile: entry.mobile ?? {},
        ...(entry.chains !== undefined ? { chains: entry.chains } : {}),
      }
      items.push({
        id: entry.id,
        name: entry.name,
        transports: { walletConnect },
        ...(entry.image_id !== undefined
          ? { icon: logoUrl(entry.image_id, projectId, 'md', apiUrl) }
          : {}),
      })
    }
    return { items }
  }
}

export declare namespace walletConnectSource {
  /** Options for {@link walletConnectSource}. */
  type Options = {
    /** Override the registry API base URL. Defaults to the Reown Explorer. */
    apiUrl?: string | undefined
    /** Filter by supported CAIP-2 chains (e.g. `['eip155:1']`). */
    chains?: readonly string[] | undefined
    /** Page size; requires {@link Options.page}. */
    entries?: number | undefined
    /** 1-based page index; requires {@link Options.entries}. */
    page?: number | undefined
    /** Filter by platform (`ios`, `android`, `mac`, `injected`). */
    platforms?: readonly string[] | undefined
    /** WalletConnect Cloud project id. */
    projectId: string
    /** Free-text wallet-name filter. */
    search?: string | undefined
  }
}

/**
 * Query the directory and merge results into one homogeneous {@link Item} list.
 * Each name in {@link query.Options.transports} selects a source: a uRPC
 * transport (`relay`, `mobile-link`, …) lists hosts advertising it from the
 * directory server at {@link query.Options.url}; `'walletConnect'` lists wallets
 * from the WalletConnect registry, configured by {@link query.Options.walletConnect}.
 * Extra {@link query.Options.sources} are merged in. Sources run concurrently.
 * Throws if a listed source's config is missing, or if any source rejects.
 *
 * @example
 * ```ts
 * import { Directory } from 'wata'
 *
 * const { items } = await Directory.query({
 *   url: 'https://directory.example',
 *   transports: ['relay', 'walletConnect'],
 *   walletConnect: { projectId },
 * })
 * ```
 */
export async function query(options: query.Options): Promise<{ items: Item[] }> {
  const { capability, cursor, fetch, q, signal, sources, transports, url, walletConnect } = options
  const resolved: Source[] = []
  for (const transport of transports ?? []) {
    if (transport === 'walletConnect') {
      if (!walletConnect)
        throw new Errors.BaseError(
          "`walletConnect` config is required to list the 'walletConnect' directory",
          { details: 'pass `walletConnect: { projectId }`' },
        )
      resolved.push(walletConnectSource(walletConnect))
      continue
    }
    if (!url)
      throw new Errors.BaseError(`\`url\` is required to list the '${transport}' directory`, {
        details: 'pass the uRPC directory server `url`',
      })
    resolved.push(
      urpc({
        transport,
        url,
        ...(capability ? { capability } : {}),
        ...(cursor ? { cursor } : {}),
        ...(q ? { q } : {}),
      }),
    )
  }
  if (sources) resolved.push(...sources)
  const sourceOptions: Source.Options = {
    ...(fetch ? { fetch } : {}),
    ...(signal ? { signal } : {}),
  }
  const results = await Promise.all(resolved.map((source) => source(sourceOptions)))
  return { items: results.flatMap((result) => result.items) }
}

export declare namespace query {
  /** Options for {@link query}. */
  type Options = {
    /** Repeatable capability filter applied to uRPC sources. */
    capability?: readonly string[] | undefined
    /** Opaque pagination cursor applied to uRPC sources. */
    cursor?: string | undefined
    /** Override the global `fetch` (test injection). */
    fetch?: typeof globalThis.fetch | undefined
    /** Free-text filter (id / name) applied to uRPC sources. */
    q?: string | undefined
    /** Optional abort signal. */
    signal?: AbortSignal | undefined
    /** Additional custom sources to merge. */
    sources?: readonly Source[] | undefined
    /**
     * Transport names to include. A uRPC transport (`relay`, `mobile-link`, …)
     * lists hosts advertising it from {@link Options.url}; `'walletConnect'`
     * lists wallets from the WalletConnect registry via {@link Options.walletConnect}.
     */
    transports?: readonly string[] | undefined
    /** uRPC directory server URL (required when a uRPC transport is listed). */
    url?: string | undefined
    /** WalletConnect registry config (required when `'walletConnect'` is listed). */
    walletConnect?: walletConnectSource.Options | undefined
  }
}
