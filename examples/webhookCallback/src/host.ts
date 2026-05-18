/**
 * Minimal host-side example for the `webhookCallback` transport.
 *
 * Runs a tiny Hono server that publishes `host.json`, accepts webhook
 * registrations at `/auth/webhook/register`, and serves a small HTML
 * approval page at `/auth/webhook/verify`.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Kv, Wata, webhookCallback } from 'wata/host'

const port = 4747
const baseUrl = `http://localhost:${port}`
const privateKey = '0x2222222222222222222222222222222222222222222222222222222222222222'

const wata = Wata.create({
  baseUrl,
  meta: { name: 'Example Wallet' },
  privateKey,
  transport: webhookCallback({
    html: {
      async authenticate({ request, actions }) {
        const form = await request.formData()
        const code = String(form.get('code') ?? '')
        const decision = String(form.get('decision') ?? '')
        if (decision === 'approve') {
          await actions.approve(code)
          return html('<p>Approved</p>')
        }
        await actions.deny(code)
        return html('<p>Denied</p>')
      },
      render({ approvalToken, record, code }) {
        if (!record) return html('<h1>No pending request</h1>')
        return html(`
          <h1>Approve request?</h1>
          <p>Consumer: <code>${escape(record.consumer.origin)}</code></p>
          <form method="post" action="/auth/webhook/verify">
            <input type="hidden" name="approval_token" value="${escape(approvalToken ?? '')}" />
            <input type="hidden" name="code" value="${escape(code ?? '')}" />
            <button type="submit" name="decision" value="approve">Approve</button>
            <button type="submit" name="decision" value="deny">Deny</button>
          </form>
        `)
      },
    },
    path: '/auth/webhook',
    store: Kv.memory(),
  }),
})

wata.on('request', (event) => {
  console.log(`request: ${event.method}`, event.params)
  event.respond({ message: 'pong from host' })
})

const app = new Hono()
  .all('/.well-known/*', (c) => wata.fetch(c.req.raw))
  .all('/auth/*', (c) => wata.fetch(c.req.raw))

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`listening on http://localhost:${info.port}`)
})

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8">${body}`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    status,
  })
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
