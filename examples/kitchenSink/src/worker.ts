import { Hono } from 'hono'
import type { WebhookCallback } from 'wata'

import { consumer, prompts } from './consumer.js'
import { host } from './host.js'

type ServerState =
  | { status: 'idle' }
  | { status: 'pending'; verificationUri?: string | undefined }
  | { error: string; status: 'error' }
  | { result: unknown; status: 'done' }

let serverState: ServerState = { status: 'idle' }

const app = new Hono()

app.all('/.well-known/*', async (c) => {
  const response = await host.fetch(c.req.raw)
  if (response.status !== 404) return response
  return await consumer.fetch(c.req.raw)
})

app.all('/auth/*', (c) => host.fetch(c.req.raw))
app.all('/consumer/callback', (c) => consumer.fetch(c.req.raw))

app.post('/demo/server', async (c) => {
  if (serverState.status !== 'idle') return c.json(serverState)

  prompts.resolveWebhook = undefined
  prompts.webhook = undefined
  serverState = { status: 'pending' }

  const promptDeferred = Promise.withResolvers<WebhookCallback.Prompt>()
  prompts.resolveWebhook = promptDeferred.resolve

  void consumer.webhookCallback
    .send({
      method: 'ping',
      params: [{ message: 'hello from server consumer' }],
    })
    .then(
      ({ result }) => {
        serverState = { result, status: 'done' }
      },
      (error: Error) => {
        serverState = { error: error.message, status: 'error' }
      },
    )

  const prompt = await Promise.race([
    promptDeferred.promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10_000)),
  ])

  prompts.resolveWebhook = undefined

  if (!prompt) {
    serverState = { error: 'webhook prompt was not created', status: 'error' }
    return c.json(serverState, 500)
  }

  serverState = { status: 'pending', verificationUri: prompt.verificationUri }
  return c.json(serverState)
})

app.get('/demo/server/result', (c) => c.json(serverState))

export default app
