import { Envelope } from 'handshakes'
import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import type { z } from 'zod'

describe('schema.hex', () => {
  test('infers `0x${string}` (= Hex.Hex)', () => {
    type Out = z.output<typeof Envelope.schema.hex>
    expectTypeOf<Out>().toEqualTypeOf<`0x${string}`>()
    expectTypeOf<Out>().toEqualTypeOf<Hex.Hex>()
  })
})

describe('encrypted', () => {
  test('ciphertext is `0x${string}`', () => {
    const env = Envelope.encrypted({ counter: 0n, ciphertext: '0xdeadbeef' })
    expectTypeOf(env.ciphertext).toEqualTypeOf<Hex.Hex>()
    expectTypeOf(env.type).toEqualTypeOf<'encrypted'>()
    expectTypeOf(env.counter).toEqualTypeOf<string>()
  })
})

describe('plain', () => {
  test('payload is unknown, type is "plain" literal', () => {
    const env = Envelope.plain({ hello: 'world' })
    expectTypeOf(env.type).toEqualTypeOf<'plain'>()
    expectTypeOf(env.payload).toEqualTypeOf<unknown>()
  })
})

describe('parse', () => {
  test('returns the discriminated union', () => {
    const env = Envelope.parse({ type: 'plain', payload: null })
    expectTypeOf(env).toEqualTypeOf<Envelope.Envelope>()
    if (env.type === 'encrypted') {
      expectTypeOf(env.ciphertext).toEqualTypeOf<Hex.Hex>()
      expectTypeOf(env.counter).toEqualTypeOf<string>()
    } else {
      expectTypeOf(env.payload).toEqualTypeOf<unknown>()
    }
  })
})
