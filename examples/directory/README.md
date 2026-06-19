# Directory server

A public, **non-authoritative** index of wata hosts. Consumers query
`GET /v1/hosts` to discover candidate wallets, then fetch each candidate's
authoritative `host.json` to learn which transports it speaks.

This demo crawls a fixed seed list of the local example hosts and wraps the
handler in permissive CORS so the browser [`consumer-web`](../consumer-web) can
query it cross-origin.

```sh
pnpm install
pnpm dev # http://localhost:4870
```

Seeds (override with env vars):

- [`host-web`](../host-web) on `http://localhost:5173` → `window`, `device-code`, `mobile-web-auth`
- [`host-mobile`](../host-mobile) on `http://localhost:8788` → `mobile-link`

Used by:

- [`consumer-web`](../consumer-web)
- [`consumer-cli`](../consumer-cli)
- [`consumer-mobile`](../consumer-mobile)
