/**
 * uRPC relay server — stateless HTTPS rendezvous for the `relay`
 * transport.
 *
 * Implements the server half of the
 * [uRPC Relay spec](https://github.com/tempoxyz/urpc/blob/main/specs/transport-relay.md):
 * it authenticates which peer may push to a channel (RFC 9421 message
 * signatures, first-write-wins key registration, replay-nonce sets) and
 * forwards opaque bodies between the two peer slots — but never parses
 * message contents. A POST to a slot with no active receiver is retained
 * in a bounded, time-limited, per-slot buffer (spec §5.4) and drained
 * when the peer next subscribes, bridging brief receiver absence. All
 * confidentiality and integrity guarantees live in the peers'
 * end-to-end handshake and AEAD envelope; a compromised relay can only
 * drop traffic and observe metadata.
 *
 * Routes (mounted under {@link create.Options.path}, default `/`):
 *
 * | Route                    | Purpose |
 * |--------------------------|---------|
 * | `GET  /:channelId/:peer` | Subscribe the peer's inbound receiver — SSE (`Accept: text/event-stream`) or long-poll (`Accept: application/json`, spec §5.3). |
 * | `POST /:channelId/:peer` | Deliver a message to `:peer`'s active receiver. |
 *
 * Active receivers are held **in memory**, so the live SSE/long-poll
 * socket only works when both peers of a channel reach the same instance.
 * A single long-lived process (Node/Bun/Deno) satisfies this for free; on
 * Cloudflare, route each channel to its own **Durable Object** (one DO
 * instance per `channel_id`) rather than a bare stateless Worker —
 * separate Worker isolates do not share the receiver map, so a POST and
 * its SSE stream can land on different isolates and never meet. Key
 * registrations, replay nonces, and (when enabled) the receiver-absence
 * buffer all live in the single pluggable {@link Store.Store} `store`. Per-IP
 * rate limiting is a deployment concern (spec §10.5) — run this behind
 * your edge's limiter.
 *
 * @example Node (single long-lived process)
 * ```ts
 * import { createServer } from 'node:http'
 * import { Relay, Server, Store } from 'wata/server'
 *
 * const relay = Relay.create({ store: Store.memory() })
 * createServer(Server.node(relay).listener).listen(8787)
 * ```
 *
 * @example Cloudflare (one Durable Object per channel)
 * ```ts
 * import { Relay, Store } from 'wata/server'
 *
 * // The Durable Object is the channel's single home for the in-memory
 * // receiver map; one `store` holds registrations, nonces, and the
 * // durable buffer.
 * export class Channel {
 *   relay: ReturnType<typeof Relay.create>
 *   constructor(_ctx: DurableObjectState, env: Env) {
 *     this.relay = Relay.create({ store: Store.durableObject(env.STORAGE_DO) })
 *   }
 *   fetch(request: Request) {
 *     return this.relay.fetch(request)
 *   }
 * }
 *
 * // The Worker routes every request for a channel to that channel's DO,
 * // derived from the `:channelId` path segment.
 * export default {
 *   fetch(request: Request, env: Env) {
 *     const channelId = new URL(request.url).pathname.split('/')[1] ?? ''
 *     const id = env.CHANNEL.idFromName(channelId)
 *     return env.CHANNEL.get(id).fetch(request)
 *   },
 * }
 * ```
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { Bytes, type Hex } from 'ox'

import * as Crypto from '../core/Crypto.js'
import * as Http from '../core/Http.js'
import * as MessageSig from '../core/MessageSig.js'
import * as Store from '../core/Store.js'

/** Peer-slot discriminator carried in the route path (spec §3.1). */
type Peer = 'consumer' | 'host'

/** Authentication failure surfaced as an HTTP error response. */
type AuthFailure = {
  /** Human-readable failure description (`error_description`). */
  description: string
  /** HTTP status to respond with. */
  status: 400 | 401
}

