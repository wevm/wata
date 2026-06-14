import { Identity, PostMessage, Store, Wata, deviceCode, postMessage, webhookCallback } from 'wata'

export const baseUrl = 'http://localhost:5173'

export const consumer = Wata.create({
  baseUrl,
  identity: Identity.fromPrivateKey(
    '0x1111111111111111111111111111111111111111111111111111111111111111',
  ),
  meta: { name: 'Kitchen Sink Consumer' },
  transports: [
    deviceCode({
      pollingInterval: 1_000,
      url: `${baseUrl}/auth/device`,
    }),
    postMessage({
      host: `${baseUrl}/host.html`,
      target({ host }) {
        if (typeof window === 'undefined')
          throw new PostMessage.PopupBlockedError('postMessage demo runs in the browser')
        // Convey our origin out of band so the host can pin it (spec §3.1).
        const url = `${host}?origin=${encodeURIComponent(location.origin)}`
        const popup = window.open(url, 'wata-host', 'popup=1,width=420,height=360')
        if (!popup) throw new PostMessage.PopupBlockedError('popup was blocked')
        return popup
      },
    }),
    webhookCallback({
      host: `${baseUrl}/.well-known/urpc/host.json`,
      path: '/consumer/callback',
      store: Store.memory(),
    }),
  ],
})

consumer.onPrompt((prompt) => {
  if (prompt.transport !== 'deviceCode') return
  console.log(`open ${prompt.verificationUriFull}`)
  console.log(`user_code: ${prompt.userCode}`)
})
