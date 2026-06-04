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
const schema = Schema.create({ methods: { eth_sign: ethSign, ping } })
const fallback = Schema.method({
  params: z.tuple([z.string()]),
  result: z.number(),
})

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
        "eth_sign",
        "ping",
      ]
    `)
  })
})

describe('rpc', () => {
  test('returns an open schema with a generic JSON-RPC fallback', () => {
    const open_schema = Schema.rpc()

    expect({
      fallback: Boolean(open_schema.fallback),
      methods: Object.keys(open_schema.methods),
      params: Schema.validate(open_schema.fallback.params, [{ ok: true }]),
      result: Schema.validate(open_schema.fallback.result, { ok: true }),
    }).toMatchInlineSnapshot(`
      {
        "fallback": true,
        "methods": [],
        "params": [
          {
            "ok": true,
          },
        ],
        "result": {
          "ok": true,
        },
      }
    `)
  })
})

describe('extend', () => {
  test('overlays extension methods onto the base schema', () => {
    const extended = Schema.extend(schema, {
      methods: {
        ping: fallback,
      },
    })

    expect({
      keys: Object.keys(extended.methods),
      params: Schema.validate(extended.methods.ping.params, ['ok']),
      result: Schema.validate(extended.methods.ping.result, 1),
    }).toMatchInlineSnapshot(`
      {
        "keys": [
          "eth_sign",
          "ping",
        ],
        "params": [
          "ok",
        ],
        "result": 1,
      }
    `)
  })

  test('preserves the base fallback unless the extension supplies one', () => {
    const extended = Schema.extend(Schema.rpc(), { methods: { ping } })
    const overridden = Schema.extend(extended, { fallback, methods: {} })

    expect({
      overridden: Schema.validate(overridden.fallback.params, ['ok']),
      preserved: Schema.validate(extended.fallback.params, []),
    }).toMatchInlineSnapshot(`
      {
        "overridden": [
          "ok",
        ],
        "preserved": [],
      }
    `)
  })
})

describe('definition', () => {
  test('returns known definitions before falling back', () => {
    const extended = Schema.extend(Schema.rpc(), { methods: { ping } })

    expect({
      fallback: Schema.definition(extended, 'wallet_connect') === extended.fallback,
      known: Schema.definition(extended, 'ping') === ping,
    }).toMatchInlineSnapshot(`
      {
        "fallback": true,
        "known": true,
      }
    `)
  })

  test('returns undefined for unknown closed-schema methods', () => {
    expect(Schema.definition(schema, 'wallet_connect')).toMatchInlineSnapshot(`undefined`)
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
