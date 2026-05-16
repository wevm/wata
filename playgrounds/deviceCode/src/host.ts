/**
 * Device-code playground host.
 *
 * Runs a tiny Hono server on Node that mounts the uRPC `device-code`
 * transport at `/auth/device`, plus an HTML approval page wired into
 * `html.render` / `html.authenticate`.
 *
 * Run:
 * ```sh
 * pnpm --filter device-code-playground dev:host
 * ```
 *
 * Then in another terminal:
 * ```sh
 * pnpm --filter device-code-playground dev:consumer
 * ```
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Wata, Kv, deviceCode } from 'wata/host'

const port = Number(process.env['PORT'] ?? 4747)
const baseUrl = process.env['BASE_URL'] ?? `http://localhost:${port}`

const wata = Wata.create({
  baseUrl,
  meta: {
    name: 'Example Wallet',
    description: 'Device-code playground host',
    url: baseUrl,
  },
  transport: deviceCode({
    store: Kv.memory(),
    baseUrl,
    path: '/auth/device',
    pollingInterval: 1000,
    html: {
      render({ userCode, record, meta }) {
        if (!userCode || !record)
          return html(`
          <h1>Enter your device code</h1>
          <form method="get" action="/auth/device/verify">
            <input name="user_code" placeholder="ABCD-EFGH" autofocus required />
            <button type="submit">Continue</button>
          </form>
        `)

        const requests =
          record.message.type === 'rpc-requests'
            ? record.message.payload
                .map((m) => {
                  const id = 'id' in m ? `#${String(m.id)}` : '(notification)'
                  return `<li><code>${m.method}</code> ${id} ${escape(JSON.stringify(m.params))}</li>`
                })
                .join('')
            : '<li>(unknown payload)</li>'
        const consumer = meta
          ? `<p>
              ${meta.icon ? `<img src="${escape(meta.icon)}" alt="${escape(meta.name)} icon" width="32" height="32" /> ` : ''}
              App: <strong>${escape(meta.name)}</strong>${meta.description ? ` — ${escape(meta.description)}` : ''}
            </p>`
          : ''
        return html(`
        <h1>Approve request?</h1>
        ${consumer}
        <p>Code: <code>${userCode}</code></p>
        <p>Pending JSON-RPC requests:</p>
        <ul>${requests}</ul>
        <form method="post" action="/auth/device/verify">
          <input type="hidden" name="user_code" value="${userCode}" />
          <button type="submit" name="decision" value="approve">Approve</button>
          <button type="submit" name="decision" value="deny">Deny</button>
        </form>
      `)
      },
      async authenticate({ request, actions }) {
        const form = await request.formData()
        const userCode = String(form.get('user_code') ?? '')
        const decision = String(form.get('decision') ?? '')
        if (!userCode) return html('<p>missing <code>user_code</code></p>', 400)
        const record = await actions.get(userCode)
        if (!record) return html('<p>unknown <code>user_code</code></p>', 404)
        if (decision === 'approve') {
          await actions.approve(userCode)
          return html('<h1>Approved ✅</h1><p>You may close this tab.</p>')
        }
        await actions.deny(userCode)
        return html('<h1>Denied ❌</h1><p>You may close this tab.</p>')
      },
    },
  }),
})

wata.on('request', (event) => {
  console.log(`[host] request: ${event.method}`, event.params)
  if (event.method === 'ping') event.respond({ ok: true, at: new Date().toISOString() })
  else if (event.method === 'echo') event.respond(event.params)
  else event.reject({ code: -32601, message: 'method not found' })
})

const app = new Hono()
  .all('/auth/*', (c) => wata.fetch(c.req.raw))
  .get('/', (c) =>
    c.html(
      `<h1>device-code host</h1><p>visit <a href="/auth/device/verify">/auth/device/verify</a> to approve a request.</p>`,
    ),
  )

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[host] listening on http://localhost:${info.port}`)
  console.log(`[host] html page: http://localhost:${info.port}/auth/device/verify`)
})

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>device-code</title>${body}`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
