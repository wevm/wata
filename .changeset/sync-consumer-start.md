---
"wata": minor
---

Made the consumer handle's `start()` synchronous. It now returns the live `Session` directly instead of a `Promise<Session>`, so callers no longer need `await` to obtain the session. The transport handshake runs in the background.

Observe when the connection is established (and surface connect failures) via the new `session.ready` promise or the `'ready'` event (`session.onReady(...)`). `send()` / `notify()` continue to await readiness internally, so most callers can ignore it.

```ts
// before
const session = await wata.start()

// after
const session = wata.start()
await session.ready // optional — only when you need the connect outcome
```