/**
 * Active receiver registered for a `(channelId, peer)` slot — either an
 * SSE stream (spec §5.2) or a parked long-poll request (spec §5.3.2).
 * The relay permits at most one per slot at any instant (spec §5.1 /
 * §5.3.2); all reads and writes of the receiver map happen under the
 * slot mutex so delivery, supersession, and buffer draining never race.
 */
type Receiver = {
  /** Terminate this receiver because a newer subscription arrived (SSE: `closed` event; long-poll: `409`). */
  supersede: () => Promise<void>
  /**
   * Deliver a verbatim POST body. Resolves `true` if the receiver is
   * still active afterwards (SSE — stays subscribed) or `false` if this
   * delivery consumed it (long-poll — single `200` response). Rejects
   * if the underlying stream is gone.
   */
  write: (data: string) => Promise<boolean>
}

/** A buffered body awaiting a receiver, persisted in the {@link Store.Store} store (spec §5.4). */
type Buffered = {
  /** Verbatim POST body (opaque ciphertext, or the host's plaintext `hello`). */
  body: string
  /** UTF-8 byte length, tracked for the aggregate-bytes bound. */
  bytes: number
  /** Epoch-ms instant after which the entry is evicted (spec §5.4.2). */
  expiresAt: number
}

/** RFC 9421 `created` acceptance window in seconds (spec §4.4, RECOMMENDED 5 minutes). */
const createdToleranceSeconds = 300

/** 43-character unpadded base64url channel identifier (spec §3.1). */
const channelIdPattern = /^[A-Za-z0-9_-]{43}$/

/** Minimum interval between stream supersessions per slot (spec §10.5). */
const supersessionIntervalMs = 1_000

/** Default long-poll park window in seconds (spec §5.3.1). */
const longPollDefaultWait = 25

/** Maximum permitted long-poll park window in seconds (spec §5.3.1). */
const longPollMaxWait = 60

/** Default per-slot buffer message-count bound (spec §5.4.1, RECOMMENDED ≤ 16). */
const bufferDefaultMaxMessages = 16

/** Default buffered-body TTL in milliseconds (spec §5.4.2, RECOMMENDED 30s). */
const bufferDefaultTtl = 30_000

/**
 * Create a relay server. Returns a web-standard `{ fetch }` surface —
 * mount it on Node via `Server.node`, or hand `fetch` to Cloudflare
 * Workers, Bun, or Deno directly.
 */
