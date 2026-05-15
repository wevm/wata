import { Ed25519, Hex, X25519 } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Crypto } from 'wata'

describe('randomKeypair', () => {
  test('returns 32-byte Ed25519 keypair plus derived X25519 keypair', () => {
    const keypair = Crypto.randomKeypair()
    expect(Hex.size(keypair.publicKey)).toMatchInlineSnapshot('32')
    expect(Hex.size(keypair.privateKey)).toMatchInlineSnapshot('32')
    expect(Hex.size(keypair.x25519.publicKey)).toMatchInlineSnapshot('32')
    expect(Hex.size(keypair.x25519.privateKey)).toMatchInlineSnapshot('32')
  })

  test('each call returns a fresh keypair', () => {
    const a = Crypto.randomKeypair()
    const b = Crypto.randomKeypair()
    expect(a.privateKey).not.toBe(b.privateKey)
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.x25519.privateKey).not.toBe(b.x25519.privateKey)
    expect(a.x25519.publicKey).not.toBe(b.x25519.publicKey)
  })

  test('derived X25519 public matches `Ed25519.toX25519PublicKey`', () => {
    const keypair = Crypto.randomKeypair()
    expect(keypair.x25519.publicKey).toBe(
      Ed25519.toX25519PublicKey({ publicKey: keypair.publicKey }),
    )
  })

  test('derived X25519 keypair performs valid ECDH with a fresh X25519 peer', () => {
    const self = Crypto.randomKeypair()
    const peer = Crypto.randomKeypair()
    const a = X25519.getSharedSecret({
      privateKey: self.x25519.privateKey,
      publicKey: peer.x25519.publicKey,
    })
    const b = X25519.getSharedSecret({
      privateKey: peer.x25519.privateKey,
      publicKey: self.x25519.publicKey,
    })
    expect(a).toBe(b)
  })
})

describe('toX25519', () => {
  test('public-only input returns { publicKey } and matches `Ed25519.toX25519PublicKey`', () => {
    const ed = Ed25519.createKeyPair()
    const result = Crypto.toX25519({ publicKey: ed.publicKey })
    expect(result.publicKey).toBe(Ed25519.toX25519PublicKey({ publicKey: ed.publicKey }))
    expect('privateKey' in result).toBe(false)
  })

  test('full keypair input returns matching X25519 keypair', () => {
    const ed = Ed25519.createKeyPair()
    const result = Crypto.toX25519({ publicKey: ed.publicKey, privateKey: ed.privateKey })
    expect(result.publicKey).toBe(Ed25519.toX25519PublicKey({ publicKey: ed.publicKey }))
    expect(result.privateKey).toBe(Ed25519.toX25519PrivateKey({ privateKey: ed.privateKey }))
  })
})
