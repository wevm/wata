import { Handshake, Transport, deviceCode } from 'handshakes'
import { describe, expectTypeOf, test } from 'vp/test'

describe('deviceCode (consumer)', () => {
  test('returns a single-exchange consumer-role transport', () => {
    const transport = deviceCode({
      url: 'https://wallet.example/auth/device',
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
  })

  test('feeds Handshake.create as a consumer transport', () => {
    const transport = deviceCode({
      url: 'https://wallet.example/auth/device',
    })
    const handshake = Handshake.create({ transport })
    expectTypeOf(handshake.role).toEqualTypeOf<'consumer'>()
  })
})
