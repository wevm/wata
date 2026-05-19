# Relay Playground

Start the Hono host and in-memory relay:

```sh
pnpm --filter relay-playground dev:host
```

Start the browser consumer:

```sh
pnpm --filter relay-playground dev:consumer
```

Open http://localhost:5176 and click `send ping`.
