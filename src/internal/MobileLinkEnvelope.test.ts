import { describe, expect, test } from 'vp/test'
import { Crypto, Envelope, Identity, Nonce, Session } from 'wata'

import * as MobileLinkEnvelope from './MobileLinkEnvelope.js'

const consumer = Crypto.randomKeypair()
const host = Crypto.randomKeypair()
const identity = Crypto.randomKeypair()

const shared = Session.shared({
  privateKey: consumer.x25519.privateKey,
  publicKey: host.x25519.publicKey,
})

describe('identityMessage', () => {
  test('is 124 bytes (28 label + 32 + 32 + 32)', () => {
    const message = MobileLinkEnvelope.identityMessage({
      publicKeyConsumer: consumer.x25519.publicKey,
      publicKeyHost: host.x25519.publicKey,
      shared,
    })
    expect(message.length).toBe(124)
  })
})

describe('signIdentity', () => {
  test('round-trips against verifyIdentity', () => {
    const signature = MobileLinkEnvelope.signIdentity({
      identity: Identity.fromPrivateKey(identity.privateKey),
      publicKeyConsumer: consumer.x25519.publicKey,
      publicKeyHost: host.x25519.publicKey,
      shared,
    })
    expect(signature.length).toBe(64)
    expect(
      MobileLinkEnvelope.verifyIdentity({
        identityPublicKey: identity.publicKey,
        publicKeyConsumer: consumer.x25519.publicKey,
        publicKeyHost: host.x25519.publicKey,
        shared,
        signature,
      }),
    ).toBe(true)
  })

  test('rejects a tampered shared secret', () => {
    const signature = MobileLinkEnvelope.signIdentity({
      identity: Identity.fromPrivateKey(identity.privateKey),
      publicKeyConsumer: consumer.x25519.publicKey,
      publicKeyHost: host.x25519.publicKey,
      shared,
    })
    expect(
      MobileLinkEnvelope.verifyIdentity({
        identityPublicKey: identity.publicKey,
        publicKeyConsumer: consumer.x25519.publicKey,
        publicKeyHost: host.x25519.publicKey,
        shared: `0x${'00'.repeat(32)}`,
        signature,
      }),
    ).toBe(false)
  })

  test('rejects a different identity key', () => {
    const signature = MobileLinkEnvelope.signIdentity({
      identity: Identity.fromPrivateKey(identity.privateKey),
      publicKeyConsumer: consumer.x25519.publicKey,
      publicKeyHost: host.x25519.publicKey,
      shared,
    })
    expect(
      MobileLinkEnvelope.verifyIdentity({
        identityPublicKey: Crypto.randomKeypair().publicKey,
        publicKeyConsumer: consumer.x25519.publicKey,
        publicKeyHost: host.x25519.publicKey,
        shared,
        signature,
      }),
    ).toBe(false)
  })
})

describe('seal', () => {
  test('host→consumer round-trips through open', () => {
    const keys = MobileLinkEnvelope.deriveKeys({
      identityPublicKey: identity.publicKey,
      peerPublicKey: consumer.x25519.publicKey,
      role: 'host',
      self: host.x25519,
    })
    const response = Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'pong' }])
    const sealed = MobileLinkEnvelope.seal({
      envelope: response,
      from: 'host',
      key: keys.h2c,
      nonce: Nonce.fromCounter(1n),
      publicKeyConsumer: consumer.x25519.publicKey,
    })
    expect(sealed.type).toBe('encrypted')

    const consumerKeys = MobileLinkEnvelope.deriveKeys({
      identityPublicKey: identity.publicKey,
      peerPublicKey: host.x25519.publicKey,
      role: 'consumer',
      self: consumer.x25519,
    })
    const opened = MobileLinkEnvelope.open({
      encrypted: sealed as Extract<Envelope.Envelope, { type: 'encrypted' }>,
      key: consumerKeys.h2c,
      publicKeyConsumer: consumer.x25519.publicKey,
    })
    expect(opened).toEqual(response)
  })

  test('open fails under the wrong identity context', () => {
    const keys = MobileLinkEnvelope.deriveKeys({
      identityPublicKey: identity.publicKey,
      peerPublicKey: consumer.x25519.publicKey,
      role: 'host',
      self: host.x25519,
    })
    const sealed = MobileLinkEnvelope.seal({
      envelope: Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'pong' }]),
      from: 'host',
      key: keys.h2c,
      nonce: Nonce.fromCounter(1n),
      publicKeyConsumer: consumer.x25519.publicKey,
    })
    const wrongKeys = MobileLinkEnvelope.deriveKeys({
      identityPublicKey: Crypto.randomKeypair().publicKey,
      peerPublicKey: host.x25519.publicKey,
      role: 'consumer',
      self: consumer.x25519,
    })
    expect(() =>
      MobileLinkEnvelope.open({
        encrypted: sealed as Extract<Envelope.Envelope, { type: 'encrypted' }>,
        key: wrongKeys.h2c,
        publicKeyConsumer: consumer.x25519.publicKey,
      }),
    ).toThrow()
  })
})
