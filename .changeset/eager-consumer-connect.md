---
"wata": patch
---

Added a `connect` option to the consumer `postMessage` transport controlling when the connection (target acquisition, listener attach, hello) is established.

`'lazy'` (default) keeps the existing behavior — the `target` callback runs on the first outbound frame so popups open inside the user gesture. `'eager'` connects during `start()`, so a gesture-free target (an iframe, an already-open window, a `MessagePort`) completes the handshake up front and receives proactive host notifications (e.g. `accountsChanged`) without first sending a request.

```ts
postMessage({
  host: 'https://wallet.example',
  connect: 'eager',
  target: () => iframe.contentWindow!,
})
```
