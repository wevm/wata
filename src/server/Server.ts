/**
 * Server binding helpers for WATA fetch surfaces.
 */

import { getRequestListener } from '@hono/node-server'
import type { RequestListener } from 'node:http'

import * as Errors from '../core/Errors.js'
import type * as Http from '../core/Http.js'

/** Node HTTP server returned by {@link node}. */
export type Node = Http.Server & {
  /** Node `http.RequestListener` for `node:http.createServer`. */
  listener: RequestListener
}

/**
 * Attach a WATA fetch surface to Node's `http` server API.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { Server } from 'wata/server'
 *
 * const server = Server.node(wata)
 * createServer(server.listener).listen(3000)
 * ```
 */
export function node(options: node.Options): node.ReturnType {
  const fetch = options.fetch
  if (!fetch) throw new Errors.BaseError('`fetch` is required to create a Node server')
  return {
    fetch,
    listener: getRequestListener(fetch) as RequestListener,
  }
}

export declare namespace node {
  /** Options for {@link node}. */
  type Options = {
    /** Web-standard fetch handler exposed by WATA/discovery surfaces. */
    fetch?: Http.Server['fetch'] | undefined
  }

  /** Node HTTP server. */
  type ReturnType = Node
}
