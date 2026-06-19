/**
 * Directory server — a public, non-authoritative index of wata hosts.
 *
 * Consumers query `GET /v1/hosts` to discover candidate wallets, then fetch
 * each candidate's authoritative `host.json` to learn which transports it
 * speaks. This demo crawls a fixed seed list of the local example hosts:
 *
 *   http://localhost:5173  → host-web    (window, device-code, mobile-web-auth)
 *   http://localhost:8788  → host-mobile (mobile-link)
 *
 * A real directory crawls on a schedule (cron / `setInterval`); here we crawl
 * on a short loop so freshly-started hosts show up quickly. The handler is
 * wrapped in permissive CORS so the browser `consumer-web` can query it
 * cross-origin.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Directory, Store } from 'wata/server'

const port = Number(process.env.PORT ?? 4870)

/** Operator-curated seed list of host origins to index. */
const origins = [
  process.env.HOST_WEB_URL ?? 'http://localhost:5173',
  process.env.HOST_MOBILE_URL ?? 'http://localhost:8788',
]

const store = Store.memory()
const directory = Directory.create({ store })

// Crawl now, then on a short interval so newly-started hosts appear fast.
async function refresh() {
  const summary = await Directory.crawl({ origins, store })
  console.log(`crawled: ${JSON.stringify(summary)}`)
}
void refresh()
setInterval(() => void refresh(), 10_000)

const app = new Hono()
app.use('*', cors())
app.all('*', (c) => directory.fetch(c.req.raw))

serve({ fetch: app.fetch, hostname: '0.0.0.0', port }, (info) => {
  console.log(`directory listening on http://localhost:${info.port}`)
})
