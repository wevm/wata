/**
 * Minimal pluggable key/value store contract used by HTTP-server-shaped
 * host transports (`deviceCode`, `webhookCallback`, …) for short-lived
 * state — pending device codes, approval records, replay nonces, etc.
 *
 * Values are JSON-serialized when persisted by adapters that need it.
 * TTLs are optional; consumers that need expiry pass `{ ttl }` (in
 * seconds) to {@link Kv.set}, and the implementation lazily evicts
 * (memory) or relies on the backing store's native expiry (Cloudflare
 * KV).
 *
 * @example in-memory (tests, single-process playgrounds)
 * ```ts
 * import { Kv } from 'wata'
 *
 * const store = Kv.memory()
 * await store.set('abc', { status: 'pending' }, { ttl: 60 })
 * const record = await store.get<{ status: string }>('abc')
 * ```
 *
 * @example Cloudflare Workers KV (multi-region, eventually consistent)
 * ```ts
 * import { Kv } from 'wata'
 *
 * export default {
 *   fetch(request: Request, env: Env) {
 *     const store = Kv.cloudflare(env.MY_KV)
 *     // ...
 *   },
 * }
 * ```
 *
 * @example Cloudflare Durable Object (linearizable, supports `take`)
 * ```ts
 * import { Kv } from 'wata'
 *
 * export class Storage extends Kv.Storage {}
 *
 * export default {
 *   fetch(request: Request, env: Env) {
 *     const store = Kv.durableObject(env.STORAGE_DO)
 *     // ...
 *   },
 * }
 * ```
 */

import { Json } from 'ox'

/** Minimal key-value store contract. */
export type Kv = {
  /** Delete a value by key. */
  delete: (key: string) => Promise<void>
  /** Read a value by key. Returns `undefined` when missing or expired. */
  get: <value = unknown>(key: string) => Promise<value | undefined>
  /** Write a value. When `ttl` is set, the entry expires after the given duration in seconds. */
  set: (key: string, value: unknown, options?: set.Options | undefined) => Promise<void>
  /**
   * Atomic read-and-delete. Returns the value if present, `undefined` if
   * missing or expired. Across concurrent callers, exactly one observer
   * receives a non-`undefined` return for a given key, and the key is
   * removed exactly once.
   *
   * Optional. Required for one-time-consume semantics (e.g. RFC 9421
   * replay nonces). Backends without a linearizable read+delete primitive
   * (eventually-consistent stores like Cloudflare KV) should leave this
   * undefined; the consuming handler will refuse to accept the store at
   * construction time and fall back to a different backend.
   */
  take?: <value = unknown>(key: string) => Promise<value | undefined>
}

/** {@link Kv} backend with linearizable atomic read-and-delete support. */
export type AtomicKv = Kv & { take: NonNullable<Kv['take']> }

export declare namespace set {
  /** Options for {@link Kv.set}. */
  type Options = {
    /** Time-to-live in seconds. After this duration, `get` returns `undefined`. */
    ttl?: number | undefined
  }
}

/** Wrap an existing `Kv`-shaped object so the SDK accepts it as a {@link Kv}. */
export function from<kv extends Kv>(kv: kv): kv {
  return kv
}

/**
 * Adapt a Cloudflare Workers KV namespace (or compatible binding) into a
 * {@link Kv}. Uses the underlying store's native `expirationTtl` for TTL.
 *
 * Cloudflare KV's minimum TTL is 60 seconds; the platform enforces its
 * own minimum independent of what's passed here.
 *
 * **Not safe for one-time-consume semantics.** Cloudflare KV is
 * eventually consistent across data centers — concurrent read+delete
 * races can let the same key be "consumed" twice. `take` is intentionally
 * NOT implemented. Use {@link durableObject} (or another linearizable
 * backend) when you need atomic `take`.
 *
 * @example
 * ```ts
 * import { Kv } from 'wata'
 *
 * const store = Kv.cloudflare(env.MY_KV)
 * ```
 */
