# mobileLink example

This example runs two tiny Expo apps:

- Spendlet: asks to connect Ironbank.
- Ironbank: approves or denies the request.

Run Ironbank:

```sh
pnpm install
pnpm --filter example-mobile-link dev:host
```

Run Spendlet:

```sh
pnpm --filter example-mobile-link dev:consumer
```

Open Ironbank first, then open Spendlet and press "Connect Ironbank".

Expo Go can load each app, but the full custom-scheme handoff needs installed
development builds so iOS or Android can register the `example-ironbank` and
`example-spendlet` URL schemes.
