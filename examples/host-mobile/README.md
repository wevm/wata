# host-mobile

A mobile wallet (Expo) that accepts connections from every consumer:

| Transport    | Consumer                                                              |
| ------------ | --------------------------------------------------------------------- |
| `mobileLink` | [`consumer-mobile`](../consumer-mobile)                               |
| `relay`      | [`consumer-web`](../consumer-web) / [`consumer-cli`](../consumer-cli) |

```sh
pnpx gitpick https://github.com/wevm/wata/tree/main/examples/host-mobile host-mobile
cd host-mobile
pnpm install
```

`mobileLink` opens custom URL schemes between apps, which requires an Expo
**development build** (Expo Go can't register custom schemes). Build once, then
run the dev loop:

```sh
pnpm exec npx expo run:ios   # build + install the dev client (once)

pnpm dev          # Metro (8081)
pnpm dev:worker   # host.json discovery worker (:8788)
```

- **mobileLink** — open [`consumer-mobile`](../consumer-mobile) and connect to
  the mobile wallet; requests appear here to approve.
- **relay** — paste the pairing uri from [`consumer-web`](../consumer-web) or
  [`consumer-cli`](../consumer-cli) (requires the shared [`relay`](../relay)
  server) into the relay box, then approve incoming requests.

The discovery worker publishes `host.json` so the `mobileLink` consumer can
learn this host's scheme + identity. The identity seed in
[`src/config.ts`](./src/config.ts) is a demo key — never reuse it in production.
