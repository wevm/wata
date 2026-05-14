import { Aad, Errors } from 'handshakes'
import { describe, expect, test } from 'vp/test'

const publicKey = '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff' as const

describe('encode', () => {
  test('encodes a consumer-originated AAD', () => {
    expect(Aad.encode({ publicKey, role: Aad.role.consumer })).toMatchInlineSnapshot(
      '"0x74656d706f63702f763100112233445566778899aabbccddeeff00112233445566778899aabbccddeeff01"',
    )
  })

  test('encodes a host-originated AAD', () => {
    expect(Aad.encode({ publicKey, role: Aad.role.host })).toMatchInlineSnapshot(
      '"0x74656d706f63702f763100112233445566778899aabbccddeeff00112233445566778899aabbccddeeff02"',
    )
  })

  test('always returns 43 bytes', () => {
    const aad = Aad.encode({ publicKey, role: Aad.role.consumer })
    expect(aad.length / 2 - 1).toBe(Aad.size)
  })

  test('always begins with the ASCII `tempocp/v1` prefix', () => {
    const aad = Aad.encode({ publicKey, role: Aad.role.host })
    // 10-byte ASCII "tempocp/v1" → hex "74656d706f63702f7631"
    expect(aad.slice(2, 2 + Aad.prefixSize * 2)).toBe('74656d706f63702f7631')
  })

  test('rejects a publicKey that is not 32 bytes', () => {
    expect(() =>
      Aad.encode({ publicKey: '0xdead', role: Aad.role.consumer }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: publicKey must be 32 bytes
      Details: received 2 bytes]
    `,
    )
  })
})

describe('decode', () => {
  test('round-trips a consumer-originated AAD', () => {
    const aad = Aad.encode({ publicKey, role: Aad.role.consumer })
    expect(Aad.decode(aad)).toMatchInlineSnapshot(`
      {
        "publicKey": "0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        "role": 1,
      }
    `)
  })

  test('round-trips a host-originated AAD', () => {
    const aad = Aad.encode({ publicKey, role: Aad.role.host })
    expect(Aad.decode(aad)).toMatchInlineSnapshot(`
      {
        "publicKey": "0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        "role": 2,
      }
    `)
  })

  test('rejects a wrong-length AAD', () => {
    expect(() => Aad.decode('0xdead')).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: aad must be exactly 43 bytes
      Details: received 2 bytes]
    `,
    )
  })

  test('rejects a wrong AAD version prefix', () => {
    // Mutate the first prefix byte (`t` → `T`).
    const aad = ('0x54' +
      '656d706f63702f7631' +
      publicKey.slice(2) +
      '01') as `0x${string}`
    expect(() => Aad.decode(aad)).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: aad version prefix mismatch
      Details: expected "tempocp/v1"]
    `,
    )
  })

  test('rejects an invalid role byte', () => {
    const aad = ('0x74656d706f63702f7631' +
      publicKey.slice(2) +
      '03') as `0x${string}`
    expect(() => Aad.decode(aad)).toThrowError(Errors.ProtocolError)
  })
})
