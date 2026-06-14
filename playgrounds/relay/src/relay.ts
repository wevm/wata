/**
 * Relay server for the playground — a stateless rendezvous.
 *
 * Authenticates which peer may push to a channel and forwards opaque
 * end-to-end-encrypted bodies between the two peer slots, never seeing
 * plaintext. `buffer: {}` enables bounded receiver-absence buffering
 * (spec §5.4) so a message sent while the other peer is between short
 * polls (or briefly reconnecting) is held in a small per-slot queue and
 * drained when that peer next subscribes, instead of being dropped.
 */

import { serve } from '@hono/node-server'
import { Relay, Store } from 'wata/server'

const port = Number(process.env.PORT ?? 4860)

serve({ fetch: Relay.create({ buffer: {}, store: Store.memory() }).fetch, port }, (info) => {
  console.log(`relay listening on http://localhost:${info.port}`)
})
