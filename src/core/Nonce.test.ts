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
    expect(Nonce.fromCounter(0xdeadbeefn)).toMatchInlineSnapshot('"0x0000000000000000deadbeef"')
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
  test('default-emits 0x00…01 first (pre-incremented per spec §6)', () => {
    const out = Nonce.encoder()
    expect(out.next()).toMatchInlineSnapshot('"0x000000000000000000000001"')
    expect(out.next()).toMatchInlineSnapshot('"0x000000000000000000000002"')
    expect(out.next()).toMatchInlineSnapshot('"0x000000000000000000000003"')
    expect(out.counter).toMatchInlineSnapshot('4n')
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
  test('accepts strictly-increasing counters', () => {
    const dec = Nonce.decoder()
    expect(() => dec.accept(Nonce.fromCounter(1n))).not.toThrow()
    expect(() => dec.accept(Nonce.fromCounter(2n))).not.toThrow()
    expect(() => dec.accept(Nonce.fromCounter(3n))).not.toThrow()
    expect(dec.hwm).toMatchInlineSnapshot('3n')
  })

  test('accepts forward jumps (strictly-greater is enough)', () => {
    const dec = Nonce.decoder()
    expect(() => dec.accept(Nonce.fromCounter(2n))).not.toThrow()
    expect(() => dec.accept(Nonce.fromCounter(7n))).not.toThrow()
    expect(dec.hwm).toBe(7n)
  })

  test('rejects 0 against the default HWM (must be strictly greater)', () => {
    const dec = Nonce.decoder()
    expect(() => dec.accept(Nonce.fromCounter(0n))).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: nonce not strictly greater than HWM
      Details: hwm=0, received counter=0]
    `,
    )
  })

  test('rejects a replayed nonce', () => {
    const dec = Nonce.decoder()
    dec.accept(Nonce.fromCounter(1n))
    expect(() => dec.accept(Nonce.fromCounter(1n))).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: nonce not strictly greater than HWM
      Details: hwm=1, received counter=1]
    `,
    )
  })

  test('rejects a backwards-going nonce', () => {
    const dec = Nonce.decoder()
    dec.accept(Nonce.fromCounter(1n))
    dec.accept(Nonce.fromCounter(2n))
    expect(() => dec.accept(Nonce.fromCounter(1n))).toThrowError(Errors.ProtocolError)
  })

  test('starts from a custom HWM', () => {
    const dec = Nonce.decoder({ hwm: 5n })
    expect(() => dec.accept(Nonce.fromCounter(5n))).toThrowError(Errors.ProtocolError)
    expect(() => dec.accept(Nonce.fromCounter(6n))).not.toThrow()
    expect(dec.hwm).toMatchInlineSnapshot('6n')
  })
})
