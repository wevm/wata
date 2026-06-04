import { describe, expectTypeOf, test } from 'vp/test'
import { Rpc, Schema } from 'wata'
import { z } from 'zod/mini'

const schema = Schema.create({
  methods: {
    eth_sign: Schema.method({
      params: z.tuple([z.string(), z.string()]),
      result: z.string(),
    }),
    ping: Schema.method({
      params: z.tuple([]),
      result: z.object({ ok: z.literal(true) }),
    }),
  },
})
const fallback = Schema.method({
  params: z.tuple([z.string()]),
  result: z.number(),
})
const open_schema = Schema.extend(Schema.rpc(), { methods: schema.methods })
const overridden_schema = Schema.extend(open_schema, { fallback, methods: {} })

describe('create', () => {
  test('preserves the literal method-name keys', () => {
    expectTypeOf<Schema.MethodName<typeof schema>>().toEqualTypeOf<'ping' | 'eth_sign'>()
    expectTypeOf<Schema.KnownMethodName<typeof schema>>().toEqualTypeOf<'ping' | 'eth_sign'>()
  })
})

describe('rpc', () => {
  test('accepts arbitrary method names through the fallback', () => {
    expectTypeOf<Schema.MethodName<typeof open_schema>>().toEqualTypeOf<string>()
    expectTypeOf<Schema.KnownMethodName<typeof open_schema>>().toEqualTypeOf<'ping' | 'eth_sign'>()
    expectTypeOf<Schema.ParamsOf<typeof open_schema, 'wallet_connect'>>().toEqualTypeOf<
      z.output<typeof Rpc.schema.params>
    >()
    expectTypeOf<Schema.ResultOf<typeof open_schema, 'wallet_connect'>>().toEqualTypeOf<unknown>()
  })

  test('keeps precise known-method inference', () => {
    expectTypeOf<Schema.ParamsOf<typeof open_schema, 'ping'>>().toEqualTypeOf<[]>()
    expectTypeOf<Schema.ResultOf<typeof open_schema, 'eth_sign'>>().toEqualTypeOf<string>()
  })
})

describe('extend', () => {
  test('uses extension methods over base methods', () => {
    const extended = Schema.extend(schema, { methods: { ping: fallback } })

    expectTypeOf<Schema.ParamsOf<typeof extended, 'ping'>>().toEqualTypeOf<[string]>()
    expectTypeOf<Schema.ResultOf<typeof extended, 'ping'>>().toEqualTypeOf<number>()
  })

  test('allows extensions to override the fallback', () => {
    expectTypeOf<Schema.ParamsOf<typeof overridden_schema, 'wallet_connect'>>().toEqualTypeOf<
      [string]
    >()
    expectTypeOf<
      Schema.ResultOf<typeof overridden_schema, 'wallet_connect'>
    >().toEqualTypeOf<number>()
  })
})

describe('definition', () => {
  test('returns exact known and fallback definitions', () => {
    const known = Schema.definition(open_schema, 'ping')
    const fallback = Schema.definition(open_schema, 'wallet_connect')
    const dynamic = Schema.definition(schema, '' as string)

    expectTypeOf(known).toEqualTypeOf<(typeof schema)['methods']['ping']>()
    expectTypeOf(fallback).toEqualTypeOf<(typeof open_schema)['fallback']>()
    expectTypeOf(dynamic).toEqualTypeOf<Schema.Method | undefined>()
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
