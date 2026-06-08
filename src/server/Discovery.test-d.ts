import { describe, expectTypeOf, test } from 'vp/test'
import { hostWellknown, consumerWellknown } from 'wata/server'

describe('hostWellknown', () => {
  test('returns `{ fetch }`', () => {
    const server = hostWellknown({
      meta: { name: 'X' },
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    expectTypeOf(server.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
  })
})

describe('consumerWellknown', () => {
  test('returns `{ fetch }`', () => {
    const server = consumerWellknown({ meta: { name: 'Y' } })
    expectTypeOf(server.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
  })
})
