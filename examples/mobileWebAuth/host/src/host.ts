/**
 * Host wallet — the web side of the `mobile-web-auth` flow.
 *
 * `Wata.create({ baseUrl, identity, meta })` publishes the host's
 * discovery document at `/.well-known/urpc/host.json` and mounts the
 * `mobile-web-auth` authorization endpoint at `/auth/mobile`. The Vite
 * dev/preview server (see `vite.config.ts`) routes those paths into the
 * exported {@link handler}; every other path falls through to the static
 * landing page.
 *
 * The browser auth session opened by the mobile app lands on
 * `GET /auth/mobile`, which renders the approval page. Approving
 * `POST`s back, the host answers the queued JSON-RPC request, and the
 * transport redirects once to the app's encrypted callback URI.
 */

import { Ed25519 } from 'ox'
import { Wata, mobileWebAuth } from 'wata/host'
import * as Identity from 'wata/identity'

/** Origin the host is reachable at — must match what the mobile app dials. */
const baseUrl = (process.env.HOST_BASE_URL ?? 'http://localhost:5611').replace(/\/+$/, '')

/** Long-term Ed25519 identity published in `host.json`. */
const privateKey = process.env.HOST_PRIVATE_KEY ?? Ed25519.createKeyPair().privateKey

const wata = Wata.create({
  baseUrl,
  identity: Identity.fromPrivateKey(privateKey),
  meta: {
    description: 'mobile-web-auth example wallet',
    name: 'Example Wallet',
    websiteUrl: baseUrl,
  },
  transports: [
    mobileWebAuth({
      // No `fetch` override: the host fetches the consumer's published
      // `consumer.json` (served by the app's discovery server, see
      // `consumer/discovery.ts`) over the network to confirm the callback
      // URI is registered.
      html: {
        async authenticate({ actions, request }) {
          const form = await request.formData()
          const state = String(form.get('state') ?? '')
          const decision = String(form.get('decision') ?? '')
          if (!state) return page('<p>Missing authorization state.</p>', 400)
          if (decision !== 'approve') return await actions.deny(state)
          return await actions.approve(state)
        },
        render({ authorization }) {
          const { consumer, message, state } = authorization
          const methods =
            message.type === 'rpc-requests'
              ? message.payload.map((rpc) => `<li><code>${escape(rpc.method)}</code></li>`).join('')
              : '<li>empty request</li>'
          return page(`
            <h1>Connection request</h1>
            <p><strong>${escape(consumer.name ?? consumer.origin)}</strong> wants to connect.</p>
            <ul>${methods}</ul>
            <form method="post" action="/auth/mobile">
              <input type="hidden" name="state" value="${escape(state)}" />
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

const ready = wata.start().then((session) => {
  session.onRequest(async (event) => {
    if (event.method === 'eth_requestAccounts') {
      await event.respond(['0x0000000000000000000000000000000000000001'])
      return
    }
    await event.reject({ code: -32601, message: `method not found: ${event.method}` })
  })
  return session
})

/** Web-standard fetch handler for the discovery + authorization routes. */
export async function handler(request: Request): Promise<Response> {
  await ready
  return wata.fetch(request)
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8" /><title>Example Wallet</title>${body}`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      status,
    },
  )
}
