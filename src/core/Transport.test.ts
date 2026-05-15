import { describe, expect, test } from 'vp/test'
import { Errors, Transport } from 'wata'

describe('TransportError', () => {
  test('has the Transport.TransportError name and inherits BaseError', () => {
    const error = new Transport.TransportError('peer unreachable')
    expect(error.name).toMatchInlineSnapshot('"Transport.TransportError"')
    expect(error).toBeInstanceOf(Errors.BaseError)
  })

  test('preserves a typed cause', () => {
    const cause = new TypeError('connect ECONNREFUSED')
    const error = new Transport.TransportError<TypeError>('peer unreachable', { cause })
    expect(error.cause).toBe(cause)
  })
})

describe('ClosedError', () => {
  test('has the Transport.ClosedError name and inherits BaseError', () => {
    const error = new Transport.ClosedError('session already closed')
    expect(error.name).toMatchInlineSnapshot('"Transport.ClosedError"')
    expect(error).toBeInstanceOf(Errors.BaseError)
  })
})

describe('UnsupportedError', () => {
  test('has the Transport.UnsupportedError name and inherits BaseError', () => {
    const error = new Transport.UnsupportedError('sendBatch is not supported on this transport')
    expect(error.name).toMatchInlineSnapshot('"Transport.UnsupportedError"')
    expect(error).toBeInstanceOf(Errors.BaseError)
  })
})
