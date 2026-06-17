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

  test('feeds Wata.create as a consumer transport', async () => {
    const transport = mobileLink({
      host: 'https://wallet.example',
      openLink: () => {},
      returnUrl: 'https://app.example/urpc/cb',
    })
    const wata = Wata.create({ transports: [transport] })
    const session = await wata.mobileLink.start()
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(wata.mobileLink).toEqualTypeOf<Pick<typeof wata.mobileLink, 'start'>>()
    // handleUrl lives on the started session, not the handle.
    expectTypeOf(wata.mobileLink).not.toHaveProperty('handleUrl')
    expectTypeOf(session.handleUrl).toEqualTypeOf<(url: string) => void>()
    expectTypeOf(session.transport.handleUrl).toEqualTypeOf<(url: string) => void>()
    // `host` was pinned at construction → optional at start.
    expectTypeOf(wata.mobileLink.start)
      .parameter(0)
      .toEqualTypeOf<MobileLink.StartOptions<{ host: string }> | undefined>()
  })

  test('start requires host when it was omitted at construction', () => {
    const transport = mobileLink({
      openLink: () => {},
      returnUrl: 'https://app.example/urpc/cb',
    })
    expectTypeOf(transport.start)
      .parameter(0)
      .toEqualTypeOf<
        Required<Pick<MobileLink.Options, 'host'>> & Pick<MobileLink.Options, 'target'>
      >()
    expectTypeOf(transport.start({ host: 'https://wallet.example' })).toEqualTypeOf<Promise<void>>()
    // @ts-expect-error host is required when it was omitted at construction
    transport.start()
  })

  test('start options expose a unified `target` (not `scheme` / `universalLink`)', () => {
    expectTypeOf<MobileLink.StartOptions>().toHaveProperty('host')
    expectTypeOf<MobileLink.StartOptions>().toHaveProperty('target')
    expectTypeOf<MobileLink.StartOptions>().not.toHaveProperty('scheme')
    expectTypeOf<MobileLink.StartOptions>().not.toHaveProperty('universalLink')
    expectTypeOf<MobileLink.Options>().toHaveProperty('target')
    expectTypeOf<MobileLink.Options>().not.toHaveProperty('scheme')
    expectTypeOf<MobileLink.Options>().not.toHaveProperty('universalLink')
  })
})
