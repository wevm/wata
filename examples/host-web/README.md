# host-web

A web wallet (Vite + Cloudflare Worker) that accepts connections from every
consumer over the transport each one needs:

| Transport       | Path / surface       | Consumer                                |
| --------------- | -------------------- | --------------------------------------- |
| `deviceCode`    | `/auth/device`       | [`consumer-cli`](../consumer-cli)       |
| `mobileWebAuth` | `/auth/mobile`       | [`consumer-mobile`](../consumer-mobile) |
| `postMessage`   | `/host.html` (popup) | [`consumer-web`](../consumer-web)       |

```sh
pnpx gitpick https://github.com/wevm/wata/tree/main/examples/host-web host-web
cd host-web
pnpm install
pnpm dev # http://localhost:5173
```

The Worker (`src/worker.ts`) composes the two HTTP transports and serves
`host.json` + the approval pages; the browser host page (`src/host-page.ts`)
runs the `postMessage` transport. All three share one config in `src/host.ts`.
