---
'wata': patch
---

Unified the window-transport readiness handshake so each side announces back once on the peer's announce, letting a late-mounting host (e.g. a still-loading iframe) still ready and flush its buffered frames.
