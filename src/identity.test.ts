import { Bytes, Ed25519 } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Crypto, Identity } from 'wata'

describe('fromPrivateKey', () => {
  test('exposes the Ed25519 public key as unpadded base64url', () => {
    const keypair = Crypto.randomKeypair()
    const identity = Identity.fromPrivateKey(keypair.privateKey)
    expect(identity.publicKey).toBe(Crypto.encodePublicKey(keypair.publicKey))
  })

  test('sign returns a 64-byte signature that verifies under the public key', () => {
    const keypair = Crypto.randomKeypair()
    const identity = Identity.fromPrivateKey(keypair.privateKey)
    const payload = Bytes.fromString('urpc/mobile-host-identity/v1')
    const signature = identity.sign(payload)
    expect(signature.length).toBe(64)
    expect(Ed25519.verify({ payload, publicKey: keypair.publicKey, signature })).toBe(true)
  })
})
