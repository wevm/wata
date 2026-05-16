/**
 * HTTP-server primitives shared by every HTTP-shaped surface in `wata`.
 *
 * Every adapter that needs to expose HTTP routes — the host transports
 * (`deviceCode`, `webhookCallback`, the callback halves of
 * `mobileWebAuth` / `mobileLink`), the standalone well-known publishers
 * (`hostWellknown` / `consumerWellknown`), and the embedded
 * `Wata.create({ baseUrl, meta })` wrappers — uses the same {@link Server}
 * pair:
 *
 * - `fetch: (request: Request) => Promise<Response>` — web-standard,
 *   runs on Cloudflare Workers / Bun / Deno / Vercel Edge / browsers
 *   without any Node-specific dependencies loading.
 * - `listener: (req, res) => void` — Node `http.RequestListener`-shaped
 *   adapter, lazily backed by `@hono/node-server`'s `getRequestListener`.
 *
 * {@link fromHono} bundles a Hono app into both shapes in one call.
 * The Node listener is **lazily** instantiated on first invocation: the
 * underlying `@hono/node-server` module has top-level value imports of
 * `node:http2` / `node:stream` / `node:process` that would crash a
 * Workers / browser bundle at module-evaluation time. Deferring the
 * `import('@hono/node-server')` until `.listener` is actually called
 * keeps the load path completely free of node primitives for runtimes
 * that only use `.fetch`.
 *
 * {@link Handlers} is the conditional helper `Wata` types use to
 * forward `Server` onto the consumer / host surface when the wrapped
 * transport carries HTTP routes (and collapse it to all-`undefined`
 * when it doesn't).
 */

import type { Hono } from 'hono'

/**
 * Structural shape of `node:http`'s `RequestListener`. Hand-rolled so
 * this file declares no `node:*` value or type imports — keeps the
 * Workers / browser load path completely free of node primitives.
 * Compatible with `node:http`'s real `RequestListener` at the call site.
 */
export type NodeListener = (req: unknown, res: unknown) => void

/**
 * Fetch + lazy Node listener pair returned by {@link fromHono} and
 * exposed by every HTTP-shaped transport / well-known publisher.
 */
export type Server = {
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
 * Conditional that resolves to {@link Server} when `transport` carries
 * HTTP handlers, or to the all-`undefined` counterpart otherwise. Lets
 * `Consumer` / `Host` expose `fetch` + `listener` with a single composed
 * shape instead of two parallel `transport extends { fetch: infer fn }
 * ? fn : undefined` inferences that have to stay in lockstep.
 */
export type Handlers<transport> = transport extends Server
  ? Server
  : { fetch: undefined; listener: undefined }

/**
 * Wrap a Hono app in the standard {@link Server} pair used by every
 * HTTP-server-shaped host transport and well-known publisher.
 *
 * @example
 * ```ts
 * const app = new Hono().basePath('/auth/device')
 * app.post('/register', registerHandler)
 * const { fetch, listener } = Http.fromHono(app)
 * ```
 */
export function fromHono(app: Hono): Server {
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
