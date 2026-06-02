import { describe, expectTypeOf, test } from 'vp/test'
import { Transport } from 'wata'
import { MobileWebAuth, Wata, mobileWebAuth } from 'wata/host'

describe('mobileWebAuth (host)', () => {
  test('returns a single-exchange host-role HTTP transport', () => {
    const transport = mobileWebAuth({
      html: {
        authenticate: ({ actions }) => actions.deny(),
      },
      path: '/auth/mobile',
    })
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
    expectTypeOf(transport).toMatchTypeOf<MobileWebAuth.MobileWebAuth>()
  })

  test('feeds Wata.create as a host transport', () => {
    const transport = mobileWebAuth({
      html: {
        authenticate: ({ actions }) => actions.deny(),
      },
    })
    const wata = Wata.create({ transports: [transport] })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
  })
})
