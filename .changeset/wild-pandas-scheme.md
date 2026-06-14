---
"wata": minor
---

Added a relay pairing-link `scheme` option, settable at construction or per call via `start`, to target a wallet chosen out of band.

```ts
relay({ url, scheme: 'example-wallet' })
// OR
await wata.relay.start({ scheme: 'example-wallet' }) // example-wallet://?version=1&...
```
