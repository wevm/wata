/**
 * Optional mobile-link discovery server.
 *
 * The primary playground is two Expo apps. This Hono server is useful when
 * you want to inspect the published host document or test universal-link
 * routing against an HTTP endpoint.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Base64, Bytes, Ed25519 } from 'ox'

import * as HostMobileLink from '../../../src/host/transports/mobileLink.js'
import * as HostWata from '../../../src/host/Wata.js'
import { defaultHostPrivateKey, hostPath, hostScheme } from './constants'
import { schema } from './schema'

const port = Number(process.env.PORT ?? 4748)
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`
const privateKey = process.env.PRIVATE_KEY ?? defaultHostPrivateKey
const publicKey = Base64.fromBytes(Bytes.from(Ed25519.getPublicKey({ privateKey })), {
  pad: false,
  url: true,
})

console.log(`[server] identity_pubkey: ${publicKey}`)
console.log(`[server] set EXPO_PUBLIC_HOST_PUBLIC_KEY=${publicKey} if PRIVATE_KEY changes`)

const wata = HostWata.create({
  baseUrl,
  meta: {
    description: 'Mobile-link playground bank',
    name: 'Ironbank',
    websiteUrl: baseUrl,
  },
  privateKey,
  schema,
  transports: [
    HostMobileLink.mobileLink({
      path: hostPath,
      responseTimeout: 15_000,
      scheme: hostScheme,
      universalLink: `${baseUrl}${hostPath}`,
    }),
  ],
})

wata.on('request', (event) => {
  console.log(`[server] request: ${event.method}`, event.params)
  if (event.method === 'authorizeAccountAccess')
    return {
      accountName: 'Ironbank Everyday',
      approved: true,
      at: new Date().toISOString(),
      message: `${event.params[0].appName} can now view your Ironbank account.`,
      permissions: event.params[0].permissions,
    }
  return undefined
})

const app = new Hono()
  .all('/.well-known/*', (c) => wata.fetch(c.req.raw))
  .all(hostPath, (c) => wata.fetch(c.req.raw))
  .get('/', (c) =>
    c.text(
      [
        'mobile-link discovery server',
        `host.json: ${baseUrl}/.well-known/urpc/host.json`,
        `mobile-link: ${baseUrl}${hostPath}`,
      ].join('\n'),
    ),
  )

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`)
  console.log(`[server] mobile-link URL: ${baseUrl}${hostPath}`)
})
