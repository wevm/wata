import { describe, expectTypeOf, test } from 'vp/test'
import { MobileWebAuth, Transport, Wata, mobileWebAuth } from 'wata/host'

describe('mobileWebAuth (host)', () => {
  test('returns a single-exchange host transport with `.fetch` and `.listener`', () => {
    const transport = mobileWebAuth({
      html: {
        authenticate: async ({ actions, request }) => {
          const form = await request.formData()
          return Response.redirect(await actions.approve(String(form.get('state'))))
        },
        render: ({ record }) => new Response(record?.state),
      },
    })
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'host'>>()
    expectTypeOf(transport.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
    expectTypeOf(transport.listener).toBeFunction()
  })

  test('feeds Wata.create as a host transport', () => {
    const wata = Wata.create({
      privateKey: '0x' as `0x${string}`,
      transports: [
        mobileWebAuth({
          html: {
            authenticate: () => new Response(null),
            render: () => new Response(null),
          },
        }),
      ],
    })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
    expectTypeOf(wata.mobileWebAuth.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
  })

  test('options expose path, fetch, and html hooks', () => {
    expectTypeOf<MobileWebAuth.Options>().toMatchTypeOf<{
      fetch?: typeof fetch | undefined
      html: MobileWebAuth.html.Hooks
      path?: string | undefined
    }>()
  })

  test('`discovery` contributes a mobile-web-auth binding', () => {
    const transport = mobileWebAuth({
      html: {
        authenticate: () => new Response(null),
        render: () => new Response(null),
      },
    })
    expectTypeOf(transport.discovery).toEqualTypeOf<Transport.DiscoveryBinding | undefined>()
  })
})
