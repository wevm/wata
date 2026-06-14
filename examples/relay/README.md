# Relay Example

A web app (`consumer`) establishes an end-to-end-encrypted session with
an Expo mobile app (`host`) through a stateless `relay` server, then
messages back and forth. The relay only ever sees ciphertext.

This example is a small workspace of three packages:

| Package    | Role                                                      |
| ---------- | --------------------------------------------------------- |
| `relay`    | Stateless rendezvous server (`@hono/node-server`).        |
| `consumer` | "Web app" — Vite + React, renders the pairing QR code.    |
| `host`     | "Mobile app" — Expo + React Native, scans/pastes to pair. |

```sh
pnpx gitpick https://github.com/wevm/wata/tree/main/examples/relay relay
cd relay
pnpm install
```

## Run it

Start the relay server and the web consumer together:

```sh
pnpm dev
```

This boots the `relay` (port 4860), waits for it to listen, then starts
the `consumer` (http://localhost:5183). Open the consumer and press
**send ping** — it prints a pairing QR code and a copyable `urpc://` uri.

Then start the Expo host on your phone or a simulator:

```sh
pnpm dev:host
```

The QR encodes a neutral `urpc://?…` pairing link — the consumer only
knows the relay address, never a specific wallet. Copy the link from the
consumer and paste it into the host app to pair. Like a real wallet, the
host prompts you to **approve** or **deny** each inbound `ping` request —
approve answers `pong`, deny rejects with a `4001` user-rejected error.
The host can also push notifications back; the session stays open until
you disconnect.

> The consumer defaults the relay address to the page's own hostname
> (`http://<hostname>:4860`), so opening it via a LAN address hands your
> phone a reachable relay too. Override with `VITE_RELAY_URL`.
