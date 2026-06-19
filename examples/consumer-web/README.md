# consumer-web

A browser consumer that **discovers** wallets from the
[`directory`](../directory). Two ways to connect:

1. **Universal QR** (always shown) — pairs via `relay`. Any mobile wallet can
   scan it, whether or not it is in the directory.
2. **Pick a wallet** from the directory — the consumer fetches that origin's
   `host.json` and chooses a transport from what it advertises:

| Wallet advertises | Transport     | Example host                    |
| ----------------- | ------------- | ------------------------------- |
| `window`          | `postMessage` | [`host-web`](../host-web)       |
| otherwise         | `relay`       | [`host-mobile`](../host-mobile) |

```sh
pnpx gitpick https://github.com/wevm/wata/tree/main/examples/consumer-web consumer-web
cd consumer-web
pnpm install
pnpm dev # http://localhost:5183
```

- Requires the [`directory`](../directory) on `http://localhost:4870`.
- A `window` wallet (e.g. [`host-web`](../host-web)) opens its host page in a
  popup via `postMessage`.
- A mobile wallet connects via the universal QR, which needs the shared
  [`relay`](../relay) server and a wallet such as [`host-mobile`](../host-mobile).

From the monorepo root, `pnpm example:web` starts this consumer together with
the directory, relay, and `host-web` in one command.
