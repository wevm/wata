# mobileLink playground

This playground runs two Expo apps:

- consumer app: `exampleapp`
- wallet app: `examplewallet`

Run the wallet app:

```sh
pnpm --filter mobile-link-playground dev:host
```

Run the consumer app:

```sh
pnpm --filter mobile-link-playground dev:consumer
```

The dev scripts use LAN hosting so iOS Simulator receives a reachable IPv4
Metro URL instead of a `127.0.0.1` URL that may not match Metro's local bind.

Open the wallet app first, then open the consumer app and press "Send". The
consumer opens `examplewallet:///auth/mobile-link`, the wallet shows the request
payload, then tapping "Send" opens the consumer callback URL with the response.

Expo Go can smoke-load each role, but it cannot complete the custom-scheme
handoff because only installed apps/development builds register `examplewallet`
and `exampleapp`. Use development builds or installed simulator apps for the
full two-app ping flow.

An optional Hono discovery server is still available:

```sh
pnpm --filter mobile-link-playground serve:discovery
```

If you point the consumer at the server instead of the wallet app, set
`EXPO_PUBLIC_HOST_URL` to your server URL, for example
`http://192.168.1.10:4748/auth/mobile-link`.
