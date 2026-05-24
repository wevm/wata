import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Kv, Wata, webhookCallback } from 'wata/host'

const port = 4747
const baseUrl = `http://localhost:${port}`
const privateKey = '0x2222222222222222222222222222222222222222222222222222222222222222'

const wata = Wata.create({
  baseUrl,
  meta: { name: 'Example Host' },
  privateKey,
  transports: [
    webhookCallback({
      html: {
        async authenticate({ actions, request }) {
          const form = await request.formData()
          const code = String(form.get('code') ?? '')
          if (form.get('decision') === 'approve') {
            await actions.approve(code)
            return html('<p>Approved. Return to the consumer.</p>')
          }
          await actions.deny(code)
          return html('<p>Denied. Return to the consumer.</p>')
        },
        render({ approvalToken, code, record }) {
          if (!record) return html('<p>No pending request.</p>', 404)
          return html(`
            <h1>Host</h1>
            <p>Consumer: ${escapeHtml(record.consumer.origin)}</p>
            <pre>${escapeHtml(JSON.stringify(record.message.payload, null, 2))}</pre>
            <form method="post" action="/auth/webhook/verify">
              <input type="hidden" name="approval_token" value="${escapeHtml(approvalToken ?? '')}" />
              <input type="hidden" name="code" value="${escapeHtml(code ?? '')}" />
              <button name="decision" value="approve">Approve</button>
              <button name="decision" value="deny">Deny</button>
            </form>
          `)
        },
      },
      path: '/auth/webhook',
      store: Kv.memory(),
    }),
  ],
})

wata.on('request', async (event) => {
  if (event.method !== 'message.send') {
    await event.reject({ code: -32601, data: event.method, message: 'method not found' })
    return
  }
  await event.respond({ echo: messageFrom(event.params) })
})

const app = new Hono()
  .get('/', (c) => c.html('<h1>Host</h1>'))
  .all('/.well-known/*', (c) => wata.fetch(c.req.raw))
  .all('/auth/*', (c) => wata.fetch(c.req.raw))

serve({ fetch: app.fetch, port }, () => {
  console.log(`host: ${baseUrl}`)
})

function messageFrom(params: unknown): string {
  const first = Array.isArray(params) ? params[0] : undefined
  if (first && typeof first === 'object') {
    const text = (first as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return JSON.stringify(params)
}

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html>${body}`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    status,
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
