import { Aad, Errors } from 'handshakes'
import { describe, expect, test } from 'vp/test'

const sessionId = '0x00112233445566778899aabbccddeeff'

describe('encode', () => {
  test('encodes consumer→host counter=0', () => {
    expect(
      Aad.encode({ sessionId, direction: Aad.direction.c2h, counter: 0n }),
    ).toMatchInlineSnapshot('"0x010000112233445566778899aabbccddeeff000000000000000000000000"')
  })

  test('encodes host→consumer counter=1', () => {
    expect(
      Aad.encode({ sessionId, direction: Aad.direction.h2c, counter: 1n }),
    ).toMatchInlineSnapshot('"0x010100112233445566778899aabbccddeeff000000000000000000000001"')
  })

  test('always returns 30 bytes', () => {
    const aad = Aad.encode({ sessionId, direction: Aad.direction.c2h, counter: 42n })
    expect(aad.length / 2 - 1).toBe(Aad.size)
  })

  test('rejects a sessionId that is not 16 bytes', () => {
    expect(() =>
      Aad.encode({ sessionId: '0xdead', direction: Aad.direction.c2h, counter: 0n }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: sessionId must be 16 bytes
      Details: received 2 bytes]
    `,
    )
  })
})

describe('decode', () => {
  test('round-trips an encoded record', () => {
    const aad = Aad.encode({ sessionId, direction: Aad.direction.h2c, counter: 0xcafen })
    expect(Aad.decode(aad)).toMatchInlineSnapshot(`
      {
        "counter": 51966n,
        "direction": 1,
        "sessionId": "0x00112233445566778899aabbccddeeff",
      }
    `)
  })

  test('rejects a wrong-length AAD', () => {
    expect(() => Aad.decode('0xdead')).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: aad must be exactly 30 bytes
      Details: received 2 bytes]
    `,
    )
  })

  test('rejects a wrong AAD version byte', () => {
    // version = 0x02 (we're at 0x01), rest stays valid 30-byte length
    const aad = ('0x02' +
      '00' +
      sessionId.slice(2) +
      '000000000000000000000000') as `0x${string}`
    expect(() => Aad.decode(aad)).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: aad version mismatch
      Details: expected 1, received 2]
    `,
    )
  })

  test('rejects an invalid direction byte', () => {
    const aad = ('0x01' +
      '02' +
      sessionId.slice(2) +
      '000000000000000000000000') as `0x${string}`
    expect(() => Aad.decode(aad)).toThrowError(Errors.ProtocolError)
  })
})
