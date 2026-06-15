# mobileLink playground

Two Expo apps that talk to each other over OS deep links using the
`mobileLink` transport — no relay or backend in the message path.

- [`consumer/`](./consumer) — the dapp. Initiates the handshake and sends
  JSON-RPC requests (`ping`, `echo`).
- [`host/`](./host) — the wallet. Verifies the consumer, signs the handshake
  with its long-term identity key, and asks the user to approve or reject each
  request.
  Each app folder also ships a small **Cloudflare Worker** (`worker.ts` +
  `wrangler.jsonc`) that publishes that app's own uRPC discovery document, so each
  origin serves its own manifest exactly as it would in production.

```diagram
╭──────────────╮  com.wata.mobilelink.host://request?…   ╭───────────────╮
│  consumer    │ ─────────────────────────────────────▶  │  host (wallet)│
│  (dapp)      │ ◀─────────────────────────────────────  │               │
╰──────────────╯  com.wata.mobilelink.consumer://cb?…     ╰───────────────╯
```

## Discovery workers

In production the consumer fetches the host's `host.json` and the host fetches
the consumer's `consumer.json` from their HTTPS origins. Each app folder
reproduces this with its own Cloudflare Worker:

- [`host/worker.ts`](./host/worker.ts) serves `host.json` on `:8788`.
- [`consumer/worker.ts`](./consumer/worker.ts) serves `consumer.json` on `:8789`.

Separate origins (ports) are required because `Discovery.fetchHost` /
`fetchConsumer` reject any document whose `origin` does not match the URL it was
fetched from. The SDK's discovery schema allows `http://` only for loopback
hosts (`localhost` / `127.0.0.1` / `[::1]`), and the iOS simulator shares the
Mac's network, so the apps reach `http://localhost:878x` without TLS. (Physical
devices can't — `localhost` would resolve to the device.)

The host identity seed is a fixed RFC 8032 test vector. The host worker
advertises the derived public key in `host.json` (hardcoded in
[`host/src/config.ts`](./host/src/config.ts) so the worker needn't import `wata`
under the symlinked dev build); the host app signs the handshake with the
matching private key. **It is a demo key; never reuse it in production.**

## Running

`mobileLink` opens custom URL schemes between two installed apps, which
requires Expo **development builds** (Expo Go cannot register custom schemes for
two separate apps). Both apps depend on `expo-dev-client`, so each build ships a
dev launcher that lists the Metro servers on your network and lets you pick one
at runtime. The native `ios/` project is generated on demand by `expo run:ios`
(continuous native generation) and is gitignored — never commit it.

First build and install both dev clients on the same simulator (once):

```sh
pnpm --filter mobile-link-host-playground exec npx expo run:ios
pnpm --filter mobile-link-consumer-playground exec npx expo run:ios --port 8082
```

Then the day-to-day dev loop — each app has its **own Metro port** so the two
dev clients don't load each other's bundle:

Each of these is long-running, so give each its own terminal:

```sh
# 1 — symlink `wata` to source so changes are picked up live
pnpm dev

# 2 — wallet app (Metro on 8081)
pnpm --filter mobile-link-host-playground dev
# 3 — host.json worker (:8788)
pnpm --filter mobile-link-host-playground dev:worker

# 4 — dapp (Metro on 8082)
pnpm --filter mobile-link-consumer-playground dev
# 5 — consumer.json worker (:8789)
pnpm --filter mobile-link-consumer-playground dev:worker
```

Each app's dev launcher lists **every** Metro server on your network, so it is
easy to load the wrong bundle: in the **host** launcher pick the `8081` server
(`mobileLink host`), and in the **consumer** launcher pick the `8082` server
(`mobileLink consumer`). Tapping the host's `8081` server from the consumer app
is what makes the consumer render the host UI.

`pnpm dev` (`zile dev`) resolves `wata`'s `dist/*` entrypoints to `src/*.ts` via
symlinks. Each app's [`metro.config.cjs`](./host/metro.config.cjs) maps the
source's `.js` import specifiers back to `.ts` so Metro can bundle them — the
node playgrounds get this for free from `tsx`, Metro needs the hook.

Open the consumer app, tap **Send ping**: it deep-links into the host, which
approves and deep-links the signed response back. The host app shows each
inbound request; the consumer app shows the result.
