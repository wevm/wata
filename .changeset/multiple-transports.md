---
"wata": major
---

**Breaking:** Replaced `transport` options with `transports` arrays and added multi-transport `Wata.create` support.

```diff
-const wata = Wata.create({ transport: postMessage() })
+const wata = Wata.create({ transports: [postMessage()] })
 await wata.send({ method: 'ping', params: [] })

+const multi = Wata.create({ transports: [webhookCallback(...), deviceCode(...)] })
+await multi.webhookCallback.send({ method: 'ping', params: [] })
```
