import { describe, expectTypeOf, test } from 'vp/test'
import { Rpc } from 'wata'

describe('request', () => {
  test('infers literal method and params', () => {
    const message = Rpc.request({ id: 1, method: 'ping', params: [] as const })
    expectTypeOf(message.method).toEqualTypeOf<'ping'>()
    expectTypeOf(message.params).toEqualTypeOf<readonly []>()
    expectTypeOf(message.jsonrpc).toEqualTypeOf<'2.0'>()
  })

  test('infers method literal even without `as const` on params', () => {
    const message = Rpc.request({ id: 1, method: 'eth_blockNumber', params: [] })
    expectTypeOf(message.method).toEqualTypeOf<'eth_blockNumber'>()
  })
})

describe('notification', () => {
  test('infers literal method', () => {
    const message = Rpc.notification({ method: 'progress', params: [42] })
    expectTypeOf(message.method).toEqualTypeOf<'progress'>()
    expectTypeOf(message.jsonrpc).toEqualTypeOf<'2.0'>()
  })
})

describe('success', () => {
  test('infers literal result type', () => {
    const message = Rpc.success({ id: 1, result: { ok: true } as const })
    expectTypeOf(message.result).toEqualTypeOf<{ readonly ok: true }>()
  })
})

describe('error', () => {
  test('infers literal data type', () => {
    const message = Rpc.error({ code: -1, data: { x: 1 } as const, id: 1, message: 'nope' })
    expectTypeOf(message.error.data).toEqualTypeOf<{ readonly x: 1 } | undefined>()
  })

  test('data is undefined when omitted', () => {
    const message = Rpc.error({ code: -1, id: 1, message: 'nope' })
    expectTypeOf(message.error.data).toEqualTypeOf<undefined>()
  })
})

describe('parse', () => {
  test('returns a discriminated union', () => {
    const message = Rpc.parse({ id: 1, jsonrpc: '2.0', method: 'ping', params: [] })
    expectTypeOf(message).toEqualTypeOf<Rpc.Envelope>()

    if ('error' in message) {
      expectTypeOf(message.error.code).toEqualTypeOf<number>()
    } else if ('result' in message) {
      expectTypeOf(message.result).toEqualTypeOf<unknown>()
    } else if ('id' in message) {
      expectTypeOf(message.method).toEqualTypeOf<string>()
    } else {
      expectTypeOf(message.method).toEqualTypeOf<string>()
    }
  })
})
