---
"wata": minor
---

**Breaking:** Replaced the generic `wata.on(event, listener)` / `wata.off(event, listener)` surface with one method per event. Subscribe via `onClose`, `onError`, `onOpen`, `onNotification`, `onEnvelope` (and consumer-only `onPrompt`); unsubscribe via the matching `offX`.

```ts
// Before
wata.on('prompt', ({ uri }) => renderQrCode(uri))
wata.on('rpc-responses', (responses, meta) => {})
host.on('request', async (event) => event.respond('pong'))
host.on('request', 'ping', () => 'pong')

// After
wata.onPrompt(({ uri }) => renderQrCode(uri))
wata.onEnvelope((envelope, meta) => {
  if (envelope.type !== 'rpc-responses') return
  console.log(envelope.payload, meta)
})
host.onRequest(async (event) => event.respond('pong'))
host.onRequest('ping', () => 'pong')
```
