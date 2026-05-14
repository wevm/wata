import { Crypto, Errors, Kdf, Session } from 'handshakes'
import { Bytes, Hex } from 'ox'
import { describe, expect, test } from 'vp/test'

describe('shared', () => {
  test('two peers compute the same secret (X25519 ECDH)', () => {
    const a = Crypto.randomKeypair()
    const b = Crypto.randomKeypair()
    const ab = Session.shared({
      privateKey: a.x25519.privateKey,
      publicKey: b.x25519.publicKey,
    })
    const ba = Session.shared({
      privateKey: b.x25519.privateKey,
      publicKey: a.x25519.publicKey,
    })
    expect(ab).toBe(ba)
    expect(Hex.size(ab)).toBe(32)
  })

  test('rejects an all-zero / low-order peer key with ProtocolError', () => {
    const self = Crypto.randomKeypair()
    expect(() =>
      Session.shared({
        privateKey: self.x25519.privateKey,
        publicKey: `0x${'00'.repeat(32)}`,
      }),
    ).toThrowError(Errors.ProtocolError)
  })
})

describe('buildInfo', () => {
  test('layout = "urpc/v1/" || transport_id || "/" || direction || pubkey_host || transport_context', () => {
    const publicKey_host = `0x${'aa'.repeat(32)}` as const
    const transportContext = '0xdeadbeef' as const
    const info = Session.buildInfo({
      transportId: 'relay',
      direction: Session.direction.c2h,
      publicKey_host,
      transportContext,
    })
    const expected =
      Hex.fromBytes(new TextEncoder().encode('urpc/v1/relay/c2h')).slice(2) +
      'aa'.repeat(32) +
      'deadbeef'
    expect(info).toBe(`0x${expected}`)
  })

  test('omits transport_context when undefined', () => {
    const publicKey_host = `0x${'bb'.repeat(32)}` as const
    const info = Session.buildInfo({
      transportId: 'mobile-link',
      direction: Session.direction.h2c,
      publicKey_host,
    })
    expect(Hex.size(info)).toBe('urpc/v1/mobile-link/h2c'.length + 32)
  })
})

describe('derive', () => {
  test('both peers derive identical { c2h, h2c } pair', () => {
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()

    const fromConsumer = Session.derive({
      role: 'consumer',
      self: consumer.x25519,
      peer: { publicKey: host.x25519.publicKey },
      transportId: 'relay',
      transportContext: '0x1234',
    })
    const fromHost = Session.derive({
      role: 'host',
      self: host.x25519,
      peer: { publicKey: consumer.x25519.publicKey },
      transportId: 'relay',
      transportContext: '0x1234',
    })

    expect(fromConsumer.c2h).toBe(fromHost.c2h)
    expect(fromConsumer.h2c).toBe(fromHost.h2c)
    expect(fromConsumer.c2h).not.toBe(fromConsumer.h2c)
    expect(Hex.size(fromConsumer.c2h)).toBe(32)
    expect(Hex.size(fromConsumer.h2c)).toBe(32)
  })

  test('different `transportContext` values produce different keys', () => {
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()

    const a = Session.derive({
      role: 'consumer',
      self: consumer.x25519,
      peer: { publicKey: host.x25519.publicKey },
      transportId: 'relay',
      transportContext: '0xaaaa',
    })
    const b = Session.derive({
      role: 'consumer',
      self: consumer.x25519,
      peer: { publicKey: host.x25519.publicKey },
      transportId: 'relay',
      transportContext: '0xbbbb',
    })

    expect(a.c2h).not.toBe(b.c2h)
    expect(a.h2c).not.toBe(b.h2c)
  })

  test('different `transportId` values produce different keys', () => {
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()

    const a = Session.derive({
      role: 'consumer',
      self: consumer.x25519,
      peer: { publicKey: host.x25519.publicKey },
      transportId: 'relay',
    })
    const b = Session.derive({
      role: 'consumer',
      self: consumer.x25519,
      peer: { publicKey: host.x25519.publicKey },
      transportId: 'mobile-link',
    })

    expect(a.c2h).not.toBe(b.c2h)
    expect(a.h2c).not.toBe(b.h2c)
  })

  test('matches a hand-computed HKDF-SHA256 round-trip for c2h', () => {
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()
    const sharedSecret = Session.shared({
      privateKey: consumer.x25519.privateKey,
      publicKey: host.x25519.publicKey,
    })
    const expected = Kdf.derive({
      ikm: sharedSecret,
      salt: consumer.x25519.publicKey,
      info: Session.buildInfo({
        transportId: 'relay',
        direction: Session.direction.c2h,
        publicKey_host: host.x25519.publicKey,
        transportContext: '0xfeedface',
      }),
      length: Session.keySize,
    })
    const derived = Session.derive({
      role: 'consumer',
      self: consumer.x25519,
      peer: { publicKey: host.x25519.publicKey },
      transportId: 'relay',
      transportContext: '0xfeedface',
    })
    expect(derived.c2h).toBe(expected)
  })

  test('accepts `Bytes.Bytes` inputs alongside hex', () => {
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()
    const fromHex = Session.derive({
      role: 'consumer',
      self: consumer.x25519,
      peer: { publicKey: host.x25519.publicKey },
      transportId: 'relay',
    })
    const fromBytes = Session.derive({
      role: 'consumer',
      self: {
        publicKey: Bytes.from(consumer.x25519.publicKey),
        privateKey: Bytes.from(consumer.x25519.privateKey),
      },
      peer: { publicKey: Bytes.from(host.x25519.publicKey) },
      transportId: 'relay',
    })
    expect(fromHex.c2h).toBe(fromBytes.c2h)
    expect(fromHex.h2c).toBe(fromBytes.h2c)
  })
})
