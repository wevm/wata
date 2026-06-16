/**
 * Directory server — hosts `GET /v1/hosts` and indexes hosts via the
 * crawl model.
 *
 * Implements the server half of [uRPC `discovery.md` §3](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md):
 * a public, **non-authoritative** index of uRPC-capable host origins that
 * consumers query to find candidate hosts before fetching each candidate's
 * authoritative `host.json`.
 *
 * - {@link create} returns an `{ fetch }` server exposing `GET {path}/v1/hosts`
 *   with `transport` / `capability` / `q` filters and keyset pagination.
 * - {@link crawl} populates the index from an operator-curated **seed list**
 *   of origins (the spec's [crawl model](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md)),
 *   fetching and validating each origin's `host.json`, refreshing on a
 *   schedule, and evicting entries that stay stale past a threshold.
 *
 * Both share a single pluggable {@link Store.Store}: index entries live
 * under one blob key, so the same store passes to `create` (read) and
 * `crawl` (write). Any backend works ({@link Store.memory},
 * {@link Store.cloudflare}, {@link Store.durableObject}) since only
 * `get`/`set` are used.
 *
 * The directory wire shapes ({@link schema.item}, {@link schema.response})
 * also live here — `create` serializes responses against them, and a
 * directory client parses against them.
 *
 * Each `crawl` call does a single pass and returns — it does not loop on
 * its own. The operator runs it on a schedule (cron, Cloudflare
 * `scheduled` handler, `setInterval`, …).
 *
 * @example serve + periodic crawl
 * ```ts
 * import { Directory, Store } from 'wata/server'
 *
 * const store = Store.memory()
 * const origins = ['https://wallet.example', 'https://other.example']
 *
 * await Directory.crawl({ origins, store })
 * setInterval(() => Directory.crawl({ origins, store }), 60 * 60 * 1000)
 *
 * const handler = Directory.create({ store })
 * ```
 *
 * `Directory.create` returns a web-standard `{ fetch }` handler, so it
 * mounts on any runtime (use `Server.node(handler).listener` for Node's
 * `http`):
 *
 * ```ts
 * createServer(Server.node(handler).listener)         // Node.js
 * Bun.serve({ fetch: handler.fetch })                 // Bun
 * Deno.serve({ fetch: handler.fetch })                // Deno
 * app.all('*', (c) => handler.fetch(c.request))       // Elysia
 * app.use(Server.node(handler).listener)              // Express
 * app.use((c) => handler.fetch(c.req.raw))            // Hono
 * export const GET = handler.fetch                     // Next.js
 * ```
 *
 * @example Cloudflare Worker (KV-backed, crawl on a cron trigger)
 * ```ts
 * import { Directory, Store } from 'wata/server'
 *
 * const origins = ['https://wallet.example']
 *
 * export default {
 *   fetch(request: Request, env: Env) {
 *     return Directory.create({ store: Store.cloudflare(env.DIRECTORY_KV) }).fetch(request)
 *   },
 *   scheduled(_event: ScheduledEvent, env: Env) {
 *     return Directory.crawl({ origins, store: Store.cloudflare(env.DIRECTORY_KV) })
 *   },
 * }
 * ```
 */

import { Hono } from 'hono'
import { Base64 } from 'ox'
import { z } from 'zod/mini'

import * as Discovery from '../core/Discovery.js'
import * as Http from '../core/Http.js'
import * as Store from '../core/Store.js'

/** Zod schemas for the directory query response. */
export namespace schema {
  /**
   * A single directory result row. Mirrors the wire shape of
   * [uRPC `discovery.md` §3.2](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md),
   * transformed to camelCase (`well_known_url` → `wellKnownUrl`) on parse.
   *
   * Every field is a *hint* copied from the indexed `host.json`. None of
   * it is authoritative — a client MUST re-fetch the real document via
   * {@link Discovery.fetchHost} before trusting it.
   */
  export const item = z.pipe(
    z.object({
      /** Capability tags the host advertises (for coarse filtering). */
      capabilities: z.optional(z.array(z.string())),
      /** Stable host identifier (RECOMMENDED to be the bare hostname). */
      id: z.string().check(z.minLength(1)),
      /** Absolute URL of the host's square icon. */
      icon: z.optional(Discovery.schema.httpsUrl),
      /** Human-facing display name. */
      name: z.string().check(z.minLength(1)),
      /** The host's HTTPS origin (`scheme + host + port`). */
      origin: Discovery.schema.httpsUrl,
      /** Absolute URL of the host's authoritative `host.json`. */
      well_known_url: Discovery.schema.httpsUrl,
    }),
    z.transform(
      (
        wire,
      ): {
        capabilities?: readonly string[] | undefined
        icon?: string | undefined
        id: string
        name: string
        origin: string
        wellKnownUrl: string
      } => ({
        id: wire.id,
        name: wire.name,
        origin: wire.origin,
        wellKnownUrl: wire.well_known_url,
        ...(wire.capabilities !== undefined ? { capabilities: wire.capabilities } : {}),
        ...(wire.icon !== undefined ? { icon: wire.icon } : {}),
      }),
    ),
  )

