import { describe, expectTypeOf, test } from 'vp/test'
import { Discovery, Transport, Wata, deviceCode } from 'wata'

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
    const wata = Wata.create({ transport })
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
})