export function cloudflare(kv: cloudflare.Parameters): Kv {
  return from({
    delete: kv.delete.bind(kv),
    async get(key) {
      return (await kv.get(key, 'json')) ?? undefined
    },
    async set(key, value, options) {
      const expirationTtl = options?.ttl
      await kv.put(key, Json.stringify(value), expirationTtl ? { expirationTtl } : undefined)
    },
  })
}

export declare namespace cloudflare {
  /**
   * Minimal shape of a Cloudflare Workers KV binding. Compatible with
   * `KVNamespace` from `@cloudflare/workers-types`.
   */
  type Parameters = {
    delete: (key: string) => Promise<void>
    get: <value = unknown>(key: string, format: 'json') => Promise<value | null>
    put: (
      key: string,
      value: string,
      options?: { expirationTtl?: number } | undefined,
    ) => Promise<void>
  }
}

/**
 * Adapt a Cloudflare Durable Object namespace into a {@link Kv} with
 * atomic `take`. Unlike {@link cloudflare}, a Durable Object's storage
 * is single-actor and linearizable — `take` (read+delete) is guaranteed
 * atomic across concurrent callers, which makes this the recommended
 * backend when one-time-consume semantics matter.
 *
 * Pair with {@link Storage} (or your own DO class implementing the same
 * fetch protocol).
 *
 * @example
 * ```ts
 * // wrangler.jsonc
 * // {
 * //   "durable_objects": {
 * //     "bindings": [{ "name": "STORAGE_DO", "class_name": "Storage" }]
 * //   },
 * //   "migrations": [{ "tag": "v1", "new_classes": ["Storage"] }]
 * // }
 *
 * // worker.ts
 * import { Kv } from 'wata'
 *
 * export class Storage extends Kv.Storage {}
 *
 * export default {
 *   fetch(request: Request, env: Env) {
 *     const store = Kv.durableObject(env.STORAGE_DO)
 *     // ...
 *   },
 * }
 * ```
 */
