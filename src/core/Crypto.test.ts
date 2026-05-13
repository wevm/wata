import { Crypto } from 'handshakes'
import { Hex } from 'ox'
import { describe, expect, test } from 'vp/test'

describe('randomKeypair', () => {
  test('returns 32-byte hex publicKey and privateKey', () => {
    const { publicKey, privateKey } = Crypto.randomKeypair()
    expect(Hex.size(publicKey)).toMatchInlineSnapshot('32')
    expect(Hex.size(privateKey)).toMatchInlineSnapshot('32')
  })

  test('each call returns a fresh keypair', () => {
    const a = Crypto.randomKeypair()
    const b = Crypto.randomKeypair()
    expect(a.privateKey).not.toBe(b.privateKey)
    expect(a.publicKey).not.toBe(b.publicKey)
  })
})
