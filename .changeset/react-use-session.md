---
"wata": minor
---

Added a `wata/react` entrypoint exporting `useSession`, a hook that owns a `wata` session's lifecycle — starting it, subscribing to its event surface, mirroring `prompt`/`error` into React state, and closing it on unmount — so components no longer hand-roll refs, subscriptions, or cleanup. Works for both consumer sessions (`onPrompt` / `onNotification`) and host sessions (`onRequest`). `react` is an optional peer dependency.

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
