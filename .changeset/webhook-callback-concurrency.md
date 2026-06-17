---
"wata": minor
---

Made the consumer `webhook-callback` transport concurrent. Each `send()` now registers an independent `auth_req_id` intent, so multiple requests can be in flight at once; inbound webhooks are routed to the matching intent and settle independently instead of closing the transport after the first response.

- `exchange` is now `'ongoing'` (was `'single_exchange'`) — the session stays open across requests.
- `Registration` gained an `authReqId` field so callers can correlate and cancel a specific request.
- `cancel(authReqId?)` now targets a single intent when given an id, or cancels every in-flight intent when called with no argument (backward compatible).

```diff
-const registration = await session.send({ method: 'wallet_connect', params: [] })
-// further sends threw `ClosedError`
+const a = await session.send({ method: 'wallet_connect', params: [] })
+const b = await session.send({ method: 'personal_sign', params: [] })
+// both intents are live; cancel one with its id
+await session.webhookCallback.cancel(a.authReqId)
```
