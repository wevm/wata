import { describe, expect, test } from 'vp/test'
import { relay } from 'wata'

describe('relay', () => {
  test('rejects an insecure url before issuing any request', async () => {
    let calls = 0
    const fetch = (async () => {
      calls += 1
      return new Response(null, { status: 204 })
    }) as unknown as typeof globalThis.fetch
    const transport = relay({ fetch, url: 'http://192.168.1.5:4860' })
    await expect(transport.start()).rejects.toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must be an HTTPS URL (or HTTP loopback; pass \`allowPrivateNetwork\` for LAN development)
      Details: received http://192.168.1.5:4860]
    `,
    )
    // The URL is validated before the channel subscribes, so no signed
    // request ever leaves for an insecure relay.
    expect(calls).toBe(0)
  })

  test('rejects a relay url with a query or fragment', async () => {
    const transport = relay({ url: 'https://relay.example/?x=1' })
    await expect(transport.start()).rejects.toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must not contain a query or fragment
      Details: received https://relay.example/?x=1]
    `,
    )
  })

  test('throws when no url is supplied at construction or start', async () => {
    const transport = relay()
    // The type forbids `start()` here (url is required when omitted at
    // construction); this guards the runtime fallback for untyped callers.
    // @ts-expect-error url is required at start when omitted at construction
    await expect(transport.start()).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Transport.TransportError: relay url must be supplied to \`relay({ url })\` or \`start({ url })\`]`,
    )
  })

  test('accepts a url supplied at start, overriding construction', async () => {
    // A start-time url is validated like a construction-time one.
    const transport = relay()
    await expect(
      transport.start({ url: 'https://relay.example/?x=1' }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must not contain a query or fragment
      Details: received https://relay.example/?x=1]
    `,
    )
  })
})
