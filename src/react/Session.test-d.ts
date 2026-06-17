import { describe, expectTypeOf, test } from 'vp/test'
import { Wata, relay } from 'wata'
import { Wata as HostWata, relay as hostRelay } from 'wata/host'
import { useSession } from 'wata/react'

describe('useSession', () => {
  test('infers session, prompt, and notification payloads from the handle', () => {
    const wata = Wata.create({ transports: [relay({ url: 'https://relay.example' })] })

    type Result = ReturnType<typeof useSession<typeof wata>>
    type Session = Awaited<ReturnType<typeof wata.start>>

    expectTypeOf<Result['status']>().toEqualTypeOf<
      'closed' | 'error' | 'idle' | 'open' | 'pending'
    >()
    expectTypeOf<Result['error']>().toEqualTypeOf<Error | undefined>()
    expectTypeOf<Result['session']>().toEqualTypeOf<Session | undefined>()

    // `prompt` is the relay pairing prompt (tagged with its transport) or undefined.
    expectTypeOf<Result['prompt']>().toMatchTypeOf<
      { transport: 'relay'; uri: string } | undefined
    >()

    // `start` resolves with the live session.
    expectTypeOf<Awaited<ReturnType<Result['start']>>>().toEqualTypeOf<Session>()
  })

  test('typed callbacks flow through Options', () => {
    const wata = Wata.create({ transports: [relay({ url: 'https://relay.example' })] })

    useSession(wata, {
      start: true,
      onClose: (cause) => expectTypeOf(cause).toEqualTypeOf<Error | undefined>(),
      onError: (error) => expectTypeOf(error).toEqualTypeOf<Error>(),
      onNotification: (event) => expectTypeOf(event.method).toEqualTypeOf<string>(),
      onPrompt: (prompt) => expectTypeOf(prompt.uri).toEqualTypeOf<string>(),
    })

    // `start` also accepts the transport's start options object.
    useSession(wata, { start: { url: 'https://relay.example' } })
  })

  test('infers host request payloads via onRequest', () => {
    const wata = HostWata.create({ transports: [hostRelay({ receive: 'poll' })] })

    useSession(wata.relay, {
      onRequest: (event) => {
        expectTypeOf(event.method).toEqualTypeOf<string>()
        expectTypeOf(event.respond).toBeFunction()
      },
      start: { uri: 'urpc://?consumer_pubkey=abc' },
    })
  })
})
