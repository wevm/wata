# mobile-web-auth Example

A mobile app (`consumer`) authenticates with a web wallet (`host`) using
the `mobile-web-auth` transport: the app opens the wallet's authorization
URL in a system browser auth session, the user approves on the web, and
the wallet redirects once to the app's encrypted callback URI. No shared
backend, no polling — a single signed, end-to-end-encrypted round trip.

This example is a small workspace of two packages:

| Package    | Role                                                        |
| ---------- | ----------------------------------------------------------- |
| `consumer` | "Mobile app" — Expo + React Native, opens the auth session. |
| `host`     | "Web wallet" — Vite, serves discovery + the approval page.  |

Install from the repository root (the example's `consumer` and `host`
packages are picked up by the root pnpm workspace):

```sh
pnpm install
```

## Run it

Start the web host:

```sh
pnpm dev:host
```

This serves the wallet at http://localhost:5611. Vite delegates two paths
to `wata`:

- `GET /.well-known/urpc/host.json` — the host discovery document.
- `GET|POST /auth/mobile` — the authorization + approval endpoint.

Then start the Expo consumer:

```sh
pnpm dev:consumer
```

Open it on the **iOS simulator** (or web), tap **Connect wallet**, approve
on the page that opens, and the app prints the connected account.

## How it works

1. The consumer builds an authorization URL pointing at the host's
   `auth_url` (resolved from `host.json`), carrying the encrypted request,
   its ephemeral public key, and a one-time `state`.
2. `openAuthSession` opens it via `expo-web-browser`'s
   `openAuthSessionAsync`; the host renders the approval page.
3. On **Approve**, the host verifies the callback against the consumer's
   `consumer.json`, answers the queued JSON-RPC request, and redirects to
   `com.example.mobilewebauth://callback?...` with the encrypted response.
4. The auth session hands that URL back to the app, which decrypts it.

## Notes

- **Callback + discovery are shared constants.** The app registers
  `com.example.mobilewebauth://callback` (its `app.json` `scheme`) and the
  host allowlists it for the app's `https://app.example` origin. A real
  mobile app publishes its own `consumer.json` from an HTTPS app-link
  origin; here the host serves a demo allowlist because the app has no
  server of its own.
- **HTTPS for physical devices.** uRPC discovery requires HTTPS for
  non-loopback origins. `http://localhost:5611` works on the iOS simulator
  and web. For a physical device or the Android emulator, expose the host
  over an HTTPS tunnel and set `EXPO_PUBLIC_HOST_URL` (consumer) and
  `HOST_BASE_URL` (host) to that URL.
