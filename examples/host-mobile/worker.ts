/**
 * Discovery worker for the mobile host — publishes `host.json`.
 *
 * In production the host serves its discovery document from its HTTPS origin;
 * the `mobileLink` consumer fetches it to learn the host's scheme + identity.
 * This worker reproduces that on `http://localhost:8788`.
 */

import { Identity, Wata, mobileLink } from 'wata/host'

import { hostIdentityPrivateKey, hostOrigin, hostScheme } from './src/config.js'

const host = Wata.create({
  baseUrl: hostOrigin,
  identity: Identity.fromPrivateKey(hostIdentityPrivateKey),
  meta: { name: 'Wata Wallet' },
  transports: [mobileLink({ scheme: hostScheme })],
})

// `host.json` is built from config (identity + the `mobile-link` binding), so
// it is served directly off `host.fetch` — no transport `start()` is needed
// (and Workers forbid the async I/O that `start()` does at global scope).
const fetch = host.fetch as never as typeof globalThis.fetch

export default {
  async fetch(request: Request) {
    // CORS preflight so a browser consumer can fetch this host's `host.json`.
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
    const response = await fetch(request)
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value)
    return new Response(response.body, { headers, status: response.status })
  },
}

/** Permissive CORS so the browser `consumer-web` can read `host.json`. */
const corsHeaders = {
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-origin': '*',
}
