# relay playground

Three plain TypeScript scripts — a `consumer`, a `relay` server, and a
`host` — exercising the full end-to-end-encrypted relay flow over real
HTTP. The relay only ever sees ciphertext.

```sh
pnpm build  # the scripts import the built `wata` package

# in three terminals:
pnpm --filter relay-playground dev:relay     # relay server on :4860
pnpm --filter relay-playground dev:consumer  # prints a `dev:host '<uri>'` line
pnpm --filter relay-playground dev:host '<uri>'
```

The consumer sends a `ping` and prints a pairing uri. Paste the printed
`pnpm dev:host '<uri>'` line into the third terminal: the session keys
end-to-end and the buffered ping flushes. Like a real wallet, the host
prompts you to **approve** or **deny** the request (`y`/`n`) — approve
answers `pong`, deny rejects with a `4001` user-rejected error. The host
then pushes an `accountsChanged` notification back. Both sides stay open
until you Ctrl-C.

## SSE vs short polling

Each peer receives over SSE by default. Set `RECEIVE=poll` to use the
short-polling fallback (instant `wait=0` GETs every ~2s, spec §5.3) for
environments where SSE is unreliable — the relay's buffering (spec §5.4)
bridges the gaps between polls. The two peers can mix modes:

```sh
RECEIVE=poll pnpm --filter relay-playground dev:consumer
RECEIVE=poll pnpm --filter relay-playground dev:host '<uri>'
```
