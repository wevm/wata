import { serve } from '@hono/node-server'

import { consumerOrigin } from './src/config.js'
import { wata } from './src/wata.js'

const fetch = wata.fetch as never as (request: Request) => Response | Promise<Response>
const port = Number(new URL(consumerOrigin).port || '80')
serve({ fetch, port }, () => {
  console.log(`[consumer] discovery: ${consumerOrigin}/.well-known/urpc/consumer.json`)
})
