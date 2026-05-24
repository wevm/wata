/**
 * Webhook-callback playground consumer.
 *
 * Runs a `@clack/prompts`-driven CLI that drives the uRPC
 * `webhook-callback` transport against the host playground. The
 * consumer also boots a small Hono server on a separate port so the
 * host can deliver the signed webhook back to `/cb`. Discovery is
 * auto-published off the same `wata.fetch`: `Wata.create({ baseUrl,
 * meta, privateKey })` derives `identity_pubkey` and lifts the
 * transport's `callbackUrls`
 * into `/.well-known/urpc/consumer.json` automatically.
 *
 * Identity: set `PRIVATE_KEY=0x...` to use a stable Ed25519
 * private seed; otherwise a fresh one is generated on each run and
 * logged so you can copy/paste it back in.
 *
 * Run after starting `host.ts`:
 * ```sh
 * pnpm --filter webhook-callback-playground dev:consumer
 * ```
 */

import * as Clack from '@clack/prompts'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Ed25519 } from 'ox'
import { Kv, Wata, webhookCallback } from 'wata'

const port = Number(process.env.PORT ?? 4646)
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`
const hostUrl = process.env.HOST_URL ?? 'http://localhost:4747'
const webhookPath = '/cb'

// Long-term identity. Read from `PRIVATE_KEY` if present;
// otherwise generate a fresh one and log it so the user can pin it
// across runs (real consumers persist this in a secret store).
const privateKey = process.env.PRIVATE_KEY ?? Ed25519.createKeyPair().privateKey

Clack.intro('uRPC webhook-callback consumer')
if (!process.env.PRIVATE_KEY)
  Clack.log.info(
    `PRIVATE_KEY not set — generated ephemeral key:\n  ${privateKey}\n  (export to reuse across runs)`,
  )
Clack.log.info(`webhook listener: ${baseUrl}${webhookPath}`)

const wata = Wata.create({
  baseUrl,
  meta: {
    description: 'uRPC webhook-callback playground consumer',
    icon: 'https://api.dicebear.com/9.x/identicon/svg?seed=acme-cli',
    name: 'Acme CLI',
  },
  privateKey,
  transports: [
    webhookCallback({
      host: hostUrl,
      path: webhookPath,
      store: Kv.memory(),
    }),
  ],
})

// Boot the listener. `wata.fetch` serves both
// `/.well-known/urpc/consumer.json` (auto-built from `meta` +
// `privateKey` + `transport.callbackUrls`) and the
// transport's `/cb` webhook handler.
const app = new Hono()
  .all('/.well-known/*', (c) => wata.fetch(c.req.raw))
  .all('/cb', (c) => wata.fetch(c.req.raw))
  .get('/', (c) => c.text('webhook-callback consumer'))

await new Promise<void>((resolve) =>
  serve({ fetch: app.fetch, port }, () => {
    Clack.log.info(`listener ready on ${baseUrl}`)
    resolve()
  }),
)

const method = await Clack.select({
  message: 'Pick a method to call',
  options: [
    { label: 'ping (no params)', value: 'ping' },
    { label: 'echo (params: { hello: "world" })', value: 'echo' },
  ],
})
if (Clack.isCancel(method)) {
  Clack.cancel('cancelled')
  process.exit(0)
}

const params = method === 'echo' ? [{ hello: 'world' }] : []

const spinner = Clack.spinner()

try {
  const result = new Promise<unknown>((resolve, reject) => {
    wata.on('rpc-responses', (responses) => {
      const response = responses[0]
      if (!response) return
      if ('error' in response) reject(new Error(response.error.message))
      else resolve(response.result)
    })
  })
  spinner.start('registering...')
  const registration = await wata.send({
    method: method as string,
    params: params as never,
  })
  spinner.stop('registered')
  Clack.note(registration.verificationUri, 'Open this URL in your browser to approve')
  spinner.start('waiting for callback...')
  const response = await result
  spinner.stop('approved')
  Clack.outro(`response: ${JSON.stringify(response)}`)
} catch (cause) {
  spinner.stop('failed')
  Clack.outro(`error: ${(cause as Error).name}: ${(cause as Error).message}`)
  process.exit(1)
}

process.exit(0)
