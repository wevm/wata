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

  test('html hooks expose render and state-based approval actions', () => {
    mobileWebAuth({
      html: {
        authenticate: (options) => {
          expectTypeOf(options.actions.approve).toEqualTypeOf<
            (state?: string | undefined) => Promise<Response>
          >()
          expectTypeOf(options.actions.deny).toEqualTypeOf<
            (state?: string | undefined, message?: string | undefined) => Promise<Response>
          >()
          expectTypeOf(options.actions.get).toEqualTypeOf<
            (state: string) => Promise<MobileWebAuth.PendingRecord | undefined>
          >()
          return new Response('ok')
        },
        render: (options) => {
          expectTypeOf(options.authorization).toEqualTypeOf<MobileWebAuth.PendingRecord>()
          expectTypeOf(options.actions.approve).toEqualTypeOf<
            (state?: string | undefined) => Promise<Response>
          >()
          return new Response(options.authorization.state)
        },
      },
    })
  })
})
