/**
 * Web host (wallet) config — shared by the worker and the browser host page.
 *
 * `Wata.create` is pure config; a transport only goes live when its
 * `.start()` is called. The worker starts the HTTP transports
 * (`deviceCode` for `consumer-cli`, `mobileWebAuth` for `consumer-mobile`)
 * and serves discovery + approval routes; the browser `host.html` starts the
 * `postMessage` transport for `consumer-web`.
 */

import { Store, Wata, deviceCode, mobileWebAuth, postMessage } from 'wata/host'
import * as Identity from 'wata/identity'

import { baseUrl, identityPrivateKey } from './config.js'

// The postMessage consumer conveys its origin out of band on the host URL
// (spec §3.1) so the host can pin `targetOrigin`. Only present in the browser.
const targetOrigin =
  typeof location === 'undefined'
    ? undefined
    : (new URL(location.href).searchParams.get('origin') ?? undefined)

export const host = Wata.create({
  baseUrl,
  identity: Identity.fromPrivateKey(identityPrivateKey),
  meta: {
    description: 'Wata example web wallet',
    name: 'Wata Web Wallet',
    websiteUrl: baseUrl,
  },
  transports: [
    deviceCode({
      html: {
        async authenticate({ actions, request }) {
          const form = await request.formData()
          const userCode = String(form.get('user_code') ?? '')
          const decision = String(form.get('decision') ?? '')
          if (decision === 'approve') {
            await actions.approve(userCode)
            return page('<p>Approved — return to your terminal.</p>')
          }
          await actions.deny(userCode)
          return page('<p>Denied.</p>')
        },
        render({ record, userCode }) {
          if (!userCode || !record)
            return page(`
              <h1>Enter your device code</h1>
              <form method="get" action="/auth/device/verify">
                <input name="user_code" placeholder="ABCD-EFGH" autofocus required />
                <button type="submit">Continue</button>
              </form>
            `)
          return page(`
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
      pollingInterval: 1_000,
      store: Store.memory(),
    }),
    mobileWebAuth({
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
    // `url` is published in `host.json` as the `window` binding so a
    // directory consumer learns this origin speaks `postMessage` and which
    // page to open as the embedded host (the popup at `/host.html`).
    postMessage({ url: '/host.html', ...(targetOrigin ? { targetOrigin } : {}) }),
  ],
})

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8" /><title>Wata Web Wallet</title>${body}`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      status,
    },
  )
}
