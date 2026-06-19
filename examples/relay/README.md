# Relay server

A stateless rendezvous used by the `relay` transport so a web/CLI consumer can
reach the [`host-mobile`](../host-mobile) wallet. It forwards opaque,
end-to-end-encrypted bodies between two peer slots — it never sees plaintext.

```sh
pnpm install
pnpm dev # http://localhost:4860
```

Used by:

- [`consumer-web`](../consumer-web) → `host-mobile`
- [`consumer-cli`](../consumer-cli) → `host-mobile`
