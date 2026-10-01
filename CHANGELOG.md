# wata

## 0.4.2

### Patch Changes

- c46b483: Fixed device-code `/token` polls overwriting the user's approval. Pending polls now keep their `slow_down` timestamp under a separate store key and no longer write the device-code record back. On eventually-consistent stores like Cloudflare KV, a poll that read a stale `pending` copy could replace the approved record, which left the consumer polling until it timed out.

## 0.4.1

### Patch Changes

- e922518: Kept device-code polling active while an approved response was being persisted.

## 0.4.0

### Minor Changes

- b8322d5: Made the host `start()` synchronous and symmetric with the consumer. `wata.start()` now returns the `Session` immediately instead of a `Promise<Session>`; the transport handshake runs in the background. Observe readiness via the new `session.ready` promise or the `'ready'` event (`session.onReady(...)`). Config errors still throw synchronously from `start()`; async start failures surface via `session.ready`, the `'ready'`/`'error'` events, and subsequent request/notify calls.

## 0.3.0

### Minor Changes

- aca3996: Made the consumer handle's `start()` synchronous. It now returns the live `Session` directly instead of a `Promise<Session>`, so callers no longer need `await` to obtain the session. The transport handshake runs in the background.

  Observe when the connection is established (and surface connect failures) via the new `session.ready` promise or the `'ready'` event (`session.onReady(...)`). `send()` / `notify()` continue to await readiness internally, so most callers can ignore it.

  ```ts
  // before
  const session = await wata.start();

  // after
  const session = wata.start();
  await session.ready; // optional — only when you need the connect outcome
  ```

## 0.2.1

### Patch Changes

- 3411a27: Added a `connect` option to the consumer `postMessage` transport controlling when the connection (target acquisition, listener attach, hello) is established.

  `'lazy'` (default) keeps the existing behavior — the `target` callback runs on the first outbound frame so popups open inside the user gesture. `'eager'` connects during `start()`, so a gesture-free target (an iframe, an already-open window, a `MessagePort`) completes the handshake up front and receives proactive host notifications (e.g. `accountsChanged`) without first sending a request.

  ```ts
  postMessage({
    host: "https://wallet.example",
    connect: "eager",
    target: () => iframe.contentWindow!,
  });
  ```

## 0.2.0

### Minor Changes

- f313043: Redesigned the lifecycle so `Wata.create()` returns config only and `.start()` opens the live session carrying `send` / `notify` / `onRequest` / events / transport extras.

  ```diff
   const wata = Wata.create({
     transports: [relay({ url: 'https://relay.example' })],
   })

  -wata.onPrompt((prompt) => renderQrCode(prompt.uri))
  -const { result } = await wata.send({ method: 'ping', params: [] })
  +const session = await wata.start()
  +session.onPrompt((prompt) => renderQrCode(prompt.uri))
  +const { result } = await session.send({ method: 'ping', params: [] })
  ```

- f313043: Made `openAuthSession` deferrable to `start()` on the consumer `mobile-web-auth` transport. It is now optional at construction and can be supplied (alongside `host`) at start time, so a single hoisted `Wata.create()` can be shared between a discovery server (which only serves `consumer.json` via `wata.fetch` and never starts a session) and the app (which injects its native browser auth-session primitive at start). `start`/`send` throw `Transport.TransportError` when neither construction nor start supplies it.

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

- f313043: Added a `wata/react` entrypoint exporting `useSession`, a hook that owns a `wata` session's lifecycle — starting it, subscribing to its event surface, mirroring `prompt`/`error` into React state, and closing it on unmount — so components no longer hand-roll refs, subscriptions, or cleanup. Works for both consumer sessions (`onPrompt` / `onNotification`) and host sessions (`onRequest`). `react` is an optional peer dependency.

  ```tsx
  import { Wata, relay } from "wata";
  import { useSession } from "wata/react";

  const wata = Wata.create({ transports: [relay({ url })] });

  function App() {
    const { prompt, start, status } = useSession(wata, {
      onNotification: (event) => console.log(event),
    });

    async function send() {
      const session = await start();
      await session.send({ method: "ping", params: [] });
    }
  }
  ```

