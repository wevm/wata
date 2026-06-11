---
'wata': patch
---

Hardened the window transport: inbound frames are now pinned to the bound peer window, and the consumer re-announces `hello` on the host's first `ready` so a late-mounting host still readies and flushes its buffered frames.
