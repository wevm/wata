# Wata

## Install

```bash
npm i wata
```

```bash
pnpm i wata
```

```bash
bun i wata
```

## Transports

| Transport         | Description                                                                                            | Peers             |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ----------------- |
| `postMessage`     | Same-device browser session over a `Window`, `WindowProxy`, or `MessagePort` (popup, iframe, channel). | Browser ⇄ Browser |
| `deviceCode`      | OAuth 2.0 Device Authorization Grant (RFC 8628) over HTTP, with PKCE and a bring-your-own approval UI. | CLI ⇄ Browser     |
| `mobileWebAuth`   | Same-device mobile app to web host flow using browser auth and encrypted app-link callbacks.           | Mobile ⇄ Browser  |
| `webhookCallback` | Signed HTTP registration + callback flow for consumers that can receive webhooks.                      | Server ⇄ Server   |
| `relay`           | Remote session over an untrusted HTTPS relay; the web consumer shows a QR/link, the mobile host scans it, exchanging end-to-end-encrypted bodies (SSE or long-poll). | Web ⇄ Mobile      |

## Usage

### `postMessage`

Same-device browser session over a `Window`, `WindowProxy`, or `MessagePort`. The consumer supplies a `target` (popup, iframe, or channel port); the host defaults to its opener.

[See example →](./examples/postMessage)

#### Consumer

Opens a popup at the host URL and sends a `wallet_connect` request once the handshake completes.

```ts
import { Wata, postMessage } from 'wata'

const wata = Wata.create({
  transports: [
    postMessage({
      host: 'https://wallet.example',
      target(c) {
        return window.open(c.host, '_blank', 'popup=1')
      },
    }),
  ],
})

const { result } = await wata.send({
  method: 'wallet_connect',
  params: [],
})
```

#### Host

Listens on its opener for incoming requests and responds to `wallet_connect` with a list of addresses.

```ts
import { Wata, postMessage } from 'wata/host'

const wata = Wata.create({
  transports: [postMessage()],
})

wata.on('request', async (c) => {
  if (c.method === 'wallet_connect')
    await c.respond(['0x0000000000000000000000000000000000000001'])
})
```

### `deviceCode`

Cross-device session over HTTP using the OAuth 2.0 Device Authorization Grant (RFC 8628) with PKCE. The consumer surfaces a short `user_code` to the user and polls until the host approves.

[See example →](./examples/deviceCode)

#### Consumer

Requests a device code from the host, prints the verification URL and `user_code` for the user, then polls until approval and dispatches a `wallet_connect` request.

```ts
import { Wata, deviceCode } from 'wata'

const wata = Wata.create({
  transports: [deviceCode({ url: 'https://wallet.example/auth/device' })],
})

wata.on('prompt', (prompt) => {
  console.log(`Visit ${prompt.verificationUri} and enter ${prompt.userCode}`)
})

const { result } = await wata.send({
  method: 'wallet_connect',
  params: [],
})
```

#### Host

Mounts the device-code endpoints under `/auth/device`, renders a minimal approval form, marks the request as approved on submit, and answers `wallet_connect` requests.

```ts
import { createServer } from 'node:http'
import { Store, Wata, deviceCode } from 'wata/host'
import * as Identity from 'wata/identity'
import { Server } from 'wata/server'

const wata = Wata.create({
  baseUrl: 'https://wallet.example',
  identity: Identity.fromPrivateKey(privateKey),
  meta: { name: 'Example Wallet' },
  transports: [
    deviceCode({
      html: {
        async authenticate({ actions, request }) {
          const body = await request.formData()
          await actions.approve(String(body.get('user_code')))
          return new Response('approved')
        },
        render({ userCode }) {
          return new Response(
            `<form method="post"><input name="user_code" value="${userCode ?? ''}" required /><button>Approve</button></form>`,
            { headers: { 'content-type': 'text/html' } },
          )
        },
      },
      path: '/auth/device',
      store: Store.memory(),
    }),
  ],
})

wata.on('request', async (c) => {
  if (c.method === 'wallet_connect')
    await c.respond(['0x0000000000000000000000000000000000000001'])
})

createServer(Server.node(wata).listener).listen(3000)
```

### `mobileWebAuth`

Same-device mobile flow where the consumer opens the host's HTTPS authorization URL in a system-browser auth session, then receives an app-link / private-scheme callback carrying the encrypted response.

[See example →](./examples/mobileWebAuth)

#### Consumer

Opens the host authorization URL with the platform's browser auth-session API. The auth session resolves with the callback URL, which the transport validates and decrypts.

```ts
import * as WebBrowser from 'expo-web-browser'
import { Wata } from 'wata/consumer'
import { mobileWebAuth } from 'wata/consumer/transports/mobileWebAuth'

const wata = Wata.create({
  baseUrl: 'https://app.example',
  meta: { name: 'Example App' },
  transports: [
    mobileWebAuth({
      callback: 'com.example.app://callback',
      host: 'https://wallet.example',
      openAuthSession: async ({ authorizationUrl, callback }) => {
        const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, callback)
        if (result.type === 'success') return result.url
        return undefined
      },
    }),
  ],
})

const { result } = await wata.send({
  method: 'wallet_connect',
  params: [],
})
```

