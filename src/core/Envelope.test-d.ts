import { Envelope, Rpc } from 'handshakes'
import { describe, expectTypeOf, test } from 'vp/test'

describe('rpcRequests', () => {
  test('returns the `rpc-requests` variant', () => {
    const env = Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })])
    expectTypeOf(env.type).toEqualTypeOf<'rpc-requests'>()
    expectTypeOf(env.payload).toBeArray()
  })
})

describe('rpcResponses', () => {
  test('returns the `rpc-responses` variant', () => {
    const env = Envelope.rpcResponses([Rpc.success({ id: 1, result: null })])
    expectTypeOf(env.type).toEqualTypeOf<'rpc-responses'>()
    expectTypeOf(env.payload).toBeArray()
  })
})

describe('ready / hello', () => {
  test('default to `{}` payload', () => {
    expectTypeOf(Envelope.ready().type).toEqualTypeOf<'ready'>()
    expectTypeOf(Envelope.hello().type).toEqualTypeOf<'hello'>()
  })
})

describe('encrypted', () => {
  test('payload carries `v`, `from`, `nonce`, `ct`', () => {
    const env = Envelope.encrypted({
      from: Envelope.from.consumer,
      nonce: '0x000000000000000000000001',
      ciphertext: '0xdeadbeef',
    })
    expectTypeOf(env.type).toEqualTypeOf<'encrypted'>()
    expectTypeOf(env.payload.v).toEqualTypeOf<1>()
    expectTypeOf(env.payload.from).toEqualTypeOf<'consumer' | 'host'>()
    expectTypeOf(env.payload.nonce).toBeString()
    expectTypeOf(env.payload.ct).toBeString()
  })
})

describe('parse', () => {
  test('returns the discriminated `Envelope` union', () => {
    const env = Envelope.parse({
      type: 'ready',
      payload: {},
    })
    expectTypeOf(env).toEqualTypeOf<Envelope.Envelope>()
  })
})
