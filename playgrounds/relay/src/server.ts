import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Wata, relay as hostRelay } from 'wata/host'
import { relayServer } from 'wata/server'

const port = Number(process.env.PORT ?? 4777)
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`
const relayUrl = `${baseUrl}/relay`

const corsHeaders = {
  'access-control-allow-headers': 'accept, content-type, if-none-match',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-origin': '*',
} as const

const host = Wata.create({
  baseUrl,
  meta: { name: 'Relay Playground Host' },
  privateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
  transports: [
    hostRelay({
      pairingSecret: process.env.PAIRING_SECRET ?? 'secret',
      sessionId: process.env.SESSION_ID ?? 'demo',
      url: relayUrl,
    }),
  ],
})
const hostFetch = host.fetch as unknown as (request: Request) => Promise<Response> | Response
const relayHandler = relayServer()

const app = new Hono()
  .options('/.well-known/*', () => new Response(null, { headers: corsHeaders, status: 204 }))
  .all('/.well-known/*', async (c) => cors(await hostFetch(c.req.raw)))
  .all('/relay/*', (c) => relayHandler.fetch(c.req.raw))
  .get('/', (c) =>
    c.html(
      `<h1>relay playground host</h1>
      <p>discovery: <a href="/.well-known/urpc/host.json">/.well-known/urpc/host.json</a></p>
      <p>relay endpoint: <code>/relay/messages</code></p>`,
    ),
  )

serve({ fetch: app.fetch, port }, (info) => {
  host.on('request', async (event) => {
    if (event.method === 'ping')
      await event.respond({ message: 'pong from host', transport: event.transport })
    else await event.reject({ code: -32601, message: 'method not found' })
  })
  console.log(`[host] listening on http://localhost:${info.port}`)
  console.log(`[host] host.json: http://localhost:${info.port}/.well-known/urpc/host.json`)
  console.log(`[host] relay: http://localhost:${info.port}/relay/messages`)
})

function cors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value)
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}
