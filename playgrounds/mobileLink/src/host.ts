/**
 * Mobile-link playground host.
 *
 * Runs a Hono server that publishes `host.json` and handles the
 * mobile-link universal-link route.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Base64, Bytes, Ed25519 } from 'ox'
import { Wata, mobileLink } from 'wata/host'

const port = Number(process.env.PORT ?? 4748)
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`
const privateKey =
  process.env.PRIVATE_KEY ?? '0x2222222222222222222222222222222222222222222222222222222222222222'
const publicKey = Base64.fromBytes(Bytes.from(Ed25519.getPublicKey({ privateKey })), {
  pad: false,
  url: true,
})

console.log(`[host] identity_pubkey: ${publicKey}`)
console.log(`[host] set EXPO_PUBLIC_HOST_PUBLIC_KEY=${publicKey} if PRIVATE_KEY changes`)

const wata = Wata.create({
  baseUrl,
  meta: {
    description: 'Mobile-link playground host',
    name: 'Example Wallet',
    websiteUrl: baseUrl,
  },
  privateKey,
  transports: [
    mobileLink({
      path: '/auth/mobile-link',
      responseTimeout: 15_000,
      scheme: 'examplewallet',
      universalLink: `${baseUrl}/auth/mobile-link`,
    }),
  ],
})

wata.on('request', (event) => {
  console.log(`[host] request: ${event.method}`, event.params)
  if (event.method === 'ping') return { at: new Date().toISOString(), ok: true }
  return undefined
})

const app = new Hono()
  .all('/.well-known/*', (c) => wata.fetch(c.req.raw))
  .all('/auth/mobile-link', (c) => wata.fetch(c.req.raw))
  .get('/', (c) =>
    c.text(
      [
        'mobile-link host',
        `host.json: ${baseUrl}/.well-known/urpc/host.json`,
        `mobile-link: ${baseUrl}/auth/mobile-link`,
      ].join('\n'),
    ),
  )

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[host] listening on http://localhost:${info.port}`)
  console.log(`[host] mobile-link URL: ${baseUrl}/auth/mobile-link`)
})
