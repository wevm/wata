---
'wata': patch
---

Made the window-transport handshake resilient to a peer that mounts after the consumer's first `hello` (e.g. an iframe host still loading). The consumer now re-announces `hello` the first time it hears the host's `ready`, so the host reliably marks ready and flushes any buffered outbound frames (such as an unsolicited host notification) instead of stranding them.
