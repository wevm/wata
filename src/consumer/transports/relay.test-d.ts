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

  test('start accepts an optional scheme and resolves with the prompt', () => {
    const transport = relay({ url: 'https://relay.example' })
    expectTypeOf(transport.start).parameter(0).toEqualTypeOf<Relay.StartOptions | undefined>()
    expectTypeOf(transport.start()).toEqualTypeOf<Promise<Relay.Prompt>>()
    expectTypeOf(transport.start({ scheme: 'example-wallet' })).toEqualTypeOf<
      Promise<Relay.Prompt>
    >()
  })

  test('constructs with no options and accepts a start-time url', () => {
    const transport = relay()
    expectTypeOf(transport.start({ url: 'https://relay.example' })).toEqualTypeOf<
      Promise<Relay.Prompt>
    >()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const transport = relay({ url: 'https://relay.example' })
    const wata = Wata.create({ transports: [transport] })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })

  test('forwards the scheme through a single-transport `wata.start` and resolves with the prompt', () => {
    const wata = Wata.create({ transports: [relay({ url: 'https://relay.example' })] })
    expectTypeOf(wata.start({ scheme: 'example-wallet' })).toEqualTypeOf<Promise<Relay.Prompt>>()
    expectTypeOf(wata.start()).toEqualTypeOf<Promise<Relay.Prompt>>()
  })

  test('surfaces the relay transport by name on a multi-transport consumer', () => {
    const wata = Wata.create({
      transports: [
        relay({ url: 'https://relay.example' }),
        relay({ url: 'https://other.example' }),
      ],
    })
    expectTypeOf(wata.relay.start).parameter(0).toEqualTypeOf<Relay.StartOptions | undefined>()
    expectTypeOf(wata.relay.start({ scheme: 'example-wallet' })).toEqualTypeOf<
      Promise<Relay.Prompt>
    >()
  })

  test('surfaces the relay prompt payload on the consumer `prompt` event', () => {
    const wata = Wata.create({ transports: [relay({ url: 'https://relay.example' })] })
    wata.onPrompt((prompt) => {
      expectTypeOf(prompt.transport).toEqualTypeOf<'relay'>()
      expectTypeOf(prompt.expiresAt).toEqualTypeOf<number>()
      expectTypeOf(prompt.uri).toEqualTypeOf<string>()
    })
  })

  test('prompt payload shape', () => {
    expectTypeOf<Relay.Prompt>().toEqualTypeOf<{ expiresAt: number; uri: string }>()
  })
})
