import { describe, expectTypeOf, test } from 'vp/test'
import { MobileLink, Transport, Wata, mobileLink } from 'wata/host'

describe('mobileLink (host)', () => {
  test('returns an ongoing host-role transport with `.fetch`, `.listener`, and a URL handler', () => {
    const transport = mobileLink({
      scheme: 'examplewallet',
      universalLink: 'https://wallet.example/auth/mobile-link',
    })
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'host'>>()
    expectTypeOf(transport.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
    expectTypeOf(transport.handle).toEqualTypeOf<(url: string | URL) => Promise<void>>()
    expectTypeOf(transport.listener).toBeFunction()
  })

  test('feeds Wata.create as a host transport', () => {
    const wata = Wata.create({
      privateKey: '0x' as `0x${string}`,
      transports: [mobileLink({ scheme: 'examplewallet' })],
    })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
  })

  test('options expose scheme, path, universalLink, responseTimeout, and open', () => {
    expectTypeOf<MobileLink.Options>().toMatchTypeOf<{
      open?: ((url: string) => unknown) | undefined
      path?: string | undefined
      responseTimeout?: number | undefined
      scheme: string
      universalLink?: string | undefined
    }>()
  })

  test('`discovery` contributes a mobile-link binding', () => {
    const transport = mobileLink({ scheme: 'examplewallet' })
    expectTypeOf(transport.discovery).toEqualTypeOf<Transport.DiscoveryBinding | undefined>()
  })
})
