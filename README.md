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
| `webhookCallback` | Signed HTTP registration + callback flow for consumers that can receive webhooks.                      | Server ⇄ Server   |
| `mobileLink`      | Encrypted ongoing session over deep links or universal links, with signed host identity bootstrap.     | Mobile ⇄ Web      |

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
  transports: [
    deviceCode({
      url: 'https://wallet.example/auth/device',
      onPrompt(c) {
        console.log(`Visit ${c.verificationUri} and enter ${c.userCode}`)
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

Mounts the device-code endpoints under `/auth/device`, renders a minimal approval form, marks the request as approved on submit, and answers `wallet_connect` requests.

```ts
import { createServer } from 'node:http'
import { Wata, Kv, deviceCode } from 'wata/host'

const wata = Wata.create({
  baseUrl: 'https://wallet.example',
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
      store: Kv.memory(),
    }),
  ],
})

wata.on('request', async (c) => {
  if (c.method === 'wallet_connect')
    await c.respond(['0x0000000000000000000000000000000000000001'])
})

createServer(wata.listener).listen(3000)
```

### `webhookCallback`

Server-to-server session where the consumer registers a signed intent with the host, sends the user to a verification URL, then receives the signed JSON-RPC response at its webhook endpoint.

[See example →](./examples/webhookCallback)

#### Consumer

Publishes `consumer.json`, starts a webhook listener, opens the host's verification URL for the user, then waits for the callback response.

```ts
import { Kv, Wata, webhookCallback } from 'wata'

const wata = Wata.create({
  baseUrl: 'https://app.example',
  meta: { name: 'Example App' },
  privateKey,
  transports: [
    webhookCallback({
      host: 'https://wallet.example',
      onPrompt({ verificationUri }) {
        console.log(`Visit ${verificationUri}`)
      },
      path: '/callback',
      store: Kv.memory(),
    }),
  ],
})

const { result } = await wata.send({
  method: 'wallet_connect',
  params: [],
})
```

#### Host

Publishes `host.json`, accepts signed registrations, renders an approval form, and responds to approved requests.

```ts
import { Wata, Kv, webhookCallback } from 'wata/host'

const wata = Wata.create({
  baseUrl: 'https://wallet.example',
  meta: { name: 'Example Wallet' },
  privateKey,
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
      store: Kv.memory(),
    }),
  ],
})

wata.on('request', async (event) => {
  if (event.method === 'wallet_connect')
    await event.respond(['0x0000000000000000000000000000000000000001'])
})
```

### `mobileLink`

Mobile session over deep links or universal links. The consumer opens the host link with an ephemeral key share, verifies the host identity signature, then exchanges encrypted URL frames.

[See example →](./examples/mobileLink)

#### Consumer

```ts
import { Wata, mobileLink } from 'wata'

const wata = Wata.create({
  transports: [
    mobileLink({
      callbackUrl: 'exampleapp://callback',
      host: 'https://wallet.example',
      open: (url) => Linking.openURL(url),
    }),
  ],
})

const { result } = await wata.send({
  method: 'wallet_connect',
  params: [],
})
```

#### Host

```ts
import { Wata, mobileLink } from 'wata/host'

const wata = Wata.create({
  baseUrl: 'https://wallet.example',
  meta: { name: 'Example Wallet' },
  privateKey,
  transports: [
    mobileLink({
      path: '/auth/mobile-link',
      scheme: 'examplewallet',
    }),
  ],
})

wata.on('request', async (event) => {
  if (event.method === 'wallet_connect')
    await event.respond(['0x0000000000000000000000000000000000000001'])
})
```

## License

[MIT](./LICENSE). Copyright © wevm.
