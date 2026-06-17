import { Hono } from 'hono'
import { Session } from 'wata/host'

import { consumer as consumer_wata } from './consumer.js'
import { host as host_wata } from './host.js'

type ServerState =
  | { status: 'idle' }
  | { status: 'pending'; verificationUri?: string | undefined }
  | { error: string; status: 'error' }
  | { result: unknown; status: 'done' }

let serverState: ServerState = { status: 'idle' }

const app = new Hono()

const consumer = await consumer_wata.webhookCallback.start()
const host = await Session.compose([
  host_wata.deviceCode.start(),
  host_wata.webhookCallback.start(),
])

consumer.onEnvelope((envelope, meta) => {
  if (envelope.type !== 'rpc-responses') return
  if (meta.transport !== 'webhookCallback') return
  const response = envelope.payload[0]
  if (!response) return
  if ('error' in response) serverState = { error: response.error.message, status: 'error' }
  else serverState = { result: response.result, status: 'done' }
})

host.onRequest(async (event) => {
  await event.respond({ message: 'pong from host', transport: event.transport })
})

app.all('/.well-known/*', async (c) => {
  const response = await host_wata.fetch(c.req.raw)
  if (response.status !== 404) return response
  return await consumer_wata.fetch(c.req.raw)
})

app.all('/auth/*', (c) => host_wata.fetch(c.req.raw))
app.all('/consumer/callback', (c) => consumer_wata.fetch(c.req.raw))

app.post('/demo/server', async (c) => {
  if (serverState.status !== 'idle') return c.json(serverState)

  serverState = { status: 'pending' }

  try {
    const registration = await consumer.send({
      method: 'ping',
      params: [{ message: 'hello from server consumer' }],
    })
    serverState = { status: 'pending', verificationUri: registration.verificationUri }
    return c.json(serverState)
  } catch (error) {
    serverState = { error: (error as Error).message, status: 'error' }
    return c.json(serverState, 500)
  }
})

app.get('/demo/server/result', (c) => c.json(serverState))

export default app
