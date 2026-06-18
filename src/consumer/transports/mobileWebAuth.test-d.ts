import { describe, expectTypeOf, test } from 'vp/test'
import { MobileWebAuth, Session, Transport, Wata, mobileWebAuth } from 'wata'

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

  test('start requires host when it was omitted at construction', () => {
    const transport = mobileWebAuth({
      callback: 'com.example.app:/auth',
      openAuthSession: () => undefined,
    })
    expectTypeOf(transport.start)
      .parameter(0)
      .toEqualTypeOf<
        Required<Pick<MobileWebAuth.Options, 'host'>> &
          Pick<MobileWebAuth.Options, 'authUrl' | 'openAuthSession'>
      >()
    expectTypeOf(transport.start({ host: 'https://wallet.example' })).toEqualTypeOf<Promise<void>>()
    // @ts-expect-error host is required when it was omitted at construction
    transport.start()
    // @ts-expect-error host is required when it was omitted at construction
    transport.start({ authUrl: 'https://wallet.example/auth/mobile' })
  })

  test('host + openAuthSession can both be deferred to start', () => {
    const transport = mobileWebAuth({ callback: 'com.example.app:/auth' })
    expectTypeOf(transport.start)
      .parameter(0)
      .toEqualTypeOf<
        Required<Pick<MobileWebAuth.Options, 'host'>> &
          Pick<MobileWebAuth.Options, 'authUrl' | 'openAuthSession'>
      >()
    expectTypeOf(
      transport.start({ host: 'https://wallet.example', openAuthSession: () => undefined }),
    ).toEqualTypeOf<Promise<void>>()
    // @ts-expect-error host is required when it was omitted at construction
    transport.start({ openAuthSession: () => undefined })
  })

  test('start makes host optional when it was pinned at construction', () => {
    const transport = mobileWebAuth({
      callback: 'com.example.app:/auth',
      host: 'https://wallet.example',
      openAuthSession: () => undefined,
    })
    expectTypeOf(transport.start)
      .parameter(0)
      .toEqualTypeOf<MobileWebAuth.StartOptions<{ host: string }> | undefined>()
    expectTypeOf(transport.start()).toEqualTypeOf<Promise<void>>()
    expectTypeOf(transport.start({ host: 'https://other.example' })).toEqualTypeOf<Promise<void>>()
  })

  test('forces host at `wata.start` when the transport was built without one', () => {
    const wata = Wata.create({
      transports: [
        mobileWebAuth({ callback: 'com.example.app:/auth', openAuthSession: () => undefined }),
      ],
    })
    expectTypeOf(wata.start({ host: 'https://wallet.example' })).toEqualTypeOf<
      Session.Session<undefined, (typeof wata.transports)[0]>
    >()
    // @ts-expect-error host is required when the transport was built without one
    wata.start()
  })
})
