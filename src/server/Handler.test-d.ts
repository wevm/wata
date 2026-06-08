import { describe, expectTypeOf, test } from 'vp/test'
import { Handler } from 'wata/server'

describe('listener', () => {
  test('returns a Node-shaped request listener', () => {
    const value = Handler.listener(async () => new Response('ok'))
    expectTypeOf(value).toEqualTypeOf<(req: unknown, res: unknown) => void>()
  })
})

describe('withListener', () => {
  test('adds a listener to a fetch server', () => {
    const server = Handler.withListener({ fetch: async () => new Response('ok') })
    expectTypeOf(server.listener).toEqualTypeOf<(req: unknown, res: unknown) => void>()
  })
})
