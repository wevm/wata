import { describe, expectTypeOf, test } from 'vp/test'
import { DeviceCode, Discovery, Session, Transport, Wata, deviceCode } from 'wata'

describe('deviceCode (consumer)', () => {
  test('returns a single-exchange consumer-role transport', () => {
    const transport = deviceCode({
      url: 'https://wallet.example/auth/device',
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const transport = deviceCode({
      url: 'https://wallet.example/auth/device',
    })
    const wata = Wata.create({ transports: [transport] })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })

  test('accepts `meta` typed as Discovery.Meta', () => {
    const meta: Discovery.Meta = { icon: 'https://acme.dev/i.png', name: 'Acme CLI' }
    deviceCode({
      meta,
      url: 'https://wallet.example/auth/device',
    })
  })

  test('accepts `consumerUrl` typed as string', () => {
    deviceCode({
      consumerUrl: 'https://acme.dev',
      url: 'https://wallet.example/auth/device',
    })
  })

  test('start requires url when it was omitted at construction', () => {
    const transport = deviceCode()
    expectTypeOf(transport.start)
      .parameter(0)
      .toEqualTypeOf<
        Required<Pick<DeviceCode.Options, 'url'>> &
          Pick<DeviceCode.Options, 'consumerUrl' | 'meta' | 'pollingInterval' | 'pollingTimeout'>
      >()
    expectTypeOf(transport.start({ url: 'https://wallet.example/auth/device' })).toEqualTypeOf<
      Promise<void>
    >()
    // @ts-expect-error url is required when it was omitted at construction
    transport.start()
    // @ts-expect-error url is required when it was omitted at construction
    transport.start({ pollingInterval: 1000 })
  })

  test('start makes url optional when it was pinned at construction', () => {
    const transport = deviceCode({ url: 'https://wallet.example/auth/device' })
    expectTypeOf(transport.start)
      .parameter(0)
      .toEqualTypeOf<DeviceCode.StartOptions<{ url: string }> | undefined>()
    expectTypeOf(transport.start()).toEqualTypeOf<Promise<void>>()
    expectTypeOf(transport.start({ meta: { name: 'Acme CLI' } })).toEqualTypeOf<Promise<void>>()
    expectTypeOf(transport.start({ url: 'https://other.example' })).toEqualTypeOf<Promise<void>>()
  })

  test('forces url at `wata.start` when the transport was built without one', () => {
    const wata = Wata.create({ transports: [deviceCode()] })
    expectTypeOf(wata.start({ url: 'https://wallet.example/auth/device' })).toEqualTypeOf<
      Session.Session<undefined, (typeof wata.transports)[0]>
    >()
    // @ts-expect-error url is required when the transport was built without one
    wata.start()
  })
})
