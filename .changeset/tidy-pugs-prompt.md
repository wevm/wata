---
"wata": minor
---

**Breaking:** Replaced the transport `onPrompt` callback with a unified consumer `'prompt'` event, discriminated by `transport`.

```diff
- relay({ url, onPrompt: ({ uri }) => renderQrCode(uri) })
+ relay({ url })
+ wata.on('prompt', ({ uri }) => renderQrCode(uri))
```
