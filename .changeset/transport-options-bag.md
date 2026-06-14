---
"wata": minor
---

Refactored the `Transport.Transport` generic from six positional type parameters (`<role, name, sendValue, meta, prompt, startOptions>`) to three (`<role, name, options>`), where `options` is a single bag with optional `meta`, `prompt`, `sendValue`, and `startOptions` fields. `role` and `name` stay positional; spell out only the shape fields a transport actually widens.

```ts
// Before
Transport.Transport<'consumer', 'relay', void, Transport.NoMessageMeta, Prompt, StartOptions>

// After
Transport.Transport<'consumer', 'relay', { prompt: Prompt; startOptions: StartOptions }>
```

Added `Transport.Any<role, name>` for `extends` constraints that accept any transport regardless of its `send` value (the bare `Transport<role, name>` pins `sendValue` to `void`). Runtime behavior is unchanged.
