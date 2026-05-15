<p align="center">
  <a href="https://www.npmjs.com/package/wata">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/v/wata?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/npm/v/wata?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="Version">
    </picture>
  </a>
  <a href="https://github.com/wevm/wata/blob/main/LICENSE">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/l/wata?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/npm/l/wata?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="MIT License">
    </picture>
  </a>
</p>

<p align="center"><b>Encrypted JSON-RPC sessions between a consumer and a host, over any transport.</b></p>

<p align="center">
  <a href="#features">Features</a> · <a href="#install">Install</a> · <a href="#transports">Transports</a> · <a href="#usage">Usage</a> · <a href="#license">License</a>
</p>

## Features

- **End-to-end encrypted**: every session is AEAD-encrypted with per-session keys derived from an authenticated key exchange. Transports never see plaintext payloads.
- **Bidirectional JSON-RPC**: request/response and fire-and-forget notifications in both directions, with id correlation, batching, and structured errors.
- **Transport-agnostic**: the same `Wata` API runs over `postMessage`, OAuth-style device codes, mobile deep-links, webhook callbacks, and relays.

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

#### Consumer

```ts
import { Wata, postMessage } from 'wata'

const wata = Wata.create({
  transport: postMessage({
    host: 'https://wallet.example',
    target: ({ host }) => window.open(host, '_blank', 'popup=1'),
  }),
})

const { result } = await wata.send({
  method: 'wallet_getAccounts',
  params: [],
})
```

#### Host

```ts
import { Wata, postMessage } from 'wata/host'

const wata = Wata.create({
  transport: postMessage(),
})

wata.on('request', (event) => {
  if (event.method === 'wallet_getAccounts') event.respond(['0xabc…'])
})
```

### `deviceCode`

Cross-device session over HTTP using the OAuth 2.0 Device Authorization Grant (RFC 8628) with PKCE. The consumer surfaces a short `user_code` to the user and polls until the host approves.

#### Consumer

```ts
import { Wata, deviceCode } from 'wata'

const wata = Wata.create({
  transport: deviceCode({
    url: 'https://wallet.example/auth/device',
    onPrompt: ({ userCode, verificationUri }) => {
      console.log(`Visit ${verificationUri} and enter ${userCode}`)
    },
  }),
})

const { result } = await wata.send({
  method: 'wallet_signMessage',
  params: ['hello'],
})
```

#### Host

```ts
import { createServer } from 'node:http'
import { Wata, Kv, deviceCode } from 'wata/host'

const wata = Wata.create({ 
  transport: deviceCode({
    store: Kv.memory(),
    baseUrl: 'https://wallet.example',
    path: '/auth/device',
    html: {
      render: ({ userCode }) =>
        new Response(
          `<form method="post"><input name="user_code" value="${userCode ?? ''}" /><button>Approve</button></form>`,
          { headers: { 'content-type': 'text/html' } },
        ),
      authenticate: async ({ request, actions }) => {
        const body = await request.formData()
        await actions.approve(String(body.get('user_code')))
        return new Response('approved')
      },
    },
  }) 
})

wata.on('request', (event) => {
  if (event.method === 'wallet_signMessage') event.respond('0xdeadbeef')
})

createServer(wata.listener).listen(3000)
```

## License

[MIT](./LICENSE). Copyright © wevm.
