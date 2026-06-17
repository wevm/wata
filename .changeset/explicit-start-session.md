---
"wata": minor
---

Redesigned the lifecycle so `Wata.create()` returns config only and `.start()` opens the live session carrying `send` / `notify` / `onRequest` / events / transport extras.

```diff
 const wata = Wata.create({
   transports: [relay({ url: 'https://relay.example' })],
 })

-wata.onPrompt((prompt) => renderQrCode(prompt.uri))
-const { result } = await wata.send({ method: 'ping', params: [] })
+const session = await wata.start()
+session.onPrompt((prompt) => renderQrCode(prompt.uri))
+const { result } = await session.send({ method: 'ping', params: [] })
```