  /** Directory query response envelope ([§3.2](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md)). */
  export const response = z.object({
    /**
     * Opaque pagination cursor. `null` (or absent) when there are no
     * further pages; pass it back as the `cursor` query parameter to
     * fetch the next page.
     */
    cursor: z.optional(z.nullable(z.string())),
    /** Matching host entries for this page. */
    items: z.array(item),
  })
}

/** A single parsed directory result row (camelCase). */
export type Item = z.output<typeof schema.item>

/** Wire (pre-transform) shape of a directory result row, as serialized on the wire. */
export type WireItem = z.input<typeof schema.item>

/** Parsed directory query response (camelCase items). */
export type QueryResult = z.output<typeof schema.response>

/** Wire (pre-transform) shape of the directory query response, as serialized on the wire. */
export type WireQueryResult = z.input<typeof schema.response>

/** Store key under which the whole index blob lives. */
const indexKey = 'urpc:directory:index'

/** Default page size for `GET /v1/hosts`. */
const defaultPageSize = 50

/** One day in milliseconds. */
const day = 24 * 60 * 60 * 1000

/** A single indexed host, keyed in the blob by its seed `origin`. */
type Entry = {
  /** Last successfully fetched + validated `host.json`. */
  document: Discovery.HostDocument
  /** Consecutive crawl failures since the last success. */
  failureCount: number
  /** Timestamp (ms) of the last successful fetch. */
  fetchedAt: number
  /** Host identifier copied from the document. */
  id: string
  /** The seed origin this entry was crawled from. */
  origin: string
  /** Timestamp (ms) of the first failure after the last success, if failing. */
  staleSince?: number | undefined
}

/** The whole index, keyed by seed origin. */
type IndexBlob = Record<string, Entry>

/**
 * Create an `{ fetch }` server that answers directory queries on
 * `GET {path}/v1/hosts`.
 *
 * Reads the index written by {@link crawl} (share the same `store`),
 * applies the `transport` / `capability` / `q` filters, sorts by `id`,
 * and returns one keyset-paginated page as
 * {@link QueryResult}. The directory is non-authoritative —
 * clients re-fetch each result's `host.json` before connecting.
 *
 * Query parameters:
 *
 * | Parameter | Behavior |
 * |-----------|----------|
 * | `transport` | Keep hosts publishing a binding for the named transport. |
 * | `capability` | Repeatable; keep hosts whose `capabilities` include **all** values (AND). |
 * | `q` | Free-text substring match over `id` / `name`. |
 * | `cursor` | Opaque cursor from a previous response's `cursor`. |
 */
export function create(options: create.Options): create.ReturnType {
  const { path, pageSize = defaultPageSize, store } = options
  const app = path ? new Hono().basePath(path) : new Hono()

  app.get('/v1/hosts', async (c) => {
    const url = new URL(c.req.url)
    const transport = url.searchParams.get('transport') ?? undefined
    const capabilities = url.searchParams.getAll('capability')
    const q = url.searchParams.get('q')?.toLowerCase() || undefined
    const cursor = url.searchParams.get('cursor') ?? undefined

    const blob = await readIndex(store)
    const sorted = Object.values(blob).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const filtered = sorted.filter((entry) => matches(entry, { capabilities, q, transport }))

    // Opaque keyset cursor: base64 of the last `id` on the previous page.
    const afterId = (() => {
      if (!cursor) return undefined
      try {
        return Base64.toString(cursor)
      } catch {
        return undefined
      }
    })()
    const begin = afterId === undefined ? 0 : firstIndexAfter(filtered, afterId)
    const page = filtered.slice(begin, begin + pageSize)
    const hasMore = begin + pageSize < filtered.length
    const last = page.at(-1)
    const nextCursor = hasMore && last ? Base64.fromString(last.id) : null

    const items: WireItem[] = page.map((entry) => {
      const { capabilities, icon, name } = entry.document
      return {
        id: entry.id,
        name,
        origin: entry.origin,
        well_known_url: Discovery.hostUrl(entry.origin),
        ...(capabilities ? { capabilities } : {}),
        ...(icon ? { icon } : {}),
      }
    })
    const body: WireQueryResult = { cursor: nextCursor, items }
    return new Response(JSON.stringify(body), {
      headers: {
        'cache-control': 'public, max-age=60',
        'content-type': 'application/json',
      },
      status: 200,
    })
  })

  return Http.fromHono(app)
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options = {
    /** Mount prefix for the `/v1/hosts` route. Defaults to `/`. */
    path?: string | undefined
    /** Maximum entries returned per page. Defaults to `50`. */
    pageSize?: number | undefined
    /** Index persistence. Share the same store passed to {@link crawl}. */
    store: Store.Store
  }

  /** Result of {@link create}. */
  type ReturnType = Http.Server
}

