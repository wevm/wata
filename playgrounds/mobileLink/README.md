# mobileLink playground

This playground runs two Expo apps:

- Spendlet: `spendlet`
- Ironbank: `ironbank`

Run Ironbank:

```sh
pnpm --filter mobile-link-playground dev:host
```

Run Spendlet:

```sh
pnpm --filter mobile-link-playground dev:consumer
```

The dev scripts use LAN hosting so iOS Simulator receives a reachable IPv4
Metro URL instead of a `127.0.0.1` URL that may not match Metro's local bind.

Open Ironbank first, then open Spendlet and press "Connect Ironbank". Spendlet
opens `ironbank:///auth/mobile-link`, Ironbank shows an account access request,
then tapping "Allow access" opens the Spendlet callback URL with the response.

Expo Go can smoke-load each role, but it cannot complete the custom-scheme
handoff because only installed apps/development builds register `ironbank` and
`spendlet`. Use development builds or installed simulator apps for the full
two-app authorization flow.

An optional Hono discovery server is still available:

```sh
pnpm --filter mobile-link-playground serve:discovery
```

If you point Spendlet at the server instead of Ironbank, set
`EXPO_PUBLIC_HOST_URL` to your server URL, for example
`http://192.168.1.10:4748/auth/mobile-link`.
