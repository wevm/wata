import { Aead, Errors } from 'handshakes'
import { Hex } from 'ox'
import { describe, expect, test } from 'vp/test'

describe('OpenError', () => {
  test('has the Aead.OpenError name and inherits BaseError', () => {
    const error = new Aead.OpenError('decryption failed')
    expect(error.name).toMatchInlineSnapshot('"Aead.OpenError"')
    expect(error).toBeInstanceOf(Errors.BaseError)
    expect(error).toBeInstanceOf(Error)
  })
})

// RFC 8439 §2.8.2 test vector for ChaCha20-Poly1305 AEAD.
// https://datatracker.ietf.org/doc/html/rfc8439#section-2.8.2
const text =
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
const vector = {
  key: '0x808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
  nonce: '0x070000004041424344454647',
  aad: '0x50515253c0c1c2c3c4c5c6c7',
  plaintext: Hex.fromString(text),
  ciphertextWithTag:
    '0xd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b61161ae10b594f09e26a7e902ecbd0600691',
} as const

describe('seal', () => {
  test('RFC 8439 §2.8.2 vector', () => {
    const ciphertext = Aead.seal({
      key: vector.key,
      nonce: vector.nonce,
      aad: vector.aad,
      plaintext: vector.plaintext,
    })
    expect(ciphertext).toBe(vector.ciphertextWithTag)
  })

  test('without AAD', () => {
    const ciphertext = Aead.seal({
      key: vector.key,
      nonce: vector.nonce,
      plaintext: '0xdeadbeef',
    })
    expect(Hex.size(ciphertext)).toBe(4 + Aead.tagSize)
  })
})

describe('open', () => {
  test('RFC 8439 §2.8.2 vector', () => {
    const plaintext = Aead.open({
      key: vector.key,
      nonce: vector.nonce,
      aad: vector.aad,
      ciphertext: vector.ciphertextWithTag,
    })
    expect(Hex.toString(plaintext)).toBe(text)
  })

  test('throws AeadOpenError on tampered ciphertext', () => {
    // flip a bit in the middle of the ciphertext
    const tampered = (vector.ciphertextWithTag.slice(0, 10) +
      (vector.ciphertextWithTag[10] === '0' ? '1' : '0') +
      vector.ciphertextWithTag.slice(11)) as `0x${string}`
    expect(() =>
      Aead.open({ key: vector.key, nonce: vector.nonce, aad: vector.aad, ciphertext: tampered }),
    ).toThrowError(Aead.OpenError)
  })

  test('throws AeadOpenError on AAD mismatch', () => {
    expect(() =>
      Aead.open({
        key: vector.key,
        nonce: vector.nonce,
        aad: '0x00',
        ciphertext: vector.ciphertextWithTag,
      }),
    ).toThrowError(Aead.OpenError)
  })
})

describe('seal + open round trip', () => {
  test('preserves plaintext under matching key/nonce/aad', () => {
    const opts = {
      key: vector.key,
      nonce: vector.nonce,
      aad: '0xfeedface',
    } as const
    const ciphertext = Aead.seal({ ...opts, plaintext: '0xdeadbeefcafebabe' })
    const plaintext = Aead.open({ ...opts, ciphertext })
    expect(plaintext).toBe('0xdeadbeefcafebabe')
  })
})
