import { describe, expectTypeOf, test } from 'vp/test'
import { Transport, Wata, mobileWebAuth } from 'wata'

describe('mobileWebAuth (consumer)', () => {
  test('returns a single-exchange consumer-role transport', () => {
    const transport = mobileWebAuth({
      callback: 'com.example.app:/auth',
      host: {
        id: 'wallet',
        identity_pubkey: 'a'.repeat(43),
        name: 'Wallet',
        origin: 'https://wallet.example',
        transports: {
          'mobile-web-auth': { auth_url: 'https://wallet.example/auth/mobile' },
        },
        version: '1.0',
      },
      openAuthSession: () => undefined,
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const transport = mobileWebAuth({
      callback: 'com.example.app:/auth',
      host: 'https://wallet.example',
      openAuthSession: () => undefined,
    })
    const wata = Wata.create({ transports: [transport] })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })
})
