---
'wata': minor
---

The host `postMessage` transport now publishes a `window` discovery binding in `host.json`, so directory consumers can discover that an origin speaks `postMessage`. Pass `postMessage({ url })` to advertise the host page URL (absolute or a path resolved against `baseUrl`); defaults to `baseUrl`.
