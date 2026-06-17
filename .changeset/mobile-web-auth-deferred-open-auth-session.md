---
"wata": minor
---

Made `openAuthSession` deferrable to `start()` on the consumer `mobile-web-auth` transport. It is now optional at construction and can be supplied (alongside `host`) at start time, so a single hoisted `Wata.create()` can be shared between a discovery server (which only serves `consumer.json` via `wata.fetch` and never starts a session) and the app (which injects its native browser auth-session primitive at start). `start`/`send` throw `Transport.TransportError` when neither construction nor start supplies it.

```diff
-const wata = Wata.create({
-  transports: [mobileWebAuth({ callback, host, openAuthSession })],
-})
-const session = await wata.start()
+const wata = Wata.create({
+  transports: [mobileWebAuth({ callback })],
+})
+const session = await wata.start({ host, openAuthSession })
```
