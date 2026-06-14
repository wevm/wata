/**
 * Webhook-callback playground host.
 *
 * Runs a tiny Hono server on Node that mounts the uRPC
 * `webhook-callback` transport at `/auth/webhook`, plus an HTML
 * approval page wired into `html.render` / `html.authenticate`.
 *
 * Identity: an Ed25519 keypair is generated on startup. The matching
 * public key is published in `/.well-known/urpc/host.json` so the
 * consumer can pin it during discovery.
 *
 * Run:
 * ```sh
 * pnpm --filter webhook-callback-playground dev:host
 * ```
 *
 * Then in another terminal:
 * ```sh
 * pnpm --filter webhook-callback-playground dev:consumer
 * ```
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Base64, Bytes, Ed25519 } from 'ox'
import { Store, Wata, webhookCallback } from 'wata/host'
import * as Identity from 'wata/identity'

const port = Number(process.env.PORT ?? 4747)
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`

// Long-term identity. Read from `PRIVATE_KEY` if present;
// otherwise generate a fresh one and log it so the wallet operator
// can pin it across runs. A real host persists this in a secret
// store — rotation invalidates every consumer that has pinned the
// previous `identity_pubkey`.
const privateKey = process.env.PRIVATE_KEY ?? Ed25519.createKeyPair().privateKey
const identity = Identity.fromPrivateKey(privateKey)
const publicKey = Base64.fromBytes(Bytes.from(Ed25519.getPublicKey({ privateKey })), {
  pad: false,
  url: true,
})

if (!process.env.PRIVATE_KEY)
  console.log(
    `[host] PRIVATE_KEY not set — generated ephemeral key:\n  ${privateKey}\n  (export to reuse across runs)`,
  )
console.log(`[host] identity_pubkey (base64url): ${publicKey}`)

const wata = Wata.create({
  baseUrl,
  identity,
  meta: {
    description: 'Webhook-callback playground host',
    name: 'Example Wallet',
    websiteUrl: baseUrl,
  },
  transports: [
    webhookCallback({
      baseUrl,
      expiresIn: 300,
      html: {
        async authenticate({ request, actions }) {
          const form = await request.formData()
          const code = String(form.get('code') ?? '')
          const decision = String(form.get('decision') ?? '')
          if (decision === 'approve') {
            await actions.approve(code)
            return html('<p>Approved. You may close this tab.</p>')
          }
          await actions.deny(code)
          return html('<p>Denied. You may close this tab.</p>')
        },
        render({ approvalToken, record, code }) {
          if (!record)
            return html(
              `<h1>No pending request</h1><p>Open this URL from the consumer's approval link.</p>`,
            )

          const requestItems =
            record.message.type === 'rpc-requests'
              ? record.message.payload
                  .map((m) => {
                    const id = 'id' in m ? `#${String(m.id)}` : '(notification)'
                    return `<li><code>${m.method}</code> ${id} ${escape(JSON.stringify(m.params))}</li>`
                  })
                  .join('')
              : '<li>(unknown payload)</li>'
          const consumer = record.consumer
          const consumerMeta = consumer.meta
          const display = consumerMeta
            ? `<p>
              App: <strong>${escape(consumerMeta.name)}</strong>${consumerMeta.description ? ` -- ${escape(consumerMeta.description)}` : ''}
            </p>`
            : `<p>App: <strong>${escape(consumer.id)}</strong></p>`
          return html(`
        <h1>Approve request?</h1>
        ${display}
        <p>Origin: <code>${escape(consumer.origin)}</code></p>
        <p>Pending JSON-RPC requests:</p>
        <ul>${requestItems}</ul>
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
      store: Store.memory(),
    }),
  ],
})

wata.onRequest((event) => {
  console.log(`[host] request: ${event.method}`, event.params)
  if (event.method === 'ping') event.respond({ at: new Date().toISOString(), ok: true })
  else if (event.method === 'echo') event.respond(event.params)
  else event.reject({ code: -32601, message: 'method not found' })
})

const app = new Hono()
  .all('/.well-known/*', (c) => wata.fetch(c.req.raw))
  .all('/auth/*', (c) => wata.fetch(c.req.raw))
  .get('/', (c) =>
    c.html(
      `<h1>webhook-callback host</h1>
      <p>discovery: <a href="/.well-known/urpc/host.json">/.well-known/urpc/host.json</a></p>
      <p>verify routes mount under <code>/auth/webhook</code></p>`,
    ),
  )

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[host] listening on http://localhost:${info.port}`)
  console.log(`[host] host.json: http://localhost:${info.port}/.well-known/urpc/host.json`)
})

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>webhook-callback</title>${body}`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      status,
    },
  )
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
