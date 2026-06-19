import { describe, expectTypeOf, test } from 'vp/test'
import { Session, Transport, Wata } from 'wata'
import { type Prompt, type StartOptions, walletConnect } from 'wata/walletConnect'

describe('walletConnect (consumer)', () => {
  test('returns an ongoing consumer-role transport named walletConnect', () => {
    const transport = walletConnect({ projectId: 'pid' })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.name).toEqualTypeOf<'walletConnect'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
  })

  test('requires projectId', () => {
    // @ts-expect-error projectId is required
    walletConnect({})
  })

  test('start takes an optional target override', () => {
    const transport = walletConnect({ projectId: 'pid' })
    expectTypeOf(transport.start).parameter(0).toEqualTypeOf<StartOptions | undefined>()
    expectTypeOf(transport.start()).toEqualTypeOf<Promise<Prompt>>()
    expectTypeOf(transport.start({ target: { uri: 'metamask://' } })).toEqualTypeOf<
      Promise<Prompt>
    >()
    expectTypeOf(transport.start({ target: { mobile: { native: 'metamask://' } } })).toEqualTypeOf<
      Promise<Prompt>
    >()
  })

  test('prompt payload shape', () => {
    expectTypeOf<Prompt>().toEqualTypeOf<{ uri: string }>()
  })

  test('feeds Wata.create and lifts start on a single transport', () => {
    const wata = Wata.create({ transports: [walletConnect({ chains: [1, 10], projectId: 'pid' })] })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(wata.start({ target: { uri: 'metamask://' } })).toEqualTypeOf<
      Session.Session<undefined, (typeof wata.transports)[0]>
    >()
    expectTypeOf(wata.start()).toEqualTypeOf<
      Session.Session<undefined, (typeof wata.transports)[0]>
    >()
  })

  test('surfaces the walletConnect handle by name', () => {
    const wata = Wata.create({ transports: [walletConnect({ projectId: 'pid' })] })
    expectTypeOf(wata.walletConnect.start).parameter(0).toEqualTypeOf<StartOptions | undefined>()
  })

  test('surfaces the prompt on the consumer session', async () => {
    const wata = Wata.create({ transports: [walletConnect({ projectId: 'pid' })] })
    const session = await wata.start()
    expectTypeOf(session.prompt).toEqualTypeOf<
      (Prompt & { transport: 'walletConnect' }) | undefined
    >()
  })
})
