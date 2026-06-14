/**
 * Relay server for the example — a stateless rendezvous.
 *
 * It authenticates which peer may push to a channel and forwards opaque
 * end-to-end-encrypted bodies between the two peer slots. It never sees
 * plaintext or key material. Binds `0.0.0.0` so a physical device on
 * the same LAN can reach it via the dev machine's address.
 *
 * `buffer: {}` enables bounded receiver-absence buffering (spec §5.4): a
 * message sent while the mobile host is briefly backgrounded or
 * reconnecting is held in a small, time-limited, per-slot queue (in the
 * same `store`) and drained when the host re-subscribes, instead of being
 * dropped. This single-process Node server keeps the buffer in memory; a
 * Cloudflare deployment would pass a `Store.durableObject` store so the
 * backlog survives eviction.
 */

import { serve } from '@hono/node-server'
import { Relay, Store } from 'wata/server'

const port = Number(process.env.PORT ?? 4860)

serve(
  { fetch: Relay.create({ buffer: {}, store: Store.memory() }).fetch, hostname: '0.0.0.0', port },
  (info) => {
    console.log(`relay listening on http://localhost:${info.port}`)
  },
)
