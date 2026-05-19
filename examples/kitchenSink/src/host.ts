import { Kv, Wata, deviceCode, postMessage, webhookCallback } from 'wata/host'

export const baseUrl = 'http://localhost:5173'

export const host = Wata.create({
  baseUrl,
  meta: { name: 'Kitchen Sink Host' },
  privateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
  transports: [
    deviceCode({
      html: {
        async authenticate({ actions, request }) {
          const form = await request.formData()
          const decision = String(form.get('decision') ?? '')
          const userCode = String(form.get('user_code') ?? '')
          if (decision === 'approve') {
            await actions.approve(userCode)
            return new Response('<!doctype html><meta charset="utf-8"><p>Approved</p>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          }
          await actions.deny(userCode)
          return new Response('<!doctype html><meta charset="utf-8"><p>Denied</p>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        },
        render({ record, userCode }) {
          if (!record)
            return new Response(
              `<!doctype html><meta charset="utf-8">
              <h1>Enter device code</h1>
              <form method="get" action="/auth/device/verify">
                <input name="user_code" value="${userCode ?? ''}" autofocus required />
                <button type="submit">Continue</button>
              </form>`,
              { headers: { 'content-type': 'text/html; charset=utf-8' } },
            )
          return new Response(
            `<!doctype html><meta charset="utf-8">
            <h1>Approve device-code request?</h1>
            <p><code>${userCode}</code></p>
            <form method="post" action="/auth/device/verify">
              <input type="hidden" name="user_code" value="${userCode}" />
              <button type="submit" name="decision" value="approve">Approve</button>
              <button type="submit" name="decision" value="deny">Deny</button>
            </form>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          )
        },
      },
      path: '/auth/device',
      pollingInterval: 1_000,
      store: Kv.memory(),
    }),
    postMessage(),
    webhookCallback({
      html: {
        async authenticate({ actions, code, request }) {
          const form = await request.formData()
          const decision = String(form.get('decision') ?? '')
          const code_form = String(form.get('code') ?? code ?? '')
          if (decision === 'approve') {
            await actions.approve(code_form)
            return new Response('<!doctype html><meta charset="utf-8"><p>Approved</p>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          }
          await actions.deny(code_form)
          return new Response('<!doctype html><meta charset="utf-8"><p>Denied</p>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        },
        render({ approvalToken, code, record }) {
          if (!record)
            return new Response('<!doctype html><meta charset="utf-8"><p>No pending request</p>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          return new Response(
            `<!doctype html><meta charset="utf-8">
            <h1>Approve webhook request?</h1>
            <form method="post" action="/auth/webhook/verify">
              <input type="hidden" name="approval_token" value="${approvalToken ?? ''}" />
              <input type="hidden" name="code" value="${code ?? ''}" />
              <button type="submit" name="decision" value="approve">Approve</button>
              <button type="submit" name="decision" value="deny">Deny</button>
            </form>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          )
        },
      },
      path: '/auth/webhook',
      store: Kv.memory(),
      validateOutboundRequest() {},
    }),
  ],
})

host.on('request', async (event) => {
  await event.respond({ message: 'pong from host', transport: event.transport })
  if (typeof window !== 'undefined') window.close()
})