export function durableObject(
  namespace: durableObject.Namespace,
  options: durableObject.Options = {},
): AtomicKv {
  const instanceName = options.name ?? 'default'
  const stub = () => namespace.get(namespace.idFromName(instanceName))

  async function rpc(op: string, key: string, body?: unknown): Promise<unknown> {
    const url = `https://do.invalid/${op}?key=${encodeURIComponent(key)}`
    const init: RequestInit =
      body !== undefined
        ? {
            body: Json.stringify(body),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        : { method: 'POST' }
    const response = await stub().fetch(url, init as never)
    if (!response.ok) throw new Error(`Kv.durableObject ${op} failed: ${response.status}`)
    return await response.json()
  }

  return from({
    async delete(key) {
      await rpc('delete', key)
    },
    async get(key) {
      const { value } = (await rpc('get', key)) as { value: unknown }
      return value as never
    },
    async set(key, value, options) {
      await rpc('set', key, { ttl: options?.ttl, value })
    },
    async take(key) {
      const { value } = (await rpc('take', key)) as { value: unknown }
      return value as never
    },
  })
}

export declare namespace durableObject {
  /**
   * Minimal shape of a Cloudflare Durable Object namespace binding.
   * Compatible with `DurableObjectNamespace` from
   * `@cloudflare/workers-types`.
   */
  type Namespace = {
    get: (id: unknown) => { fetch: (input: string, init?: unknown) => Promise<Response> }
    idFromName: (name: string) => unknown
  }
  /** Options for {@link durableObject}. */
  type Options = {
    /**
     * Durable Object instance name. Defaults to `'default'` (a single
     * shared actor). Use a per-tenant name if you need isolation.
     */
    name?: string | undefined
  }
}

/**
 * Reference Durable Object class implementing the {@link durableObject}
 * fetch protocol. Export from your Worker entry and bind it under
 * `class_name: "Storage"` in `wrangler.jsonc`.
 *
 * The class is framework-agnostic — it doesn't import
 * `cloudflare:workers` so it works with both the legacy DO API
 * (`fetch(req)` only) and the newer `extends DurableObject` API.
 */
export class Storage {
  state: Storage.State

  constructor(state: Storage.State, _env?: unknown) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const op = url.pathname.replace(/^\//, '')
    const key = url.searchParams.get('key')
    if (!key) return Response.json({ error: 'missing `key`' }, { status: 400 })

    const isExpired = (entry: { expiresAt?: number } | undefined) =>
      Boolean(entry?.expiresAt && Date.now() >= entry.expiresAt)

    if (op === 'get') {
      const entry = await this.state.storage.get<Storage.Entry>(key)
      if (!entry || isExpired(entry)) return Response.json({ value: undefined })
      return Response.json({ value: entry.value })
    }
    if (op === 'take') {
      const entry = await this.state.storage.get<Storage.Entry>(key)
      if (!entry || isExpired(entry)) {
        if (entry) await this.state.storage.delete(key)
        return Response.json({ value: undefined })
      }
      await this.state.storage.delete(key)
      return Response.json({ value: entry.value })
    }
    if (op === 'set') {
      const body = (await request.json()) as { ttl?: number; value: unknown }
      const entry: Storage.Entry = body.ttl
        ? { expiresAt: Date.now() + body.ttl * 1000, value: body.value }
        : { value: body.value }
      await this.state.storage.put(key, entry)
      return Response.json({})
    }
    if (op === 'delete') {
      await this.state.storage.delete(key)
      return Response.json({})
    }
    return Response.json({ error: `unknown op: ${op}` }, { status: 400 })
  }
}

export declare namespace Storage {
  /** Internal storage shape: value plus optional absolute expiry timestamp (ms). */
  type Entry = { expiresAt?: number; value: unknown }
  /** Subset of `DurableObjectState` actually used by {@link Storage}. */
  type State = {
    storage: {
      delete: (key: string) => Promise<void>
      get: <T = unknown>(key: string) => Promise<T | undefined>
      put: (key: string, value: unknown) => Promise<void>
    }
  }
}

/**
 * In-memory {@link Kv} for tests and single-process deployments. Lazily
 * evicts expired entries on read/write.
 *
 * Pass `now` to control the clock in tests.
 *
 * @example
 * ```ts
 * import { Kv } from 'wata'
 *
 * const store = Kv.memory()
 * ```
 */
export function memory(options: memory.Options = {}): AtomicKv {
  const now = options.now ?? Date.now
  const store = new Map<string, { expiresAt?: number; value: unknown }>()

  function isExpired(entry: { expiresAt?: number }): boolean {
    return entry.expiresAt !== undefined && now() >= entry.expiresAt
  }

  return from({
    async delete(key) {
      store.delete(key)
    },
    async get(key) {
      const entry = store.get(key)
      if (!entry) return undefined
      if (isExpired(entry)) {
        store.delete(key)
        return undefined
      }
      return entry.value as never
    },
    async set(key, value, options) {
      const expiresAt = options?.ttl ? now() + options.ttl * 1000 : undefined
      store.set(key, expiresAt !== undefined ? { expiresAt, value } : { value })
    },
    // Atomic in-process: the synchronous `Map.get` + `Map.delete` runs in
    // a single microtask, so concurrent `take(key)` callers (within the
    // same Node/Bun/Worker process) cannot both observe the value.
    async take(key) {
      const entry = store.get(key)
      if (!entry) return undefined
      store.delete(key)
      if (isExpired(entry)) return undefined
      return entry.value as never
    },
  })
}

export declare namespace memory {
  /** Options for {@link memory}. */
  type Options = {
    /** Clock function for TTL accounting. Defaults to `Date.now`. */
    now?: (() => number) | undefined
  }
}
