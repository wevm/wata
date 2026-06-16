---
"wata": patch
---

The `relay` transport `url` is now optional and can be supplied dynamically at start time (`wata.relay.start({ url })`). `start()` now resolves with the transport's pairing prompt, so consumers can read the pairing `uri` without subscribing to `onPrompt` (`const { uri } = await wata.start()`).
