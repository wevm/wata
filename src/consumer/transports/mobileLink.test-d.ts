import { describe, expectTypeOf, test } from 'vp/test'
import { MobileLink, Transport, Wata, mobileLink } from 'wata'

describe('mobileLink (consumer)', () => {
  test('returns an ongoing consumer-role transport with handleUrl', () => {
    const transport = mobileLink({
      host: {
        id: 'wallet',
        identity_pubkey: 'a'.repeat(43),
        name: 'Wallet',
        origin: 'https://wallet.example',
        transports: {
          'mobile-link': { scheme: 'examplewallet', universal_link: 'https://wallet.example/urpc' },
        },
        version: '1.0',
      },
      openLink: () => {},
      returnUrl: 'https://app.example/urpc/cb',
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport.handleUrl).toEqualTypeOf<(url: string) => void>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer', 'mobileLink'>>()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const transport = mobileLink({
      host: 'https://wallet.example',
      openLink: () => {},
      returnUrl: 'https://app.example/urpc/cb',
    })
    const wata = Wata.create({ transports: [transport] })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(wata.mobileLink.handleUrl).toEqualTypeOf<(url: string) => void>()
    expectTypeOf(wata.mobileLink.transport.handleUrl).toEqualTypeOf<(url: string) => void>()
    // `host` can be deferred to `start`.
    expectTypeOf(wata.mobileLink.start)
      .parameter(0)
      .toEqualTypeOf<MobileLink.StartOptions | undefined>()
  })

  test('host is optional at construction when deferred to start', () => {
    const transport = mobileLink({
      openLink: () => {},
      returnUrl: 'https://app.example/urpc/cb',
    })
    expectTypeOf(transport.start).parameter(0).toEqualTypeOf<MobileLink.StartOptions | undefined>()
  })
})
