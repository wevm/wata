import { describe, expectTypeOf, test } from 'vp/test'
import { DeviceCode, Wata, Kv, Transport, deviceCode } from 'wata/host'

describe('deviceCode (host)', () => {
  test('returns a single-exchange host-role transport with `.fetch` + `.listener`', () => {
    const store = Kv.memory()
    const transport = deviceCode({
      store,
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: () => new Response('ok'),
        authenticate: () => new Response('ok'),
      },
    })
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'host'>>()
    expectTypeOf(transport.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
    expectTypeOf(transport.listener).toBeFunction()
  })

  test('feeds Wata.create as a host transport', () => {
    const store = Kv.memory()
    const transport = deviceCode({
      store,
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: () => new Response('ok'),
        authenticate: () => new Response('ok'),
      },
    })
    const wata = Wata.create({ transport })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
  })

  test('html.render receives `userCode`, `record`, and `request`', () => {
    deviceCode({
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: (options) => {
          expectTypeOf(options.userCode).toEqualTypeOf<string | undefined>()
          expectTypeOf(options.record).toEqualTypeOf<DeviceCode.PendingRecord | undefined>()
          expectTypeOf(options.request).toEqualTypeOf<Request>()
          return new Response('ok')
        },
        authenticate: () => new Response('ok'),
      },
    })
  })

  test('html.authenticate receives `request` and an `actions` bag', () => {
    deviceCode({
      store: Kv.memory(),
      baseUrl: 'https://wallet.example',
      path: '/auth/device',
      html: {
        render: () => new Response('ok'),
        authenticate: (options) => {
          expectTypeOf(options.request).toEqualTypeOf<Request>()
          expectTypeOf(options.actions.approve).toEqualTypeOf<(userCode: string) => Promise<void>>()
          expectTypeOf(options.actions.deny).toEqualTypeOf<(userCode: string) => Promise<void>>()
          expectTypeOf(options.actions.get).toEqualTypeOf<
            (userCode: string) => Promise<DeviceCode.PendingRecord | undefined>
          >()
          return new Response('ok')
        },
      },
    })
  })

  test('Kv shape — `get` is generic per-call, `set` accepts unknown', () => {
    expectTypeOf<Kv.Kv>().toMatchTypeOf<{
      get: <value = unknown>(key: string) => Promise<value | undefined>
      set: (key: string, value: unknown, options?: Kv.set.Options | undefined) => Promise<void>
      delete: (key: string) => Promise<void>
    }>()
  })
})
