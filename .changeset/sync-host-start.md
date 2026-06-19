---
"wata": minor
---

Made the host `start()` synchronous and symmetric with the consumer. `wata.start()` now returns the `Session` immediately instead of a `Promise<Session>`; the transport handshake runs in the background. Observe readiness via the new `session.ready` promise or the `'ready'` event (`session.onReady(...)`). Config errors still throw synchronously from `start()`; async start failures surface via `session.ready`, the `'ready'`/`'error'` events, and subsequent request/notify calls.
