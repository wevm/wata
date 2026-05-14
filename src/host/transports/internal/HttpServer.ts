/**
 * Internal helper for HTTP-server-shaped host transports.
 *
 * Every host transport that exposes HTTP routes — `deviceCode`,
 * `webhookCallback`, the callback halves of `mobileWebAuth` /
 * `mobileLink` — needs the same pair of public handlers:
 *
 * - `.fetch: (request: Request) => Promise<Response>` — web-standard,
 *   runs on Cloudflare Workers / Bun / Deno / Vercel Edge / browsers
 *   without any Node-specific dependencies loading.
 * - `.listener: (req, res) => void` — Node `http.RequestListener`-shaped
 *   adapter, backed by `@hono/node-server`'s `getRequestListener`.
 *
 * {@link fromHono} bundles a `Hono` app into both shapes in one call.
 * The Node listener is **lazily** instantiated on first invocation: the
 * underlying `@hono/node-server` module has top-level value imports of
 * `node:http2` / `node:stream` / `node:process` that would crash a
 * Workers / browser bundle at module-evaluation time. Deferring the
 * `import('@hono/node-server')` until `.listener` is actually called
 * keeps the load path completely free of node primitives for runtimes
 * that only use `.fetch`.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import * as HttpServer from './internal/HttpServer.js'
 *
 * const app = new Hono()
 * app.post('/register', (c) => c.json({ ok: true }))
 *
 * const { fetch, listener } = HttpServer.fromHono(app)
 *
 * // .fetch runs anywhere Request/Response do
 * const response = await fetch(new Request('https://x/register', { method: 'POST' }))
 *
 * // .listener works with Node's createServer
 * import { createServer } from 'node:http'
 * createServer(listener).listen(3000)
 * ```
 */

import type { Hono } from 'hono'

/**
 * Structural shape of `node:http`'s `RequestListener`. Hand-rolled so
 * this file declares no `node:*` value or type imports — keeps the
 * Workers / browser load path completely free of node primitives.
 * Compatible with `node:http`'s real `RequestListener` at the call site.
 */
export type NodeListener = (req: NodeIncomingMessage, res: NodeServerResponse) => void

/** Structural shape of `node:http`'s `IncomingMessage`. */
export type NodeIncomingMessage = unknown

/** Structural shape of `node:http`'s `ServerResponse`. */
export type NodeServerResponse = unknown

/** The `.fetch` + `.listener` pair returned by {@link fromHono}. */
export type HttpServer = {
  /** Web-standard fetch handler. Runs on every Request/Response runtime. */
  fetch: (request: Request) => Promise<Response>
  /**
   * Node `http.RequestListener`-shaped adapter. Lazily backed by
   * `@hono/node-server`'s `getRequestListener` on first invocation so
   * Workers / browser bundles never load the node-only module.
   */
  listener: NodeListener
}

/**
 * Wrap a Hono app in the standard `.fetch` + `.listener` pair used by
 * every HTTP-server-shaped host transport.
 *
 * @example
 * ```ts
 * const app = new Hono().basePath('/auth/device')
 * app.post('/register', registerHandler)
 * const { fetch, listener } = HttpServer.fromHono(app)
 * ```
 */
export function fromHono(app: Hono): HttpServer {
  // `app.fetch` is the canonical web-standard handler — it accepts a
  // single `Request` (the `env` / `executionCtx` parameters expected by
  // CF Workers are positional and absent calls coerce to `undefined`).
  // Wrapping in `Promise.resolve` normalizes the return type to
  // `Promise<Response>` so consumers don't have to handle the
  // `Response | Promise<Response>` union.
  const fetch = (request: Request): Promise<Response> => Promise.resolve(app.fetch(request))

  // Lazy-loaded `getRequestListener` from `@hono/node-server`. Created
  // on first `.listener` invocation so the host transport modules can
  // be imported on Cloudflare Workers (where `@hono/node-server`'s
  // top-level `node:http2` / `node:stream` / `node:process` imports
  // would crash the bundle at module load time).
  let nodeListener: NodeListener | undefined
  let nodeListenerLoad: Promise<NodeListener> | undefined
  const listener: NodeListener = (req, res) => {
    if (nodeListener) {
      nodeListener(req, res)
      return
    }
    if (!nodeListenerLoad)
      nodeListenerLoad = import('@hono/node-server').then(({ getRequestListener }) => {
        nodeListener = getRequestListener(fetch) as NodeListener
        return nodeListener
      })
    void nodeListenerLoad.then((handler) => handler(req, res))
  }

  return { fetch, listener }
}
