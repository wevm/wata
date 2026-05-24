import { Hono } from 'hono'

import { consumer } from './consumer.js'
import { host } from './host.js'

type ServerState =
  | { status: 'idle' }
  | { status: 'pending'; verificationUri?: string | undefined }
  | { error: string; status: 'error' }
  | { result: unknown; status: 'done' }

let serverState: ServerState = { status: 'idle' }

const app = new Hono()

consumer.on('rpc-responses', (responses, meta) => {
  if (meta.transport !== 'webhookCallback') return
  const response = responses[0]
  if (!response) return
  if ('error' in response) serverState = { error: response.error.message, status: 'error' }
  else serverState = { result: response.result, status: 'done' }
})

app.all('/.well-known/*', async (c) => {
  const response = await host.fetch(c.req.raw)
  if (response.status !== 404) return response
  return await consumer.fetch(c.req.raw)
})

app.all('/auth/*', (c) => host.fetch(c.req.raw))
app.all('/consumer/callback', (c) => consumer.fetch(c.req.raw))

app.post('/demo/server', async (c) => {
  if (serverState.status !== 'idle') return c.json(serverState)

  serverState = { status: 'pending' }

  try {
    const registration = await consumer.webhookCallback.send({
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
