/**
 * Cloudflare Worker backend for the web host.
 *
 * Composes the two HTTP transports into one session — `deviceCode` (for
 * `consumer-cli`) and `mobileWebAuth` (for `consumer-mobile`) — and
 * serves the discovery document plus the approval routes. The `postMessage`
 * transport runs in the browser (`host.html`), not here.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Session } from 'wata/host'

import { host } from './host.js'

const session = await Session.compose([host.deviceCode.start(), host.mobileWebAuth.start()])

session.onRequest(async (event) => {
  if (event.method === 'eth_requestAccounts' || event.method === 'wallet_connect') {
    await event.respond(['0x0000000000000000000000000000000000000001'])
    return
  }
  if (event.method === 'ping') {
    await event.respond({ message: 'pong from web host', transport: event.transport })
    return
  }
  await event.reject({ code: -32601, message: `method not found: ${event.method}` })
})

const app = new Hono()
  // CORS on discovery so a browser consumer (e.g. `consumer-web` on another
  // origin) can fetch this host's `host.json` after finding it in the directory.
  .use('/.well-known/*', cors())
  .all('/.well-known/*', (c) => host.fetch(c.req.raw))
  .all('/auth/*', (c) => host.fetch(c.req.raw))

export default app
