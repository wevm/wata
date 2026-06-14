/**
 * Relay server for the playground — a stateless rendezvous.
 *
 * Authenticates which peer may push to a channel and forwards opaque
 * end-to-end-encrypted bodies between the two peer slots, never seeing
 * plaintext.
 */

import { serve } from '@hono/node-server'
import { Relay, Store } from 'wata/server'

const port = Number(process.env.PORT ?? 4860)

serve({ fetch: Relay.create({ store: Store.memory() }).fetch, port }, (info) => {
  console.log(`relay listening on http://localhost:${info.port}`)
})
