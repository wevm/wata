import { describe, expectTypeOf, test } from 'vp/test'
import { Relay, Transport, Wata, relay } from 'wata'

describe('relay (consumer)', () => {
  test('returns an ongoing consumer-role transport', () => {
    const transport = relay({ url: 'https://relay.example' })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.name).toEqualTypeOf<'relay'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
  })

  test('does not accept a deprecated `onPrompt` option', () => {
    expectTypeOf<Relay.Options>().not.toHaveProperty('onPrompt')
  })

  test('feeds Wata.create as a consumer transport', () => {
    const transport = relay({ url: 'https://relay.example' })
    const wata = Wata.create({ transports: [transport] })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })

  test('surfaces the relay prompt payload on the consumer `prompt` event', () => {
    const wata = Wata.create({ transports: [relay({ url: 'https://relay.example' })] })
    wata.on('prompt', (prompt) => {
      expectTypeOf(prompt.transport).toEqualTypeOf<'relay'>()
      expectTypeOf(prompt.expiresAt).toEqualTypeOf<number>()
      expectTypeOf(prompt.uri).toEqualTypeOf<string>()
    })
  })

  test('prompt payload shape', () => {
    expectTypeOf<Relay.Prompt>().toEqualTypeOf<{ expiresAt: number; uri: string }>()
  })
})
