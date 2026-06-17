/**
 * Minimal host-side example for the `deviceCode` transport.
 *
 * Runs a tiny Hono server that mounts the `deviceCode` transport at
 * `/auth/device` along with an HTML approval page. Responds to inbound
 * `ping` requests with `{ message }`.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Store, Wata, deviceCode } from 'wata/host'

const port = 4747
const baseUrl = `http://localhost:${port}`

const wata = Wata.create({
  baseUrl,
  transports: [
    deviceCode({
      html: {
        async authenticate({ request, actions }) {
          const form = await request.formData()
          const userCode = String(form.get('user_code') ?? '')
          const decision = String(form.get('decision') ?? '')
          if (decision === 'approve') {
            await actions.approve(userCode)
            return html('<p>Approved</p>')
          }
          await actions.deny(userCode)
          return html('<p>Denied</p>')
        },
        render({ userCode, record }) {
          if (!userCode || !record)
            return html(`
            <h1>Enter your device code</h1>
            <form method="get" action="/auth/device/verify">
              <input name="user_code" placeholder="ABCD-EFGH" autofocus required />
              <button type="submit">Continue</button>
            </form>
          `)

          return html(`
          <h1>Approve request?</h1>
          <p>Code: <code>${escape(userCode)}</code></p>
          <form method="post" action="/auth/device/verify">
            <input type="hidden" name="user_code" value="${escape(userCode)}" />
            <button type="submit" name="decision" value="approve">Approve</button>
            <button type="submit" name="decision" value="deny">Deny</button>
          </form>
        `)
        },
      },
      path: '/auth/device',
      pollingInterval: 1000,
      store: Store.memory(),
    }),
  ],
})

const session = await wata.start()

session.onRequest(async (event) => {
  console.log(`request: ${event.method}`, event.params)
  await event.respond({ message: 'pong from host' })
})

const app = new Hono().all('/auth/*', (c) => wata.fetch(c.req.raw))

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
