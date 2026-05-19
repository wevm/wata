# mobileLink playground

Run the host:

```sh
pnpm --filter mobile-link-playground dev:host
```

Run the Expo consumer:

```sh
pnpm --filter mobile-link-playground dev:consumer
```

For a physical device, set `BASE_URL` on the host and `EXPO_PUBLIC_HOST_URL` on the consumer to your machine's LAN URL, for example `http://192.168.1.10:4748/auth/mobile-link`.
