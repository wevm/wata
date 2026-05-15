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

| Transport     | Description                                                                                  | Peers                                          |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `postMessage` | Same-device browser session over a `Window`, `WindowProxy`, or `MessagePort` (popup, iframe, channel). | Browser ⇄ Browser |
| `deviceCode`  | OAuth 2.0 Device Authorization Grant (RFC 8628) over HTTP, with PKCE and a bring-your-own approval UI. | CLI ⇄ Browser     |

## Usage

### `postMessage`

Same-device browser session over a `Window`, `WindowProxy`, or `MessagePort`. The consumer supplies a `target` (popup, iframe, or channel port); the host defaults to its opener.

[See example →](./examples/postMessage)

#### Consumer

Opens a popup at the host URL and sends a `wallet_connect` request once the handshake completes.

```ts
import { Wata, postMessage } from 'wata'

const wata = Wata.create({
  transport: postMessage({
    host: 'https://wallet.example',
    target(c) {
      return window.open(c.host, '_blank', 'popup=1')
    },
  }),
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
  transport: postMessage(),
})

wata.on('request', (c) => {
  if (c.method === 'wallet_connect') c.respond(['0xabc…'])
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
  transport: deviceCode({
    url: 'https://wallet.example/auth/device',
    onPrompt(c) {
      console.log(`Visit ${c.verificationUri} and enter ${c.userCode}`)
    },
  }),
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
  transport: deviceCode({
    baseUrl: 'https://wallet.example',
    html: {
      async authenticate(c) {
        const body = await c.request.formData()
        await c.actions.approve(String(body.get('user_code')))
        return new Response('approved')
      },
      render(c) {
        return new Response(
          `<form method="post"><input name="user_code" value="${c.userCode ?? ''}" /><button>Approve</button></form>`,
          { headers: { 'content-type': 'text/html' } },
        )
      },
    },
    path: '/auth/device',
    store: Kv.memory(),
  }) 
})

wata.on('request', (c) => {
  if (c.method === 'wallet_connect') c.respond(['0xabc…'])
})

createServer(wata.listener).listen(3000)
```

## License

[MIT](./LICENSE). Copyright © wevm.
