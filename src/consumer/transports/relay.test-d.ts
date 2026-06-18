import { describe, expectTypeOf, test } from 'vp/test'
import { Relay, Session, Transport, Wata, relay } from 'wata'

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

  test('start requires url when it was omitted at construction', () => {
    const transport = relay()
    // url was not pinned at construction → required at start.
    expectTypeOf(transport.start)
      .parameter(0)
      .toEqualTypeOf<Required<Pick<Relay.Options, 'url'>> & Pick<Relay.Options, 'target'>>()
    expectTypeOf(transport.start({ url: 'https://relay.example' })).toEqualTypeOf<
      Promise<Relay.Prompt>
    >()
    // @ts-expect-error url is required when it was omitted at construction
    transport.start()
    // @ts-expect-error url is required when it was omitted at construction
    transport.start({ target: 'example-wallet' })
  })

  test('start makes url optional when it was pinned at construction', () => {
    const transport = relay({ url: 'https://relay.example' })
    expectTypeOf(transport.start)
      .parameter(0)
      .toEqualTypeOf<Relay.StartOptions<{ url: string }> | undefined>()
    expectTypeOf(transport.start()).toEqualTypeOf<Promise<Relay.Prompt>>()
    expectTypeOf(transport.start({ target: 'example-wallet' })).toEqualTypeOf<
      Promise<Relay.Prompt>
    >()
    expectTypeOf(transport.start({ url: 'https://other.example' })).toEqualTypeOf<
      Promise<Relay.Prompt>
    >()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const transport = relay({ url: 'https://relay.example' })
    const wata = Wata.create({ transports: [transport] })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })

  test('forwards the target through a single-transport `wata.start` and resolves with the session', () => {
    const wata = Wata.create({ transports: [relay({ url: 'https://relay.example' })] })
    expectTypeOf(wata.start({ target: 'example-wallet' })).toEqualTypeOf<
      Session.Session<undefined, (typeof wata.transports)[0]>
    >()
    expectTypeOf(wata.start()).toEqualTypeOf<
      Session.Session<undefined, (typeof wata.transports)[0]>
    >()
  })

  test('surfaces the relay transport by name on a multi-transport consumer', () => {
    const wata = Wata.create({
      transports: [
        relay({ url: 'https://relay.example' }),
        relay({ url: 'https://other.example' }),
      ],
    })
    expectTypeOf(wata.relay.start)
      .parameter(0)
      .toEqualTypeOf<Relay.StartOptions<{ url: string }> | undefined>()
    expectTypeOf(wata.relay.start({ target: 'example-wallet' })).toEqualTypeOf<
      Session.Session<undefined, (typeof wata.transports)[number]>
    >()
  })

  test('forces url at `wata.start` when the relay was built without one', () => {
    const wata = Wata.create({ transports: [relay()] })
    expectTypeOf(wata.start({ url: 'https://relay.example' })).toEqualTypeOf<
      Session.Session<undefined, (typeof wata.transports)[0]>
    >()
    // @ts-expect-error url is required when the relay was built without one
    wata.start()
  })

  test('surfaces the relay prompt payload on the consumer session `prompt` event', async () => {
    const wata = Wata.create({ transports: [relay({ url: 'https://relay.example' })] })
    const session = await wata.start()
    expectTypeOf(session.prompt).toEqualTypeOf<
      (Relay.Prompt & { transport: 'relay' }) | undefined
    >()
    session.onPrompt((prompt) => {
      expectTypeOf(prompt.transport).toEqualTypeOf<'relay'>()
      expectTypeOf(prompt.expiresAt).toEqualTypeOf<number>()
      expectTypeOf(prompt.uri).toEqualTypeOf<string>()
    })
  })

  test('prompt payload shape', () => {
    expectTypeOf<Relay.Prompt>().toEqualTypeOf<{ expiresAt: number; uri: string }>()
  })
})