export function create(options: create.Options = {}): create.ReturnType {
  const {
    channelTtl = 3_600,
    keepaliveInterval = 25_000,
    maxBodySize = 1_048_576,
    path,
    store = Store.memory(),
  } = options

  // Bounded receiver-absence buffering (spec §5.4) is always on: a POST
  // to a slot with no active receiver is retained in a small, per-slot
  // FIFO queue (in the same `store`) and drained when the peer next
  // subscribes, rather than dropped. The buffer's durability follows the
  // store: a `Store.memory` store keeps it in process; a
  // `Store.durableObject` store survives eviction.
  const bufferConfig = {
    maxBytes: maxBodySize,
    maxMessages: bufferDefaultMaxMessages,
    ttl: bufferDefaultTtl,
  }

  const receivers = new Map<string, Receiver>()
  const supersededAt = new Map<string, number>()

  // Per-slot async mutex. Every mutation of the receiver map and the
  // per-slot buffer runs inside `withSlot`, so POST delivery, new
  // subscriptions, buffer draining, and long-poll timeouts are strictly
  // serialized — no buffer/live reordering and no double-settled poll.
  type Lock = { depth: number; tail: Promise<void> }
  const locks = new Map<string, Lock>()
  async function withSlot<T>(slot: string, fn: () => Promise<T>): Promise<T> {
    let lock = locks.get(slot)
    if (!lock) {
      lock = { depth: 0, tail: Promise.resolve() }
      locks.set(slot, lock)
    }
    lock.depth += 1
    const previous = lock.tail
    let release!: () => void
    lock.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
      lock.depth -= 1
      if (lock.depth === 0 && locks.get(slot) === lock) locks.delete(slot)
    }
  }

  // Per-slot buffer state lives in `store` under one key holding the
  // slot's FIFO array. All of `bufferShift`/`bufferPush` run under the
  // slot lock, so the read-modify-write is never interleaved for a slot
  // — `take` is unnecessary. Per-body expiry is enforced in-app via
  // `prune`; the coarse key TTL only GCs abandoned slots in the backend.
  function bufferKey(slot: string): string {
    return `relay:buf:${slot}`
  }
  function prune(list: Buffered[]): Buffered[] {
    const now = Date.now()
    let index = 0
    while (index < list.length && (list[index] as Buffered).expiresAt <= now) index += 1
    return index > 0 ? list.slice(index) : list
  }
  async function persistBuffer(slot: string, list: Buffered[]): Promise<void> {
    if (list.length === 0) await store.delete(bufferKey(slot))
    else await store.set(bufferKey(slot), list, { ttl: Math.ceil(bufferConfig.ttl / 1000) })
  }

  /**
   * Remove and return the oldest non-expired buffered body for a slot, or
   * `undefined` when the slot is empty (spec §5.4.5, at-most-once). MUST
   * hold the slot lock.
   */
  async function bufferShift(slot: string): Promise<string | undefined> {
    const stored = (await store.get<Buffered[]>(bufferKey(slot))) ?? []
    const list = prune(stored)
    const head = list.shift()
    if (head !== undefined || list.length !== stored.length) await persistBuffer(slot, list)
    return head?.body
  }

  /**
   * Retain a body for an absent receiver (spec §5.4). Returns `true` if
   * buffered, `false` if dropped because the slot's buffer is at its
   * count/byte bound (tail-drop the incoming body, §5.4.4). MUST hold the
   * slot lock.
   */
  async function bufferPush(slot: string, body: string, bytes: number): Promise<boolean> {
    const stored = (await store.get<Buffered[]>(bufferKey(slot))) ?? []
    const list = prune(stored)
    const used = list.reduce((total, entry) => total + entry.bytes, 0)
    if (list.length >= bufferConfig.maxMessages || used + bytes > bufferConfig.maxBytes) {
      if (list.length !== stored.length) await persistBuffer(slot, list)
      return false
    }
    list.push({ body, bytes, expiresAt: Date.now() + bufferConfig.ttl })
    await store.set(bufferKey(slot), list, { ttl: Math.ceil(bufferConfig.ttl / 1000) })
    return true
  }

  function registrationKey(channelId: string, peer: Peer): string {
    return `relay:reg:${channelId}:${peer}`
  }

  function nonceKey(channelId: string, peer: Peer, nonce: string): string {
    return `relay:nonce:${channelId}:${peer}:${nonce}`
  }

  /**
   * Authenticate a request per spec §4. `peer` is the **authenticating**
   * slot: the subscriber's own slot for GETs, the sender's slot (the
   * opposite of the path `:peer`) for POSTs — `keyid` is the channel id
   * for both peers, so the slot decides which registered key applies.
   */
  async function authenticate(parameters: {
    body?: string | undefined
    channelId: string
    extraRequiredComponents?: readonly string[] | undefined
    peer: Peer
    request: Request
    url: string
  }): Promise<AuthFailure | undefined> {
    const { body, channelId, extraRequiredComponents, peer, request, url } = parameters

    let parsedInput: MessageSig.ParsedSignatureInput
    try {
      parsedInput = MessageSig.parseSignatureInput(request.headers.get('signature-input') ?? '')
    } catch (cause) {
      return { description: (cause as Error).message, status: 401 }
    }
    const { alg, created, keyid, nonce } = parsedInput.parameters
    if (alg !== 'ed25519') return { description: 'signature alg must be `ed25519`', status: 401 }
    if (created === undefined) return { description: 'missing signature created', status: 401 }
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - created) > createdToleranceSeconds)
      return { description: 'signature created outside acceptance window', status: 401 }
    if (keyid !== channelId)
      return { description: 'signature keyid must equal the channel id', status: 401 }
    if (!nonce) return { description: 'missing signature nonce', status: 401 }

    // Serialize the stateful section per `(channelId, peer)` so the
    // first-write-wins registration (read → verify → write) and the
    // replay-nonce check (read → write) are each atomic. Without it two
    // concurrent first requests could both read "no registration" and
    // both register (last-writer-wins), and two same-nonce requests
    // could both pass the replay check. Both peers of a channel reach
    // one instance per the deployment model, so this in-process lock is
    // the whole guarantee (a shared multi-instance store would need an
    // atomic conditional write instead).
    return withSlot(`auth:${channelId}:${peer}`, async () => {
      // First-write-wins key registration (spec §4.3). The registered
      // key always wins; a divergent `uRPC-Public-Key` on a later
      // request is rejected outright.
      const declared = request.headers.get('urpc-public-key')
      const registered = await store.get<string>(registrationKey(channelId, peer))
      if (registered && declared && declared !== registered)
        return { description: 'peer slot is registered to a different key', status: 401 }
      const encoded = registered ?? declared
      if (!encoded)
        return { description: 'first request must carry `uRPC-Public-Key`', status: 401 }
      let publicKey: Hex.Hex
      try {
        publicKey = Crypto.decodePublicKey(encoded)
      } catch (cause) {
        return { description: (cause as Error).message, status: 401 }
      }

      const requiredComponents = ['@method', '@path', '@authority']
      if (body !== undefined) requiredComponents.push('content-digest')
      if (!registered) requiredComponents.push('urpc-public-key')
      if (extraRequiredComponents) requiredComponents.push(...extraRequiredComponents)
      let verified: boolean
      try {
        verified = MessageSig.verify({
          message: { headers: collectHeaders(request.headers), method: request.method, url },
          publicKey,
          requiredComponents,
        })
      } catch (cause) {
        return { description: (cause as Error).message, status: 401 }
      }
      if (!verified) return { description: 'signature verification failed', status: 401 }

      // The signature covers the `Content-Digest` header; binding the
      // header to the actual body closes the substitution gap.
      if (body !== undefined) {
        const digest = request.headers.get('content-digest')
        if (digest !== MessageSig.contentDigest(body))
          return { description: '`Content-Digest` does not match the request body', status: 401 }
      }

      // Replay protection (spec §4.4): one nonce, one request, per slot.
      // Hold the nonce for the rest of the signature's acceptance window
      // (`created + tolerance`), not just `tolerance` from now — a
      // future-dated `created` stays valid longer than it would
      // otherwise be remembered, so a shorter TTL would let it be
      // replayed after the nonce expired.
      const seenKey = nonceKey(channelId, peer, nonce)
      if (await store.get(seenKey)) return { description: 'signature nonce replayed', status: 401 }
      await store.set(seenKey, true, {
        ttl: Math.max(1, created + createdToleranceSeconds - now),
      })

      // Persist (and TTL-refresh) the registration — channel state is
      // GC'd `channelTtl` after the last authenticated request (spec
      // §7.3).
      await store.set(registrationKey(channelId, peer), encoded, { ttl: channelTtl })
      return undefined
    })
  }

  /**
   * Refresh the registration TTL for an active receiver's slot so a
   * long-lived (idle) SSE subscription cannot outlive `channelTtl` and
   * leave its slot re-registrable by a squatter (spec §7.3). Idempotent:
   * re-sets the same registered key. Runs under the auth lock so it can't
   * interleave with a concurrent registration.
   */
  async function touchRegistration(channelId: string, peer: Peer): Promise<void> {
    await withSlot(`auth:${channelId}:${peer}`, async () => {
      const encoded = await store.get<string>(registrationKey(channelId, peer))
      if (encoded) await store.set(registrationKey(channelId, peer), encoded, { ttl: channelTtl })
    })
  }

  const app = path ? new Hono().basePath(path) : new Hono()

  app.use(
    '*',
    cors({
      allowHeaders: [
        'Content-Type',
        'Content-Digest',
        'Signature',
        'Signature-Input',
        'uRPC-Public-Key',
      ],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      origin: '*',
    }),
  )
  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-cache, no-store')
  })

  app.get('/:channelId/:peer', async (c) => {
    const params = parseParams(c.req.param('channelId'), c.req.param('peer'))
    if (!params)
      return c.json(
        { error: 'invalid_request', error_description: 'malformed channel id or peer slot' },
        { status: 400 },
      )
    const { channelId, peer } = params

    // Content negotiation (spec §5.3.1): SSE via `text/event-stream`,
    // long-poll via `application/json`. A missing or ambiguous `Accept`
    // is rejected with `400`.
    const accept = c.req.header('accept') ?? ''
    const wantsSse = accept.includes('text/event-stream')
    const wantsJson = accept.includes('application/json')
    if (wantsSse && wantsJson)
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            '`Accept` must not request both `text/event-stream` and `application/json`',
        },
        { status: 400 },
      )
    if (!wantsSse && !wantsJson)
      return c.json(
        {
          error: 'invalid_request',
          error_description: '`Accept` must be `text/event-stream` or `application/json`',
        },
        { status: 400 },
      )

    const slot = `${channelId}/${peer}`

    // Long-poll `wait` (spec §5.3.1): bounded to [0, 60], and — when
    // supplied — covered by the signature via `@query-param;name="wait"`
    // so an intermediary cannot extend or shorten the parked window.
    const waitRaw = wantsJson ? new URL(c.req.url).searchParams.get('wait') : null
    let waitMs = longPollDefaultWait * 1_000
    const extraRequiredComponents: string[] = []
    if (waitRaw !== null) {
      const wait = Number(waitRaw)
      if (!Number.isInteger(wait) || wait < 0 || wait > longPollMaxWait)
        return c.json(
          {
            error: 'invalid_request',
            error_description: `\`wait\` must be an integer between 0 and ${longPollMaxWait}`,
          },
          { status: 400 },
        )
      waitMs = wait * 1_000
      extraRequiredComponents.push('@query-param;name="wait"')
    }

    const failure = await authenticate({
      channelId,
      peer,
      request: c.req.raw,
      url: c.req.url,
      ...(extraRequiredComponents.length > 0 ? { extraRequiredComponents } : {}),
    })
    if (failure)
      return c.json(
        {
          error: failure.status === 401 ? 'unauthorized' : 'invalid_request',
          error_description: failure.description,
        },
        { status: failure.status },
      )

    // Supersession rate limit (spec §10.5) — one authoritative receiver
    // per slot regardless of binding (spec §5.3.2), so this applies to
    // both SSE and long-poll subscriptions.
    if (receivers.get(slot)) {
      const last = supersededAt.get(slot) ?? 0
      if (Date.now() - last < supersessionIntervalMs)
        return c.json(
          { error: 'too_many_requests', error_description: 'receiver superseded too recently' },
          { status: 429 },
        )
      supersededAt.set(slot, Date.now())
    }

    // Long-poll fallback (spec §5.3): park the request as the slot's
    // authoritative receiver and settle it on delivery, supersession, or
    // timeout.
    if (wantsJson) {
      type Result = { body: string; status: 200 } | { status: 204 | 409 | 503 }
      let settle!: (result: Result) => void
      const parked = new Promise<Result>((resolve) => {
        settle = resolve
      })
      let settled = false
      function settleOnce(result: Result) {
        if (settled) return
        settled = true
        settle(result)
      }
      const receiver: Receiver = {
        async supersede() {
          settleOnce({ status: 409 })
        },
        async write(data) {
          settleOnce({ body: data, status: 200 })
          return false
        },
      }

      const immediate = await withSlot(slot, async () => {
        const previous = receivers.get(slot)
        if (previous) {
          receivers.delete(slot)
          await previous.supersede()
        }
        // Drain the single oldest buffered body immediately (spec
        // §5.3.2 / §5.4.6); the remainder stay buffered for the next
        // poll.
        const head = await bufferShift(slot)
        if (head !== undefined) return head
        receivers.set(slot, receiver)
        return undefined
      })
      if (immediate !== undefined)
        return c.body(immediate, 200, { 'Content-Type': 'application/json' })

      // The timeout removes the receiver under the slot lock so a racing
      // POST cannot deliver to a poll that has already given up — the
      // settle and the receiver's liveness flip together (no
      // double-settle, spec §5.4.5).
      const timer = setTimeout(() => {
        void withSlot(slot, async () => {
          if (receivers.get(slot) === receiver) {
            receivers.delete(slot)
            settleOnce({ status: 204 })
          }
        })
      }, waitMs)
      const onAbort = () => {
        void withSlot(slot, async () => {
          if (receivers.get(slot) === receiver) receivers.delete(slot)
          settleOnce({ status: 503 })
        })
      }
      c.req.raw.signal.addEventListener('abort', onAbort)
      try {
        const result = await parked
        if (result.status === 200)
          return c.body(result.body, 200, { 'Content-Type': 'application/json' })
        return c.body(null, result.status)
      } finally {
        clearTimeout(timer)
        c.req.raw.signal.removeEventListener('abort', onAbort)
      }
    }

    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      type Deferred = { promise: Promise<void>; resolve: () => void }
      const closed: Deferred = (() => {
        let resolve!: () => void
        const promise = new Promise<void>((r) => {
          resolve = r
        })
        return { promise, resolve }
      })()
      const receiver: Receiver = {
        async supersede() {
          try {
            await stream.writeSSE({ data: '{}', event: 'closed' })
          } catch {
            // The old stream may already be gone; supersession proceeds.
          }
          closed.resolve()
        },
        async write(data) {
          await stream.writeSSE({ data, event: 'message' })
          return true
        },
      }
      stream.onAbort(() => {
        void withSlot(slot, async () => {
          if (receivers.get(slot) === receiver) receivers.delete(slot)
        })
        closed.resolve()
      })
      // Supersede, register, emit `opened`, and drain the buffer (FIFO)
      // under the slot lock so any concurrent POST is delivered only
      // after the buffered backlog (drain-before-live, spec §5.4.6).
      await withSlot(slot, async () => {
        const previous = receivers.get(slot)
        if (previous) {
          receivers.delete(slot)
          await previous.supersede()
        }
        receivers.set(slot, receiver)
        await stream.writeSSE({ data: '{}', event: 'opened' })
        for (let head = await bufferShift(slot); head !== undefined; head = await bufferShift(slot))
          await receiver.write(head)
      })
      // Keep the connection warm through proxies and, on the same beat,
      // refresh the slot's registration TTL so a long-lived idle stream
      // never lets `channelTtl` lapse and its slot become re-registrable.
      const keepalive = setInterval(() => {
        void touchRegistration(channelId, peer)
        stream.write(': keepalive\n\n').catch(() => closed.resolve())
      }, keepaliveInterval)
      try {
        await closed.promise
      } finally {
        clearInterval(keepalive)
        await withSlot(slot, async () => {
          if (receivers.get(slot) === receiver) receivers.delete(slot)
        })
      }
    })
  })

  // Bound the request body *before* it is read into memory (spec §5.4.1).
  // The middleware short-circuits on an oversized `Content-Length` and
  // otherwise streams with a running byte cap, so a malicious sender can
  // never force the relay to buffer an unbounded body.
  const limitBody = bodyLimit({
    maxSize: maxBodySize,
    onError: (c) =>
      c.json(
        { error: 'payload_too_large', error_description: 'request body exceeds the relay limit' },
        { status: 413 },
      ),
  })

  app.post('/:channelId/:peer', limitBody, async (c) => {
    const params = parseParams(c.req.param('channelId'), c.req.param('peer'))
    if (!params)
      return c.json(
        { error: 'invalid_request', error_description: 'malformed channel id or peer slot' },
        { status: 400 },
      )
    const { channelId, peer } = params
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.startsWith('application/json'))
      return c.json(
        {
          error: 'invalid_request',
          error_description: '`Content-Type` must be `application/json`',
        },
        { status: 400 },
      )
    // `limitBody` already bounded the body to `maxBodySize`.
    const body = await c.req.text()
    const bytes = Bytes.fromString(body).length
    // POSTs are signed by the *sender* — the opposite slot of the
    // destination `:peer` in the path.
    const failure = await authenticate({
      body,
      channelId,
      peer: peer === 'consumer' ? 'host' : 'consumer',
      request: c.req.raw,
      url: c.req.url,
    })
    if (failure)
      return c.json(
        {
          error: failure.status === 401 ? 'unauthorized' : 'invalid_request',
          error_description: failure.description,
        },
        { status: failure.status },
      )

    // Deliver verbatim to the destination slot's active receiver under
    // the slot lock so delivery, supersession, and draining never race.
    // With no receiver the relay buffers the body (spec §5.4 — `202`),
    // tail-dropping only when the slot's buffer is full (`204`).
    const slot = `${channelId}/${peer}`
    const status = await withSlot(slot, async () => {
      const receiver = receivers.get(slot)
      if (receiver) {
        try {
          const alive = await receiver.write(body)
          if (!alive && receivers.get(slot) === receiver) receivers.delete(slot)
          return 202
        } catch {
          if (receivers.get(slot) === receiver) receivers.delete(slot)
          // Stream is gone — treat as an absent receiver and fall
          // through to buffer-or-drop.
        }
      }
      return (await bufferPush(slot, body, bytes)) ? 202 : 204
    })
    return c.body(null, status)
  })

  return { fetch: Http.fromHono(app).fetch }
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options = {
    /**
     * Channel-state TTL in seconds: key registrations (and with them the
     * channel) are GC'd this long after the last authenticated request.
     * Defaults to 3600 (spec §7.3 RECOMMENDED 1 hour).
     */
    channelTtl?: number | undefined
    /**
     * SSE keepalive comment cadence in milliseconds, keeping idle
     * streams alive through proxies. Defaults to 25_000.
     */
    keepaliveInterval?: number | undefined
    /**
     * Maximum POST body size in bytes. Defaults to 1 MiB (spec §10.5).
     */
    maxBodySize?: number | undefined
    /** Mount prefix for the two relay routes. Defaults to `/`. */
    path?: string | undefined
    /**
     * Persistence for key registrations and replay-nonce sets. Defaults
     * to a fresh {@link Store.memory} store — fine for the single-process
     * deployments the in-memory receiver map implies.
     */
    store?: Store.Store | undefined
  }

  /** Result of {@link create}. */
  type ReturnType = Http.Server
}

/** Validate and narrow the `:channelId` / `:peer` path parameters. */
function parseParams(
  channelId: string,
  peer: string,
): { channelId: string; peer: Peer } | undefined {
  if (!channelIdPattern.test(channelId)) return undefined
  if (peer !== 'consumer' && peer !== 'host') return undefined
  return { channelId, peer }
}

/** Copy a `Headers` object into the plain record `MessageSig` consumes. */
function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}
