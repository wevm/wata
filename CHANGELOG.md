# wata

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
