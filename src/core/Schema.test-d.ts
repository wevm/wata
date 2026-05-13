import { Schema } from 'handshakes'
import { describe, expectTypeOf, test } from 'vp/test'
import { z } from 'zod'

const schema = Schema.create({
  methods: {
    ping: Schema.method({
      params: z.tuple([]),
      result: z.object({ ok: z.literal(true) }),
    }),
    eth_sign: Schema.method({
      params: z.tuple([z.string(), z.string()]),
      result: z.string(),
    }),
  },
})

describe('create', () => {
  test('preserves the literal method-name keys', () => {
    expectTypeOf<Schema.MethodName<typeof schema>>().toEqualTypeOf<'ping' | 'eth_sign'>()
  })
})

describe('Inferred', () => {
  test('flows z.output through the indirection', () => {
    type Out = Schema.Inferred<(typeof schema)['methods']['ping']['result']>
    expectTypeOf<Out>().toEqualTypeOf<{ ok: true }>()
  })
})

describe('ParamsOf', () => {
  test('infers a tuple params type', () => {
    expectTypeOf<Schema.ParamsOf<typeof schema, 'eth_sign'>>().toEqualTypeOf<[string, string]>()
  })

  test('infers an empty-tuple params type', () => {
    expectTypeOf<Schema.ParamsOf<typeof schema, 'ping'>>().toEqualTypeOf<[]>()
  })

  test('rejects unknown methods', () => {
    // @ts-expect-error 'nope' is not in the registry
    type _ = Schema.ParamsOf<typeof schema, 'nope'>
  })
})

describe('ResultOf', () => {
  test('infers an object result type', () => {
    expectTypeOf<Schema.ResultOf<typeof schema, 'ping'>>().toEqualTypeOf<{ ok: true }>()
  })

  test('infers a string result type', () => {
    expectTypeOf<Schema.ResultOf<typeof schema, 'eth_sign'>>().toEqualTypeOf<string>()
  })
})

describe('validate', () => {
  test('narrows the return type to the inferred output', () => {
    const out = Schema.validate(schema.methods.ping.result, { ok: true })
    expectTypeOf(out).toEqualTypeOf<{ ok: true }>()
  })
})
