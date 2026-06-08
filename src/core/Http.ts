/**
 * HTTP-server primitives shared by every HTTP-shaped surface in `wata`.
 *
 * Every adapter that needs to expose HTTP routes — transports,
 * standalone well-known publishers, and embedded discovery wrappers —
 * uses the same web-standard {@link Server} shape:
 *
 * - `fetch: (request: Request) => Promise<Response>` — runs on
 *   Cloudflare Workers / Bun / Deno / Vercel Edge / browsers without
 *   any Node-specific dependencies loading.
 *
 * Node `http.RequestListener` binding lives in `wata/server`. Keeping
 * this core layer fetch-only lets React Native / Metro import client
 * transports without resolving `@hono/node-server`.
 *
 * {@link Handlers} is the conditional helper `Wata` types use to
 * forward `Server` onto the consumer / host surface when the wrapped
 * transport carries HTTP routes (and collapse it to `fetch: undefined`
 * when it doesn't).
 */

import type { Hono } from 'hono'

import * as Errors from './Errors.js'

/** Web-standard fetch surface exposed by HTTP-shaped transports. */
export type Server = {
  /** Web-standard fetch handler. Runs on every Request/Response runtime. */
  fetch: (request: Request) => Promise<Response>
}

/**
 * Conditional that resolves to {@link Server} when `transport` carries
 * HTTP handlers, or to the `fetch: undefined` counterpart otherwise.
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
 * Wrap a Hono app in the standard {@link Server} shape used by every
 * HTTP-shaped transport and well-known publisher.
 *
 * @example
 * ```ts
 * const app = new Hono().basePath('/auth/device')
 * app.post('/register', registerHandler)
 * const { fetch } = Http.fromHono(app)
 * ```
 */
export function fromHono(app: Hono): Server {
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
