import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Ed25519 } from 'ox'
import { Wata, mobileWebAuth } from 'wata/host'

const port = Number(process.env.PORT ?? 4780)
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')
const callbackUrl = process.env.CALLBACK_URL ?? 'mobilewebauth://callback'
const consumerId = (process.env.CONSUMER_ID ?? 'http://localhost:19006').replace(/\/+$/, '')
const privateKey = process.env.PRIVATE_KEY ?? Ed25519.createKeyPair().privateKey

const wata = Wata.create({
  baseUrl,
  meta: {
    description: 'mobileWebAuth playground host',
    name: 'Example Wallet',
    websiteUrl: baseUrl,
  },
  privateKey,
  transports: [
    mobileWebAuth({
      fetch: async (input): Promise<Response> => {
        const url = new URL(String(input))
        if (url.href === `${consumerId}/.well-known/urpc/consumer.json`)
          return Response.json({
            callback_urls: [callbackUrl],
            id: new URL(consumerId).hostname,
            name: 'Expo Consumer',
            origin: consumerId,
            version: '1.0',
          })
        return await fetch(input)
      },
      html: {
        async authenticate({ actions, request }) {
          const form = await request.formData()
          const state = String(form.get('state') ?? '')
          const decision = String(form.get('decision') ?? '')
          if (!state) return html('<p>missing state</p>', 400)
          if (decision !== 'approve') return html('<p>denied</p>', 403)
          return Response.redirect(await actions.approve(state), 302)
        },
        render({ record }) {
          if (!record) return html('<p>no pending request</p>', 404)
          const requests =
            record.message?.type === 'rpc-requests'
              ? record.message.payload
                  .map((message) => `<li><code>${escape(message.method)}</code></li>`)
                  .join('')
              : '<li>empty request</li>'
          return html(`
            <h1>Approve mobile web auth?</h1>
            <ul>${requests}</ul>
            <form method="post" action="/auth/mobile">
              <input type="hidden" name="state" value="${escape(record.state)}" />
              <button type="submit" name="decision" value="approve">Approve</button>
              <button type="submit" name="decision" value="deny">Deny</button>
            </form>
          `)
        },
      },
      path: '/auth/mobile',
    }),
  ],
})

wata.on('request', async (event) => {
  if (event.method === 'ping') {
    await event.respond({
      at: new Date().toISOString(),
      ok: true,
      transport: event.transport,
    })
    return
  }
  await event.reject({ code: -32601, message: 'method not found' })
})

const app = new Hono()
  .all('/auth/mobile', (c) => wata.fetch(c.req.raw))
  .get('/.well-known/urpc/host.json', (c) => wata.fetch(c.req.raw))
  .get('/', (c) =>
    c.html(
      '<h1>mobileWebAuth host</h1><p>Open the Expo app, send a ping, then approve at <code>/auth/mobile</code>.</p>',
    ),
  )

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[host] listening on http://localhost:${info.port}`)
  console.log(`[host] discovery: ${baseUrl}/.well-known/urpc/host.json`)
  console.log(`[host] callback allowlist: ${callbackUrl}`)
})

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>mobileWebAuth</title>${body}`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    status,
  })
}
