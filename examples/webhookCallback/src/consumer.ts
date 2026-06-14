import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Identity, Store, Wata, webhookCallback } from 'wata'

const port = 4646
const baseUrl = `http://localhost:${port}`
const hostUrl = 'http://localhost:4747'
const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111'
const identity = Identity.fromPrivateKey(privateKey)

const wata = Wata.create({
  baseUrl,
  identity,
  meta: { name: 'Example Consumer' },
  transports: [
    webhookCallback({
      host: hostUrl,
      path: '/callback',
      store: Store.memory(),
    }),
  ],
})

wata.onEnvelope((envelope) => {
  if (envelope.type !== 'rpc-responses') return
  const response = envelope.payload[0]
  if (!response) return
  if ('error' in response) console.error(response.error)
  else console.log(response.result)
})

const app = new Hono()
  .get('/', (c) =>
    c.html(`<!doctype html>
      <h1>Consumer</h1>
      <form method="post" action="/send">
        <input name="message" value="hello from consumer" />
        <button>Send to host</button>
      </form>
    `),
  )
  .post('/send', async (c) => {
    const form = await c.req.formData()
    const message = String(form.get('message') ?? '')
    const registration = await wata.send({
      method: 'message.send',
      params: [{ text: message }],
    })
    return c.html(`<!doctype html>
      <h1>Consumer</h1>
      <p>Approve: <a href="${registration.verificationUri}">${registration.verificationUri}</a></p>
    `)
  })
  .all('/.well-known/*', (c) => wata.fetch(c.req.raw))
  .all('/callback', (c) => wata.fetch(c.req.raw))

serve({ fetch: app.fetch, port }, () => {
  console.log(`consumer: ${baseUrl}`)
})
