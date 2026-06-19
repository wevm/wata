# consumer-cli

A Node CLI consumer that **discovers** wallets from the
[`directory`](../directory), then picks a transport from what the selected
wallet's `host.json` advertises:

| Wallet advertises | Transport    | Example host                    |
| ----------------- | ------------ | ------------------------------- |
| `device-code`     | `deviceCode` | [`host-web`](../host-web)       |
| otherwise         | `relay`      | [`host-mobile`](../host-mobile) |

```sh
pnpx gitpick https://github.com/wevm/wata/tree/main/examples/consumer-cli consumer-cli
cd consumer-cli
pnpm install

pnpm dev                       # connect to the first wallet in the directory
pnpm dev --wallet "Web Wallet" # connect to a wallet matching the given id/name
```

- Requires the [`directory`](../directory) on `http://localhost:4870`.
- A `device-code` wallet prints a short `user_code` to approve in a browser.
- A mobile wallet prints a pairing QR/link to scan from the wallet — this needs
  the shared [`relay`](../relay) server. For a physical device, set `RELAY_URL`
  to your machine's LAN address so the phone can reach the relay.

From the monorepo root, run `pnpm example:servers` to start the directory,
relay, and `host-web`, then `pnpm --filter example-consumer-cli dev --wallet Web`
in another terminal.
