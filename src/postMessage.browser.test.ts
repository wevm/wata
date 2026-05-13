import { expect, test } from 'vp/test'

// Smoke test for the browser project: proves Vitest + Playwright (Chromium)
// is wired up and that real `MessageChannel` / `postMessage` semantics are
// available. Phase 1 builds the `window` transport on top of these primitives.
test('MessageChannel: round-trips a message between two ports', async () => {
  const { port1, port2 } = new MessageChannel()

  const received = new Promise<unknown>((resolve) => {
    port2.addEventListener(
      'message',
      (event) => {
        resolve(event.data)
      },
      { once: true },
    )
    port2.start()
  })

  port1.postMessage({ hello: 'world' })

  await expect(received).resolves.toMatchInlineSnapshot(`
    {
      "hello": "world",
    }
  `)

  port1.close()
  port2.close()
})
