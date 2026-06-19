# consumer-mobile

A mobile app (Expo) that **discovers** wallets from the
[`directory`](../directory). Tapping a wallet fetches that origin's `host.json`
and chooses a transport from what it advertises:

| Wallet advertises | Transport       | Example host                    |
| ----------------- | --------------- | ------------------------------- |
| `mobile-web-auth` | `mobileWebAuth` | [`host-web`](../host-web)       |
| `mobile-link`     | `mobileLink`    | [`host-mobile`](../host-mobile) |

```sh
pnpx gitpick https://github.com/wevm/wata/tree/main/examples/consumer-mobile consumer-mobile
cd consumer-mobile
pnpm install
```

`mobileLink` opens custom URL schemes between apps, which requires an Expo
**development build**. Build once, then run the dev loop:

```sh
pnpm exec npx expo run:ios   # build + install the dev client (once)

pnpm dev          # Metro (8082)
pnpm dev:worker   # consumer.json discovery worker (:8789)
```

- Requires the [`directory`](../directory) on `http://localhost:4870`.
- A `mobile-web-auth` wallet (e.g. [`host-web`](../host-web)) opens in a system
  browser auth session.
- A `mobile-link` wallet (e.g. [`host-mobile`](../host-mobile)) opens app-to-app
  via its custom URL scheme.

The discovery worker publishes `consumer.json` so each host can verify this
app's callback URI (`mobileWebAuth`) and return url (`mobileLink`).
