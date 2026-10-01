---
'wata': patch
---

Fixed device-code `/token` polls overwriting the user's approval. Pending polls now keep their `slow_down` timestamp under a separate store key and no longer write the device-code record back. On eventually-consistent stores like Cloudflare KV, a poll that read a stale `pending` copy could replace the approved record, which left the consumer polling until it timed out.
