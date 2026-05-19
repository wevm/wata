import { describe, expectTypeOf, test } from 'vp/test'
import { Relay, relayServer } from 'wata/server'

describe('relayServer', () => {
  test('returns `{ fetch, listener }`', () => {
    const server = relayServer()
    expectTypeOf(server.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
    expectTypeOf(server.listener).toBeFunction()
  })

  test('options expose responseTimeout', () => {
    expectTypeOf<Relay.relayServer.Options>().toMatchTypeOf<{
      responseTimeout?: number | undefined
    }>()
  })
})
