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

| Transport         | Description                                                                                                                                                          | Peers             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `postMessage`     | Same-device browser session over a `Window`, `WindowProxy`, or `MessagePort` (popup, iframe, channel).                                                               | Browser ⇄ Browser |
| `deviceCode`      | OAuth 2.0 Device Authorization Grant (RFC 8628) over HTTP, with PKCE and a bring-your-own approval UI.                                                               | CLI ⇄ Browser     |
| `mobileWebAuth`   | Same-device mobile app to web host flow using browser auth and encrypted app-link callbacks.                                                                         | Mobile ⇄ Browser  |
| `webhookCallback` | Signed HTTP registration + callback flow for consumers that can receive webhooks.                                                                                    | Server ⇄ Server   |
| `relay`           | Remote session over an untrusted HTTPS relay; the web consumer shows a QR/link, the mobile host scans it, exchanging end-to-end-encrypted bodies (SSE or long-poll). | Web ⇄ Mobile      |
| `mobileLink`      | Direct, ongoing same-device session between two mobile apps over OS deep links                                                                                       | Mobile ⇄ Mobile   |

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

wata.onRequest(async (c) => {
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

wata.onPrompt((prompt) => {
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

wata.onRequest(async (c) => {
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

wata.onRequest(async (event) => {
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

wata.onEnvelope((envelope, meta) => {
  if (envelope.type !== 'rpc-responses') return
  console.log(envelope.payload)
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

wata.onRequest(async (event) => {
  if (event.method === 'wallet_connect')
    await event.respond(['0x0000000000000000000000000000000000000001'])
})
```

### `relay`

Remote session between a web consumer and a mobile host, brokered by an untrusted HTTPS relay. The consumer issues a pairing link (typically shown as a QR code); the mobile host scans it and connects. All bodies are end-to-end encrypted, so the relay only forwards opaque ciphertext. Receivers default to SSE and can fall back to long-poll with `receive: 'poll'`.

[See example →](./examples/relay)

#### Consumer

Starts the session, which resolves with the pairing `uri` to display, then sends once the host connects.

```ts
import { Wata, relay } from 'wata'

const wata = Wata.create({
  transports: [relay({ url: 'https://relay.example' })],
})

// `start()` resolves with the pairing prompt — render it (e.g. as a QR
// code) for the host to scan. (Or subscribe via `wata.onPrompt`.)
const { uri } = await wata.start()
renderQrCode(uri)

const { result } = await wata.send({ method: 'ping', params: [] })
```

#### Host

Built once with listeners registered up front, then connect with the scanned/pasted pairing uri.

```ts
import { Wata, relay } from 'wata/host'

const wata = Wata.create({
  transports: [relay({ receive: 'poll' })],
})

wata.onRequest((event) => event.respond('pong'))

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

### `mobileLink`

Direct, ongoing same-device session between two mobile apps over OS deep links. Feed OS-routed callbacks back in via `transport.handleUrl(url)`.

[See example →](./playgrounds/mobileLink)

#### Consumer

Hands off to the host on the first request, then receives the encrypted, identity-verified response via the callback deep link.

```ts
import * as Linking from 'expo-linking'
import { Wata, mobileLink } from 'wata'

const wata = Wata.create({
  baseUrl: 'https://app.example',
  meta: { name: 'Example App' },
  transports: [
    mobileLink({
      host: 'https://wallet.example',
      async openLink(url) {
        await Linking.openURL(url)
      },
      returnUrl: 'com.example.app://cb',
    }),
  ],
})

// Feed OS-routed callback deep links back into the transport.
Linking.addEventListener('url', ({ url }) => wata.mobileLink.handleUrl(url))

const { result } = await wata.send({ method: 'wallet_connect', params: [] })
```

#### Host

Verifies the inbound consumer, answers approved requests, and opens the consumer's `return_url` to deliver the signed response.

```ts
import * as Linking from 'expo-linking'
import { Identity, Wata, mobileLink } from 'wata/host'

const wata = Wata.create({
  baseUrl: 'https://wallet.example',
  identity: Identity.fromPrivateKey(privateKey),
  meta: { name: 'Example Wallet' },
  transports: [
    mobileLink({
      async openLink(url) {
        await Linking.openURL(url)
      },
      scheme: 'com.example.wallet',
    }),
  ],
})

wata.onRequest(async (event) => {
  if (event.method === 'wallet_connect')
    await event.respond(['0x0000000000000000000000000000000000000001'])
})

// Feed OS-routed inbound deep links back into the transport.
Linking.addEventListener('url', ({ url }) => wata.mobileLink.handleUrl(url))
```

## Directory

#### Server

```ts
import { createServer } from 'node:http'
import { Directory, Server, Store } from 'wata/server'

const store = Store.memory()
const origins = ['https://wallet.example', 'https://other.example']

// Index the seed list now, then keep it fresh (run on a cron in production).
await Directory.crawl({ origins, store })
setInterval(() => Directory.crawl({ origins, store }), 60 * 60 * 1000)

// Serve `/v1/hosts` — `create` returns a web-standard `{ fetch }` handler.
const directory = Directory.create({ store })
createServer(Server.node(directory).listener).listen(8788)
```

On Cloudflare, back it with KV and run the crawl from a cron trigger:

```ts
import { Directory, Store } from 'wata/server'

const origins = ['https://wallet.example']

export default {
  fetch(request: Request, env: Env) {
    return Directory.create({ store: Store.cloudflare(env.DIRECTORY_KV) }).fetch(request)
  },
  scheduled(_event: ScheduledEvent, env: Env) {
    return Directory.crawl({ origins, store: Store.cloudflare(env.DIRECTORY_KV) })
  },
}
```

#### Query

```ts
import { Discovery, Wata, relay } from 'wata'

// 1. Discover relay-capable hosts.
const response = await fetch('https://directory.example/v1/hosts?transport=relay')
const { items } = await response.json()

// 2. Validate the candidate against its own host.json.
const host = await Discovery.fetchHost(items[0].origin)

// 3. Create the consumer over the validated host's advertised relay,
//    targeting the host's `deep_link` so the pairing link opens its app.
const wata = Wata.create({
  transports: [
    relay({
      target: host.deep_link?.universal_link ?? host.deep_link?.scheme,
      url: host.transports.relay.url,
    }),
  ],
})

// 4. Connect — `start()` resolves with the pairing prompt to render for
//    the host to scan.
const { uri } = await wata.start()
renderQrCode(uri)

const { result } = await wata.send({ method: 'ping', params: [] })
```

## License

[MIT](./LICENSE). Copyright © wevm.
