import { describe, expectTypeOf, test } from 'vp/test'
import { Relay, Transport, Wata, relay } from 'wata/host'

describe('relay (host)', () => {
  test('returns an ongoing host-role transport', () => {
    const transport = relay({
      pairingSecret: 'secret',
      sessionId: 'session',
      url: 'https://relay.example/r',
    })
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'host'>>()
  })

  test('feeds Wata.create as a host transport', () => {
    const wata = Wata.create({
      transports: [
        relay({
          pairingSecret: 'secret',
          sessionId: 'session',
          url: 'https://relay.example/r',
        }),
      ],
    })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
  })

  test('options expose url, sessionId, pairingSecret, and fetch', () => {
    expectTypeOf<Relay.Options>().toMatchTypeOf<{
      fetch?: typeof fetch | undefined
      pairingSecret: string
      sessionId: string
      url: string
    }>()
  })

  test('`discovery` contributes a relay binding', () => {
    const transport = relay({
      pairingSecret: 'secret',
      sessionId: 'session',
      url: 'https://relay.example/r',
    })
    expectTypeOf(transport.discovery).toEqualTypeOf<Transport.DiscoveryBinding | undefined>()
  })
})