#### Host

Publishes `host.json`, renders an approval form at `/auth/mobile`, and redirects back to the consumer callback after approval.

```ts
import { createServer } from 'node:http'
import { Wata, mobileWebAuth } from 'wata/host'
import * as Identity from 'wata/identity'
import { Server } from 'wata/server'

const wata = Wata.create({
  baseUrl: 'https://wallet.example',
  identity: Identity.fromPrivateKey(privateKey),
  meta: { name: 'Example Wallet' },
  transports: [
    mobileWebAuth({
      html: {
        async authenticate({ actions, request }) {
          const body = await request.formData()
          return await actions.approve(String(body.get('state')))
        },
        render({ authorization }) {
          return new Response(
            `<form method="post">
              <input type="hidden" name="state" value="${authorization.state}" />
              <button>Approve</button>
            </form>`,
            { headers: { 'content-type': 'text/html' } },
          )
        },
      },
      path: '/auth/mobile',
    }),
  ],
})

wata.on('request', async (event) => {
  if (event.method === 'wallet_connect')
    await event.respond(['0x0000000000000000000000000000000000000001'])
})

createServer(Server.node(wata).listener).listen(3000)
```

### `webhookCallback`

Server-to-server session where the consumer registers a signed intent with the host, sends the user to a verification URL, then receives the signed JSON-RPC response at its webhook endpoint.

[See example →](./examples/webhookCallback)

#### Consumer

Publishes `consumer.json`, serves a web page that starts the request, opens the host's verification URL for the user, then receives the callback response at its webhook endpoint.

```ts
import { Identity, Store, Wata, webhookCallback } from 'wata'

const wata = Wata.create({
  baseUrl: 'https://app.example',
  identity: Identity.fromPrivateKey(privateKey),
  meta: { name: 'Example App' },
  transports: [
    webhookCallback({
      host: 'https://wallet.example',
      path: '/callback',
      store: Store.memory(),
    }),
  ],
})

wata.on('rpc-responses', (responses, meta) => {
  console.log(responses)
  console.log(meta)
})

const registration = await wata.send({
  method: 'wallet_connect',
  params: [],
})

console.log(`Visit ${registration.verificationUri}`)
```

#### Host

Publishes `host.json`, accepts signed registrations, renders an approval form, and responds to approved requests.

```ts
import { Store, Wata, webhookCallback } from 'wata/host'
import * as Identity from 'wata/identity'

const wata = Wata.create({
  baseUrl: 'https://wallet.example',
  identity: Identity.fromPrivateKey(privateKey),
  meta: { name: 'Example Wallet' },
  transports: [
    webhookCallback({
      html: {
        async authenticate({ actions, request }) {
          const body = await request.formData()
          await actions.approve(String(body.get('code')))
          return new Response('approved')
        },
        render({ approvalToken, code, record }) {
          if (!record) return new Response('no pending request', { status: 404 })
          return new Response(
            `<form method="post">
              <input type="hidden" name="approval_token" value="${approvalToken ?? ''}" />
              <input type="hidden" name="code" value="${code ?? ''}" />
              <button>Approve</button>
            </form>`,
            { headers: { 'content-type': 'text/html' } },
          )
        },
      },
      path: '/auth/webhook',
      store: Store.memory(),
    }),
  ],
})

wata.on('request', async (event) => {
  if (event.method === 'wallet_connect')
    await event.respond(['0x0000000000000000000000000000000000000001'])
})
```

### `relay`

Remote session between a web consumer and a mobile host, brokered by an untrusted HTTPS relay. The consumer issues a pairing link (typically shown as a QR code); the mobile host scans it and connects. All bodies are end-to-end encrypted, so the relay only forwards opaque ciphertext. Receivers default to SSE and can fall back to long-poll with `receive: 'poll'`.

[See example →](./examples/relay)

#### Consumer

Lazily starts the session on the first request and emits a `'prompt'` event carrying the pairing `uri` to display.

```ts
import { Wata, relay } from 'wata'

const wata = Wata.create({
  transports: [relay({ url: 'https://relay.example' })],
})

// Render the pairing link (e.g. as a QR code) when it's issued.
wata.on('prompt', ({ uri }) => renderQrCode(uri))

const { result } = await wata.send({ method: 'ping', params: [] })
```

#### Host

Built once with listeners registered up front, then connect with the scanned/pasted pairing uri.

```ts
import { Wata, relay } from 'wata/host'

const wata = Wata.create({
  transports: [relay({ receive: 'poll' })],
})

wata.on('request', (event) => event.respond('pong'))

// Start the session with the scanned/pasted pairing uri.
await wata.relay.start({ pairingUri })
```

#### Relay server

Run a relay anywhere that speaks web-standard `fetch` — a single long-lived Node/Bun/Deno process, or one Cloudflare Durable Object per channel.

```ts
import { createServer } from 'node:http'
import { Relay, Server, Store } from 'wata/server'

const relay = Relay.create({ store: Store.memory() })
createServer(Server.node(relay).listener).listen(8787)
```

## License

[MIT](./LICENSE). Copyright © wevm.
