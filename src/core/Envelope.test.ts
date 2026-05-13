import { Envelope, Errors } from 'handshakes'
import { describe, expect, test } from 'vp/test'

describe('plain', () => {
  test('wraps a payload as { type: "plain" }', () => {
    expect(Envelope.plain({ method: 'ping', params: [] })).toMatchInlineSnapshot(`
      {
        "payload": {
          "method": "ping",
          "params": [],
        },
        "type": "plain",
      }
    `)
  })
})

describe('encrypted', () => {
  test('serializes counter as a decimal string', () => {
    expect(
      Envelope.encrypted({ counter: 12345n, ciphertext: '0xdeadbeef' }),
    ).toMatchInlineSnapshot(`
      {
        "ciphertext": "0xdeadbeef",
        "counter": "12345",
        "type": "encrypted",
      }
    `)
  })

  test('handles 96-bit counter without precision loss', () => {
    const counter = (1n << 95n) + 7n
    const env = Envelope.encrypted({ counter, ciphertext: '0xff' })
    expect(env.counter).toMatchInlineSnapshot('"39614081257132168796771975175"')
    expect(Envelope.counterOf(env)).toBe(counter)
  })
})

describe('parse', () => {
  test('round trips a plain envelope', () => {
    const env = Envelope.plain({ ok: true })
    expect(Envelope.parse(JSON.parse(JSON.stringify(env)))).toMatchInlineSnapshot(`
      {
        "payload": {
          "ok": true,
        },
        "type": "plain",
      }
    `)
  })

  test('round trips an encrypted envelope', () => {
    const env = Envelope.encrypted({ counter: 0n, ciphertext: '0xdeadbeef' })
    expect(Envelope.parse(JSON.parse(JSON.stringify(env)))).toMatchInlineSnapshot(`
      {
        "ciphertext": "0xdeadbeef",
        "counter": "0",
        "type": "encrypted",
      }
    `)
  })

  test('rejects an unknown type', () => {
    expect(() =>
      Envelope.parse({ type: 'bogus', payload: 1 }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: invalid envelope
      Details: Invalid discriminator value. Expected 'plain' | 'encrypted']
    `,
    )
  })

  test('rejects encrypted envelope with non-decimal counter', () => {
    expect(() =>
      Envelope.parse({ type: 'encrypted', counter: 'abc', ciphertext: '0xff' }),
    ).toThrowError(Errors.ProtocolError)
  })

  test('rejects encrypted envelope with non-hex ciphertext', () => {
    expect(() =>
      Envelope.parse({ type: 'encrypted', counter: '0', ciphertext: 'nope' }),
    ).toThrowError(Errors.ProtocolError)
  })
})

describe('counterOf', () => {
  test('parses the counter string into a bigint', () => {
    const env = Envelope.encrypted({ counter: 99n, ciphertext: '0x' })
    expect(Envelope.counterOf(env)).toBe(99n)
  })
})
