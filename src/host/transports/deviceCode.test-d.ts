import { describe, expectTypeOf, test } from 'vp/test'
import { Discovery } from 'wata'
import { DeviceCode, Kv, Transport, Wata, deviceCode } from 'wata/host'

describe('deviceCode (host)', () => {
  test('returns a single-exchange host-role transport with `.fetch` + `.listener`', () => {
    const store = Kv.memory()
    const transport = deviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: () => new Response('ok'),
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store,
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
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: () => new Response('ok'),
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store,
    })
    const wata = Wata.create({ transport })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
  })

  test('html.render receives `userCode`, `record`, `request`, and `meta`', () => {
    deviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: () => new Response('ok'),
        render: (options) => {
          expectTypeOf(options.userCode).toEqualTypeOf<string | undefined>()
          expectTypeOf(options.record).toEqualTypeOf<DeviceCode.PendingRecord | undefined>()
          expectTypeOf(options.request).toEqualTypeOf<Request>()
          expectTypeOf(options.meta).toEqualTypeOf<Discovery.Meta | undefined>()
          return new Response('ok')
        },
      },
      path: '/auth/device',
      store: Kv.memory(),
    })
  })

  test('`baseUrl` is optional (falls back to request origin / parent baseUrl)', () => {
    deviceCode({
      html: {
        authenticate: () => new Response('ok'),
        render: () => new Response('ok'),
      },
      store: Kv.memory(),
    })
  })

  test('`discovery` contributes a device-code binding', () => {
    const transport = deviceCode({
      html: {
        authenticate: () => new Response('ok'),
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store: Kv.memory(),
    })
    expectTypeOf(transport.discovery).toEqualTypeOf<Transport.DiscoveryBinding | undefined>()
  })

  test('html.authenticate receives `request` and an `actions` bag', () => {
    deviceCode({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: (options) => {
          expectTypeOf(options.request).toEqualTypeOf<Request>()
          expectTypeOf(options.actions.approve).toEqualTypeOf<(userCode: string) => Promise<void>>()
          expectTypeOf(options.actions.deny).toEqualTypeOf<(userCode: string) => Promise<void>>()
          expectTypeOf(options.actions.get).toEqualTypeOf<
            (userCode: string) => Promise<DeviceCode.PendingRecord | undefined>
          >()
          return new Response('ok')
        },
        render: () => new Response('ok'),
      },
      path: '/auth/device',
      store: Kv.memory(),
    })
  })

  test('Kv shape — `get` is generic per-call, `set` accepts unknown', () => {
    expectTypeOf<Kv.Kv>().toMatchTypeOf<{
      delete: (key: string) => Promise<void>
      get: <value = unknown>(key: string) => Promise<value | undefined>
      set: (key: string, value: unknown, options?: Kv.set.Options | undefined) => Promise<void>
    }>()
  })
})
