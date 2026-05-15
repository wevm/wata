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

wata.on('request', (c) => {
  if (c.method === 'wallet_getAccounts') c.respond(['0xabc…'])
})
```

### `deviceCode`

Cross-device session over HTTP using the OAuth 2.0 Device Authorization Grant (RFC 8628) with PKCE. The consumer surfaces a short `user_code` to the user and polls until the host approves.

[See example →](./examples/deviceCode)

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
    baseUrl: 'https://wallet.example',
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
    path: '/auth/device',
    store: Kv.memory(),
  }) 
})

wata.on('request', (c) => {
  if (c.method === 'wallet_signMessage') c.respond('0xdeadbeef')
})

createServer(wata.listener).listen(3000)
```

## License

[MIT](./LICENSE). Copyright © wevm.
