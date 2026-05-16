import { describe, expect, test } from 'vp/test'
import { Errors, Schema } from 'wata'
import { z } from 'zod/mini'

const ping = Schema.method({
  params: z.tuple([]),
  result: z.object({ ok: z.literal(true) }),
})
const ethSign = Schema.method({
  params: z.tuple([z.string(), z.string()]),
  result: z.string(),
})
const schema = Schema.create({ methods: { ping, eth_sign: ethSign } })

describe('method', () => {
  test('returns the params/result pair as-is', () => {
    expect(ping.params).toBe(ping.params)
    expect(ping.result).toBe(ping.result)
  })
})

describe('create', () => {
  test('returns the methods registry as a typed schema', () => {
    expect(Object.keys(schema.methods)).toMatchInlineSnapshot(`
      [
        "ping",
        "eth_sign",
      ]
    `)
  })
})

describe('validate', () => {
  test('returns parsed value on success', () => {
    expect(Schema.validate(ping.result, { ok: true })).toMatchInlineSnapshot(`
      {
        "ok": true,
      }
    `)
  })

  test('returns parsed tuple params on success', () => {
    expect(Schema.validate(ethSign.params, ['0x1', '0xff'])).toMatchInlineSnapshot(`
      [
        "0x1",
        "0xff",
      ]
    `)
  })

  test('throws ProtocolError on shape mismatch', () => {
    expect(() => Schema.validate(ping.result, { ok: false })).toThrowErrorMatchingInlineSnapshot(
      `
    	[ProtocolError: schema validation failed
    	Details: ok: Invalid input]
    `,
    )
  })

  test('throws ProtocolError on missing field', () => {
    expect(() => Schema.validate(ping.result, {})).toThrowError(Errors.ProtocolError)
  })

  test('throws ProtocolError on wrong tuple arity', () => {
    expect(() => Schema.validate(ethSign.params, ['0x1'])).toThrowError(Errors.ProtocolError)
  })
})
