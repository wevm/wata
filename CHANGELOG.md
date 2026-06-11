# wata

## 0.0.3

### Patch Changes

- 782964d: Unified the window-transport readiness handshake so each side announces back once on the peer's announce, letting a late-mounting host (e.g. a still-loading iframe) still ready and flush its buffered frames.

## 0.0.2

### Patch Changes

- 4b8a619: Pinned window-transport inbound frames to the bound peer window [postMessage]

## 0.0.1

### Patch Changes

- fda7824: Initial release.
