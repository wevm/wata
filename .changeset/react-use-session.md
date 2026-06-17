---
"wata": minor
---

Added a `wata/react` entrypoint exporting `useSession`, a hook that owns a `wata` session's lifecycle — starting it, subscribing to its event surface, mirroring `prompt`/`error` into React state, and closing it on unmount — so components no longer hand-roll refs, subscriptions, or cleanup. Works for both consumer sessions (`onPrompt` / `onNotification`) and host sessions (`onRequest`). It also accepts a factory handle, so several sessions can be merged into one with `Session.compose`:

```tsx
useSession(() => Session.compose([wata.deviceCode.start(), wata.webhookCallback.start()]), {
  onRequest: (event) => void event.respond({ ok: true }),
})
```

`react` is an optional peer dependency.

```tsx
import { Wata, relay } from 'wata'
import { useSession } from 'wata/react'

const wata = Wata.create({ transports: [relay({ url })] })

function App() {
  const { prompt, start, status } = useSession(wata, {
    onNotification: (event) => console.log(event),
  })

  async function send() {
    const session = await start()
    await session.send({ method: 'ping', params: [] })
  }
}
```
