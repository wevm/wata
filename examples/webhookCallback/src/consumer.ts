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
  transports: [
    webhookCallback({
      host: hostUrl,
      path: '/cb',
      store: Kv.memory(),
    }),
  ],
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

const result = new Promise<unknown>((resolve, reject) => {
  wata.on('rpc-responses', (responses) => {
    const response = responses[0]
    if (!response) return
    if ('error' in response) reject(new Error(response.error.message))
    else resolve(response.result)
  })
})

const registration = await wata.send({
  method: 'ping',
  params: [{ message: 'hello from consumer' }],
})

console.log(`open ${registration.verificationUri}`)
console.log('result:', await result)
process.exit(0)
