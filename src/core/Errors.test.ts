import { Errors } from 'wata'
import { describe, expect, test } from 'vp/test'

describe('BaseError', () => {
  test('renders short message only when no details/metaMessages', () => {
    const error = new Errors.BaseError('something went wrong')
    expect(error.message).toMatchInlineSnapshot('"something went wrong"')
    expect(error.name).toMatchInlineSnapshot('"BaseError"')
  })

  test('appends details and metaMessages to the rendered message', () => {
    const error = new Errors.BaseError('frame rejected', {
      details: 'index=2',
      metaMessages: ['peer=consumer', 'session=abc'],
    })
    expect(error.message).toMatchInlineSnapshot(`
      "frame rejected
      Details: index=2
      peer=consumer
      session=abc"
    `)
  })

  test('wraps a cause', () => {
    const cause = new Error('socket closed')
    const error = new Errors.BaseError('transport failure', { cause })
    expect(error.cause).toBe(cause)
  })
})

describe('ProtocolError', () => {
  test('has the ProtocolError name and inherits BaseError', () => {
    const error = new Errors.ProtocolError('unknown envelope type')
    expect(error.name).toMatchInlineSnapshot('"ProtocolError"')
    expect(error).toBeInstanceOf(Errors.BaseError)
  })
})
