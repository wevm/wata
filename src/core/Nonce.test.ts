import { Errors, Nonce } from 'handshakes'
import { describe, expect, test } from 'vp/test'

describe('fromCounter', () => {
  test('encodes 0 as 12 zero bytes', () => {
    expect(Nonce.fromCounter(0n)).toMatchInlineSnapshot('"0x000000000000000000000000"')
  })

  test('encodes 1 with last byte set', () => {
    expect(Nonce.fromCounter(1n)).toMatchInlineSnapshot('"0x000000000000000000000001"')
  })

  test('encodes a large counter big-endian', () => {
    expect(Nonce.fromCounter(0xdeadbeefn)).toMatchInlineSnapshot(
      '"0x0000000000000000deadbeef"',
    )
  })

  test('rejects negative counters', () => {
    expect(() => Nonce.fromCounter(-1n)).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: counter must be non-negative]',
    )
  })

  test('rejects counters past the 96-bit ceiling', () => {
    expect(() => Nonce.fromCounter(Nonce.max + 1n)).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: counter exceeds 96-bit nonce space]',
    )
  })
})

describe('toCounter', () => {
  test('round trips a non-zero counter', () => {
    expect(Nonce.toCounter(Nonce.fromCounter(0xcafebaben))).toMatchInlineSnapshot('3405691582n')
  })

  test('rejects nonces shorter than 12 bytes', () => {
    expect(() => Nonce.toCounter('0xdead')).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: nonce must be exactly 12 bytes
      Details: received 2 bytes]
    `,
    )
  })

  test('rejects nonces longer than 12 bytes', () => {
    expect(() =>
      Nonce.toCounter('0x000000000000000000000000ff'),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: nonce must be exactly 12 bytes
      Details: received 13 bytes]
    `,
    )
  })
})

describe('encoder', () => {
  test('emits monotonically increasing nonces from 0', () => {
    const out = Nonce.encoder()
    expect(out.next()).toMatchInlineSnapshot('"0x000000000000000000000000"')
    expect(out.next()).toMatchInlineSnapshot('"0x000000000000000000000001"')
    expect(out.next()).toMatchInlineSnapshot('"0x000000000000000000000002"')
    expect(out.counter).toMatchInlineSnapshot('3n')
  })

  test('starts from a custom counter', () => {
    const out = Nonce.encoder({ start: 100n })
    expect(out.next()).toMatchInlineSnapshot('"0x000000000000000000000064"')
    expect(out.counter).toMatchInlineSnapshot('101n')
  })

  test('throws when the counter overflows past max', () => {
    const out = Nonce.encoder({ start: Nonce.max })
    out.next()
    expect(() => out.next()).toThrowError(Errors.ProtocolError)
  })
})

describe('decoder', () => {
  test('accepts nonces in strict monotonic order', () => {
    const dec = Nonce.decoder()
    expect(() => dec.accept(Nonce.fromCounter(0n))).not.toThrow()
    expect(() => dec.accept(Nonce.fromCounter(1n))).not.toThrow()
    expect(() => dec.accept(Nonce.fromCounter(2n))).not.toThrow()
    expect(dec.next).toMatchInlineSnapshot('3n')
  })

  test('rejects a replayed nonce', () => {
    const dec = Nonce.decoder()
    dec.accept(Nonce.fromCounter(0n))
    expect(() => dec.accept(Nonce.fromCounter(0n))).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: nonce out of order
      Details: expected counter=1, received counter=0]
    `,
    )
  })

  test('rejects a forward jump (skipped counter)', () => {
    const dec = Nonce.decoder()
    expect(() => dec.accept(Nonce.fromCounter(2n))).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: nonce out of order
      Details: expected counter=0, received counter=2]
    `,
    )
  })

  test('rejects a backwards-going nonce', () => {
    const dec = Nonce.decoder()
    dec.accept(Nonce.fromCounter(0n))
    dec.accept(Nonce.fromCounter(1n))
    expect(() => dec.accept(Nonce.fromCounter(0n))).toThrowError(Errors.ProtocolError)
  })

  test('starts from a custom counter', () => {
    const dec = Nonce.decoder({ start: 5n })
    expect(() => dec.accept(Nonce.fromCounter(5n))).not.toThrow()
    expect(dec.next).toMatchInlineSnapshot('6n')
  })
})
