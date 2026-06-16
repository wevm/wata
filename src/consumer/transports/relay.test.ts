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

  test('throws when no url is set at construction or start', async () => {
    const transport = relay()
    await expect(transport.start()).rejects.toThrowErrorMatchingInlineSnapshot(
      '[Transport.TransportError: relay requires a `url` — set it on `relay({ url })` or `wata.relay.start({ url })`]',
    )
  })

  test('accepts a relay url supplied dynamically at start', async () => {
    const transport = relay()
    // A start-time url is validated like a construction-time one, so an
    // insecure dynamic url is rejected before any request leaves.
    await expect(
      transport.start({ url: 'http://192.168.1.5:4860' }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must be an HTTPS URL (or HTTP loopback; pass \`allowPrivateNetwork\` for LAN development)
      Details: received http://192.168.1.5:4860]
    `,
    )
  })
})
