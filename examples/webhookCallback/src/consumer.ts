/**
 * Minimal consumer-side example for the `webhookCallback` transport.
 *
 * Starts a small local webhook listener, sends one `ping` request to the
 * host, prints the verification URL, then waits for the signed callback.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Kv, Wata, webhookCallback } from 'wata'

const port = 4646
const baseUrl = `http://localhost:${port}`
const hostUrl = 'http://localhost:4747'
const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111'

const wata = Wata.create({
  baseUrl,
  meta: { name: 'Example Consumer' },
  privateKey,
  transport: webhookCallback({
    host: hostUrl,
    onPrompt({ verificationUri }) {
      console.log(`open ${verificationUri}`)
    },
    path: '/cb',
    store: Kv.memory(),
  }),
})

const app = new Hono()
  .all('/.well-known/*', (c) => wata.fetch(c.req.raw))
  .all('/cb', (c) => wata.fetch(c.req.raw))

await new Promise<void>((resolve) =>
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`listening on http://localhost:${info.port}`)
    resolve()
  }),
)

const { result } = await wata.send({
  method: 'ping',
  params: [{ message: 'hello from consumer' }],
})

console.log('result:', result)
process.exit(0)
