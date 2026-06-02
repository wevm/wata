# mobileWebAuth playground

Expo consumer app plus a Hono Node host for the `mobileWebAuth` transport.

```sh
pnpm --filter mobile-web-auth-playground dev:host
pnpm --filter mobile-web-auth-playground dev:consumer
```

The default host origin is `http://localhost:4780`. Set `EXPO_PUBLIC_HOST_ORIGIN` for the Expo app and `BASE_URL` for the host when testing on a physical device or LAN URL.

The playground uses a fixed `mobilewebauth://callback` scheme and a host-side demo `consumer.json` allowlist. Production mobile apps should publish their own consumer discovery document from an HTTPS app-link origin.