- f313043: Made the consumer `webhook-callback` transport concurrent. Each `send()` now registers an independent `auth_req_id` intent, so multiple requests can be in flight at once; inbound webhooks are routed to the matching intent and settle independently instead of closing the transport after the first response.

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

## 0.1.1

### Patch Changes

- 3d0b005: Added `Directory` server.
- cde49e2: Added a top-level `deep_link` field to parsed host discovery documents.
- cde49e2: Renamed the relay transport's `scheme` option to `target` on `relay({ target })` and `relay.start({ target })`.

## 0.1.0

### Minor Changes

- c7db7e3: **Breaking:** Replaced the generic `wata.on(event, listener)` / `wata.off(event, listener)` surface with one method per event. Subscribe via `onClose`, `onError`, `onOpen`, `onNotification`, `onEnvelope` (and consumer-only `onPrompt`); unsubscribe via the matching `offX`.

  ```ts
  // Before
  wata.on("prompt", ({ uri }) => renderQrCode(uri));
  wata.on("rpc-responses", (responses, meta) => {});
  host.on("request", async (event) => event.respond("pong"));
  host.on("request", "ping", () => "pong");

  // After
  wata.onPrompt(({ uri }) => renderQrCode(uri));
  wata.onEnvelope((envelope, meta) => {
    if (envelope.type !== "rpc-responses") return;
    console.log(envelope.payload, meta);
  });
  host.onRequest(async (event) => event.respond("pong"));
  host.onRequest("ping", () => "pong");
  ```

- 056453a: **Breaking:** Renamed the `Kv` namespace to `Store`.

  ```diff
  - import { Kv } from 'wata'
  + import { Store } from 'wata'
  ```

- 056453a: **Breaking:** Replaced the transport `onPrompt` callback with a unified consumer `'prompt'` event, discriminated by `transport`.

  ```diff
  - relay({ url, onPrompt: ({ uri }) => renderQrCode(uri) })
  + relay({ url })
  + wata.on('prompt', ({ uri }) => renderQrCode(uri))
  ```

- 8f38a48: Refactored the `Transport.Transport` generic from six positional type parameters (`<role, name, sendValue, meta, prompt, startOptions>`) to three (`<role, name, options>`), where `options` is a single bag with optional `meta`, `prompt`, `sendValue`, and `startOptions` fields. `role` and `name` stay positional; spell out only the shape fields a transport actually widens.

  ```ts
  // Before
  Transport.Transport<
    "consumer",
    "relay",
    void,
    Transport.NoMessageMeta,
    Prompt,
    StartOptions
  >;

  // After
  Transport.Transport<
    "consumer",
    "relay",
    { prompt: Prompt; startOptions: StartOptions }
  >;
  ```

  Added `Transport.Any<role, name>` for `extends` constraints that accept any transport regardless of its `send` value (the bare `Transport<role, name>` pins `sendValue` to `void`). Runtime behavior is unchanged.

- 6ee8a75: Added a relay pairing-link `scheme` option, settable at construction or per call via `start`, to target a wallet chosen out of band.

  ```ts
  relay({ url, scheme: "example-wallet" });
  // OR
  await wata.relay.start({ scheme: "example-wallet" }); // example-wallet://?version=1&...
  ```

### Patch Changes

- 056453a: Added `relay` transport.
- d1a693d: Added `mobileLink` transport.

## 0.0.4

### Patch Changes

- 7b874e5: Required an explicit `targetOrigin` on the host-side `postMessage` transport for Window targets, dropping the insecure `'*'` default.

## 0.0.3

### Patch Changes

- 782964d: Unified the window-transport readiness handshake so each side announces back once on the peer's announce, letting a late-mounting host (e.g. a still-loading iframe) still ready and flush its buffered frames.

## 0.0.2

### Patch Changes

- 4b8a619: Pinned window-transport inbound frames to the bound peer window [postMessage]

## 0.0.1

### Patch Changes

- fda7824: Initial release.