/**
 * Crawl an operator-curated seed list of origins and refresh the index.
 *
 * Implements the [crawl model](https://github.com/tempoxyz/urpc/blob/main/specs/discovery.md):
 * for each origin, fetch and validate `/.well-known/urpc/host.json` via
 * {@link Discovery.fetchHost} and store the result. Fresh successful
 * entries are skipped until `maxRefreshInterval` elapses. A fetch failure
 * marks the entry stale; it is evicted once it has been failing for at
 * least `staleThreshold`, so transient outages do not drop a host.
 *
 * Does a single pass and returns; call it on a schedule (cron, Cloudflare
 * `scheduled`, `setInterval`, etc.) to keep the index fresh.
 *
 * @example
 * ```ts
 * import { Directory, Store } from 'wata/server'
 *
 * const store = Store.memory()
 * const { failed, indexed, removed, skipped } = await Directory.crawl({
 *   origins: ['https://wallet.example', 'https://other.example'],
 *   store,
 * })
 * ```
 */
export async function crawl(options: crawl.Options): Promise<crawl.ReturnType> {
  const {
    fetch,
    maxRefreshInterval = day,
    now = Date.now,
    origins,
    signal,
    staleThreshold = 7 * day,
    store,
  } = options

  const nowMs = now()
  const blob = await readIndex(store)
  let failed = 0
  let indexed = 0
  let removed = 0
  let skipped = 0

  for (const origin of origins) {
    const existing = blob[origin]
    if (
      existing &&
      existing.failureCount === 0 &&
      nowMs - existing.fetchedAt < maxRefreshInterval
    ) {
      skipped++
      continue
    }
    try {
      const document = await Discovery.fetchHost(origin, {
        ...(fetch ? { fetch } : {}),
        ...(signal ? { signal } : {}),
      })
      blob[origin] = {
        document,
        failureCount: 0,
        fetchedAt: nowMs,
        id: document.id,
        origin,
      }
      indexed++
    } catch {
      failed++
      if (!existing) continue
      const staleSince = existing.staleSince ?? nowMs
      if (nowMs - staleSince >= staleThreshold) {
        delete blob[origin]
        removed++
      } else {
        blob[origin] = { ...existing, failureCount: existing.failureCount + 1, staleSince }
      }
    }
  }

  await writeIndex(store, blob)
  return { failed, indexed, removed, skipped }
}

export declare namespace crawl {
  /** Options for {@link crawl}. */
  type Options = {
    /** Override the global `fetch` (test injection). */
    fetch?: typeof fetch | undefined
    /**
     * Minimum time (ms) between successful refetches of the same origin.
     * Defaults to `86_400_000` (24h, spec RECOMMENDED).
     */
    maxRefreshInterval?: number | undefined
    /** Clock function (ms). Defaults to `Date.now`. */
    now?: (() => number) | undefined
    /** Operator-curated seed list of host origins to index. */
    origins: readonly string[]
    /** Optional abort signal forwarded to each fetch. */
    signal?: AbortSignal | undefined
    /**
     * How long (ms) an origin may keep failing before eviction. Defaults
     * to `604_800_000` (7 days, spec RECOMMENDED).
     */
    staleThreshold?: number | undefined
    /** Index persistence. Share the same store passed to {@link create}. */
    store: Store.Store
  }

  /** Summary returned by {@link crawl}. */
  type ReturnType = {
    /** Origins whose fetch failed this run. */
    failed: number
    /** Origins fetched and (re)indexed successfully this run. */
    indexed: number
    /** Stale entries evicted this run. */
    removed: number
    /** Fresh entries skipped (within `maxRefreshInterval`). */
    skipped: number
  }
}

async function readIndex(store: Store.Store): Promise<IndexBlob> {
  return (await store.get<IndexBlob>(indexKey)) ?? {}
}

async function writeIndex(store: Store.Store, blob: IndexBlob): Promise<void> {
  await store.set(indexKey, blob)
}

type Filters = {
  capabilities: readonly string[]
  q: string | undefined
  transport: string | undefined
}

function matches(entry: Entry, filters: Filters): boolean {
  const { capabilities, q, transport } = filters
  if (transport && !entry.document.transports[transport]) return false
  if (capabilities.length) {
    const advertised = entry.document.capabilities ?? []
    if (!capabilities.every((capability) => advertised.includes(capability))) return false
  }
  if (q && !`${entry.id} ${entry.document.name}`.toLowerCase().includes(q)) return false
  return true
}

function firstIndexAfter(entries: readonly Entry[], afterId: string): number {
  const index = entries.findIndex((entry) => entry.id > afterId)
  return index === -1 ? entries.length : index
}
