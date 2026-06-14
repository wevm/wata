import { describe, expectTypeOf, test } from 'vp/test'
import { Relay, Transport, Wata, relay } from 'wata/host'

const uri =
  'urpc://?consumer_pubkey=ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8&pairing_secret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&relay=https%3A%2F%2Frelay.example&version=1'

describe('relay (host)', () => {
  test('returns an ongoing host-role transport', () => {
    const transport = relay({ uri })
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
    expectTypeOf(transport.name).toEqualTypeOf<'relay'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'host'>>()
  })

  test('constructs without a uri', () => {
    const transport = relay()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'host'>>()
  })

  test('start accepts an optional pairingUri', () => {
    const transport = relay()
    expectTypeOf(transport.start).parameter(0).toEqualTypeOf<Relay.relay.StartOptions | undefined>()
    expectTypeOf(transport.start()).toEqualTypeOf<Promise<void>>()
    expectTypeOf(transport.start({ pairingUri: uri })).toEqualTypeOf<Promise<void>>()
  })

  test('feeds Wata.create as a host transport', () => {
    const transport = relay({ uri })
    const wata = Wata.create({ transports: [transport] })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
  })

  test('surfaces the transport by name on the host (wata.relay)', () => {
    const wata = Wata.create({ transports: [relay()] })
    expectTypeOf(wata.relay.name).toEqualTypeOf<'relay'>()
    expectTypeOf(wata.relay.start)
      .parameter(0)
      .toEqualTypeOf<Relay.relay.StartOptions | undefined>()
    expectTypeOf(wata.relay.start({ pairingUri: uri })).toEqualTypeOf<Promise<void>>()
  })

  test('parseUri narrows the pairing link fields', () => {
    const parsed = Relay.parseUri(uri)
    expectTypeOf(parsed.consumerPublicKey).toEqualTypeOf<`0x${string}`>()
    expectTypeOf(parsed.pairingSecret).toEqualTypeOf<`0x${string}`>()
    expectTypeOf(parsed.relay).toEqualTypeOf<string>()
    expectTypeOf(parsed.version).toEqualTypeOf<1>()
  })
})
