import { describe, expect, test } from 'vp/test'
import { Handler } from 'wata/server'

describe('listener', () => {
  test('returns a Node-shaped request listener', () => {
    const value = Handler.listener(async () => new Response('ok'))
    expect(typeof value).toMatchInlineSnapshot(`"function"`)
  })
})

describe('withListener', () => {
  test('adds a Node-shaped request listener to a fetch server', () => {
    const server = Handler.withListener({ fetch: async () => new Response('ok') })
    expect({
      fetch: typeof server.fetch,
      listener: typeof server.listener,
    }).toMatchInlineSnapshot(`
      {
        "fetch": "function",
        "listener": "function",
      }
    `)
  })
})
