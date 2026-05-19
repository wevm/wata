import { describe, expectTypeOf, test } from 'vp/test'
import { Discovery, Relay, Transport, Wata, relay } from 'wata'

describe('relay (consumer)', () => {
  test('returns an ongoing consumer-role transport', () => {
    const transport = relay({
      pairingSecret: 'secret',
      sessionId: 'session',
      url: 'https://relay.example/r',
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const wata = Wata.create({
      transports: [
        relay({
          pairingSecret: 'secret',
          sessionId: 'session',
          url: 'https://relay.example/r',
        }),
      ],
    })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })

  test('accepts discovery mode with string or pre-parsed host document', () => {
    const document: Discovery.HostDocument = {
      id: 'wallet.example',
      identity_pubkey: '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc',
      name: 'Example Wallet',
      origin: 'https://wallet.example',
      transports: {
        relay: { url: 'https://relay.example/r' },
      },
      version: '1.0',
    }

    relay({
      host: 'https://wallet.example',
      pairingSecret: 'secret',
      sessionId: 'session',
    })
    relay({
      host: document,
      pairingSecret: 'secret',
      sessionId: 'session',
    })
  })

  test('options expose direct and discovery modes', () => {
    expectTypeOf<Relay.Options>().toMatchTypeOf<
      | {
          fetch?: typeof fetch | undefined
          host: string | Discovery.HostDocument
          pairingSecret: string
          sessionId: string
        }
      | {
          fetch?: typeof fetch | undefined
          pairingSecret: string
          sessionId: string
          url: string
        }
    >()
  })
})
