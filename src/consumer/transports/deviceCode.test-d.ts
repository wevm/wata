import { describe, expectTypeOf, test } from 'vp/test'
import { Discovery, Wata, Transport, deviceCode } from 'wata'

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
    const meta: Discovery.Meta = { name: 'Acme CLI', icon: 'https://acme.dev/i.png' }
    deviceCode({
      url: 'https://wallet.example/auth/device',
      meta,
    })
  })

  test('accepts `consumerUrl` typed as string', () => {
    deviceCode({
      url: 'https://wallet.example/auth/device',
      consumerUrl: 'https://acme.dev',
    })
  })
})
