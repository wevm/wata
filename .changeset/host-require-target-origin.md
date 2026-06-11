---
'wata': patch
---

Required an explicit `targetOrigin` on the host-side `postMessage` transport for Window targets, dropping the insecure `'*'` default.
