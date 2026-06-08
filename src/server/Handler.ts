/**
 * Server binding helpers for WATA HTTP surfaces.
 *
 * WATA transports and discovery publishers expose web-standard `fetch`
 * handlers. `Handler` adapts those handlers to process-specific server
 * bindings, starting with Node's `http.RequestListener`.
 */

import * as Http from '../core/Http.js'

/**
 * Convert a WATA `fetch` handler into a Node `http.RequestListener`.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { Handler } from 'wata/server'
 *
 * createServer(Handler.listener(wata.fetch)).listen(3000)
 * ```
 */
export function listener(fetch: listener.Fetch): listener.ReturnType {
  let nodeListener: Http.NodeListener | undefined
  let nodeListenerLoad: Promise<Http.NodeListener> | undefined

  return (req, res) => {
    if (nodeListener) {
      nodeListener(req, res)
      return
    }
    if (!nodeListenerLoad)
      nodeListenerLoad = import('@hono/node-server').then(({ getRequestListener }) => {
        nodeListener = getRequestListener(fetch) as Http.NodeListener
        return nodeListener
      })
    void nodeListenerLoad.then((handler) => handler(req, res))
  }
}

export declare namespace listener {
  /** Web-standard WATA fetch handler. */
  type Fetch = Http.Server['fetch']
  /** Node `http.RequestListener`-shaped adapter. */
  type ReturnType = Http.NodeListener
}

/**
 * Add a Node `http.RequestListener` to a WATA HTTP server object.
 *
 * @example
 * ```ts
 * import { createServer } from 'node:http'
 * import { Handler } from 'wata/server'
 *
 * const server = Handler.withListener(wata)
 * createServer(server.listener).listen(3000)
 * ```
 */
export function withListener<const server extends Http.Server>(
  server: server,
): withListener.ReturnType<server> {
  return {
    ...server,
    listener: listener(server.fetch),
  }
}

export declare namespace withListener {
  /** Node listener fields added to a WATA server. */
  type Server = {
    /** Node `http.RequestListener`-shaped adapter. */
    listener: Http.NodeListener
  }
  /** WATA server plus a Node `http.RequestListener` adapter. */
  type ReturnType<server extends Http.Server> = server & Server
}
