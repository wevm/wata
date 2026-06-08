/**
 * HTTP-server primitives shared by every HTTP-shaped surface in `wata`.
 *
 * Every adapter that needs to expose HTTP routes — the host transports
 * (`deviceCode`, `webhookCallback`, the callback halves of
 * `mobileWebAuth` / `mobileLink`), the standalone well-known publishers
 * (`hostWellknown` / `consumerWellknown`), and the embedded
 * `Wata.create({ baseUrl, meta })` wrappers — uses the same
 * {@link Server} shape:
 *
 * - `fetch: (request: Request) => Promise<Response>` — web-standard,
 *   runs on Cloudflare Workers / Bun / Deno / Vercel Edge / browsers
 *   without any Node-specific dependencies loading.
 *
 * Node `http.RequestListener` adapters live behind `wata/server`
 * `Handler` helpers so browser and React Native bundles never resolve
 * Node server modules through the universal import graph.
 *
 * {@link Handlers} is the conditional helper `Wata` types use to
 * forward `Server` onto the consumer / host surface when the wrapped
 * transport carries HTTP routes (and collapse it to `undefined` when
 * it doesn't).
 */

import type { Hono } from 'hono'

import * as Errors from './Errors.js'

/**
 * Structural shape of `node:http`'s `RequestListener`. Hand-rolled so
 * this file declares no `node:*` value or type imports — keeps the
 * Workers / browser load path completely free of node primitives.
 * Compatible with `node:http`'s real `RequestListener` at the call site.
 */
export type NodeListener = (req: unknown, res: unknown) => void

/** Fetch handler exposed by every HTTP-shaped transport / publisher. */
export type Server = {
  /** Web-standard fetch handler. Runs on every Request/Response runtime. */
  fetch: (request: Request) => Promise<Response>
}

/**
 * Conditional that resolves to {@link Server} when `transport` carries
 * HTTP handlers, or to the all-`undefined` counterpart otherwise.
 */
export type Handlers<transport> = transport extends Server ? Server : { fetch: undefined }

/** Conditional HTTP handler forwarding for a tuple of transports. */
export type HandlersForTransports<transports extends readonly unknown[]> =
  Extract<transports[number], Server> extends never ? { fetch: undefined } : Server

/** HTTP server with route metadata used by composite `Wata.create`. */
export type RoutedServer = Server & {
  /** Stable transport name used in route-overlap errors. */
  name: string
  /** Path prefixes owned by this HTTP surface. */
  routes?: readonly string[] | undefined
}

/**
 * Wrap a Hono app in the standard {@link Server} used by every
 * HTTP-shaped host transport and well-known publisher.
 *
 * @example
 * ```ts
 * const app = new Hono().basePath('/auth/device')
 * app.post('/register', registerHandler)
 * const { fetch } = Http.fromHono(app)
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

  return { fetch }
}

/**
 * Compose multiple routed HTTP servers into one `{ fetch }`.
 * Requests are dispatched by path prefix. Overlapping route prefixes
 * throw at construction time so runtime dispatch has one clear owner.
 */
export function composeRouted(servers: readonly RoutedServer[]): Server | undefined {
  if (servers.length === 0) return undefined

  type Route = {
    path: string
    server: RoutedServer
  }
  const routes: Route[] = []
  for (const server of servers) {
    if (!server.routes?.length)
      throw new Errors.BaseError(`transport \`${server.name}\` must declare HTTP routes`)
    for (const route of server.routes) {
      const path = normalizeRoute(route)
      const overlap = routes.find((entry) => routesOverlap(entry.path, path))
      if (overlap)
        throw new Errors.BaseError(
          `transport route \`${path}\` overlaps \`${overlap.path}\` from \`${overlap.server.name}\``,
        )
      routes.push({ path, server })
    }
  }

  const fetch: Server['fetch'] = async (request) => {
    const { pathname } = new URL(request.url)
    const route = routes.find((entry) => routeMatches(entry.path, pathname))
    if (!route) return new Response(null, { status: 404 })
    return await route.server.fetch(request)
  }

  return { fetch }
}

function normalizeRoute(route: string): string {
  if (!route.startsWith('/')) throw new Errors.BaseError(`route \`${route}\` must start with /`)
  if (route === '/') return route
  return route.replace(/\/+$/, '')
}

function routeMatches(route: string, pathname: string): boolean {
  if (route === '/') return true
  return pathname === route || pathname.startsWith(`${route}/`)
}

function routesOverlap(a: string, b: string): boolean {
  return routeMatches(a, b) || routeMatches(b, a)
}
