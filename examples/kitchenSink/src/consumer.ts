import {
  Kv,
  PostMessage,
  Wata,
  WebhookCallback,
  deviceCode,
  postMessage,
  webhookCallback,
} from 'wata'

export const baseUrl = 'http://localhost:5173'

export const prompts = {
  resolveWebhook: undefined as ((prompt: WebhookCallback.Prompt) => void) | undefined,
  webhook: undefined as WebhookCallback.Prompt | undefined,
}

export const consumer = Wata.create({
  baseUrl,
  meta: { name: 'Kitchen Sink Consumer' },
  privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
  transports: [
    deviceCode({
      onPrompt({ userCode, verificationUriFull }) {
        console.log(`open ${verificationUriFull}`)
        console.log(`user_code: ${userCode}`)
      },
      pollingInterval: 1_000,
      url: `${baseUrl}/auth/device`,
    }),
    postMessage({
      host: `${baseUrl}/host.html`,
      target({ host }) {
        if (typeof window === 'undefined')
          throw new PostMessage.PopupBlockedError('postMessage demo runs in the browser')
        const popup = window.open(host, 'wata-host', 'popup=1,width=420,height=360')
        if (!popup) throw new PostMessage.PopupBlockedError('popup was blocked')
        return popup
      },
    }),
    webhookCallback({
      host: `${baseUrl}/.well-known/urpc/host.json`,
      onPrompt(prompt) {
        prompts.webhook = prompt
        prompts.resolveWebhook?.(prompt)
        console.log(`open ${prompt.verificationUri}`)
      },
      path: '/consumer/callback',
      store: Kv.memory(),
    }),
  ],
})
