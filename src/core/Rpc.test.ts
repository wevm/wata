import { Errors, Rpc } from 'wata'
import { describe, expect, test } from 'vp/test'

describe('RpcError', () => {
  test('exposes JSON-RPC code and data', () => {
    const error = new Rpc.RpcError('method not found', { code: -32601, data: { method: 'foo' } })
    expect(error.code).toMatchInlineSnapshot('-32601')
    expect(error.data).toMatchInlineSnapshot(`
      {
        "method": "foo",
      }
    `)
    expect(error.name).toMatchInlineSnapshot('"Rpc.RpcError"')
    expect(error).toBeInstanceOf(Errors.BaseError)
  })

  test('omits data when not provided', () => {
    const error = new Rpc.RpcError('invalid params', { code: -32602 })
    expect(error.code).toMatchInlineSnapshot('-32602')
    expect(error.data).toMatchInlineSnapshot('undefined')
  })
})

describe('request', () => {
  test('builds a JSON-RPC 2.0 request', () => {
    expect(Rpc.request({ id: 1, method: 'eth_blockNumber', params: [] })).toMatchInlineSnapshot(`
      {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "eth_blockNumber",
        "params": [],
      }
    `)
  })

  test('preserves named params', () => {
    expect(Rpc.request({ id: 'abc', method: 'foo', params: { bar: 1 } })).toMatchInlineSnapshot(`
      {
        "id": "abc",
        "jsonrpc": "2.0",
        "method": "foo",
        "params": {
          "bar": 1,
        },
      }
    `)
  })
})

describe('notification', () => {
  test('omits the id field', () => {
    const message = Rpc.notification({ method: 'progress', params: [42] })
    expect(message).toMatchInlineSnapshot(`
      {
        "jsonrpc": "2.0",
        "method": "progress",
        "params": [
          42,
        ],
      }
    `)
    expect('id' in message).toBe(false)
  })
})

describe('success', () => {
  test('wraps a result', () => {
    expect(Rpc.success({ id: 1, result: '0x1' })).toMatchInlineSnapshot(`
      {
        "id": 1,
        "jsonrpc": "2.0",
        "result": "0x1",
      }
    `)
  })

  test('accepts a null id (per JSON-RPC 2.0 §5)', () => {
    expect(Rpc.success({ id: null, result: undefined })).toMatchInlineSnapshot(`
      {
        "id": null,
        "jsonrpc": "2.0",
        "result": undefined,
      }
    `)
  })
})

describe('error', () => {
  test('builds an error response without data', () => {
    expect(Rpc.error({ id: 1, code: -32601, message: 'method not found' })).toMatchInlineSnapshot(
      `
      {
        "error": {
          "code": -32601,
          "message": "method not found",
        },
        "id": 1,
        "jsonrpc": "2.0",
      }
    `,
    )
  })

  test('includes data when provided', () => {
    expect(Rpc.error({ id: 1, code: -32602, message: 'invalid params', data: { method: 'foo' } }))
      .toMatchInlineSnapshot(`
      {
        "error": {
          "code": -32602,
          "data": {
            "method": "foo",
          },
          "message": "invalid params",
        },
        "id": 1,
        "jsonrpc": "2.0",
      }
    `)
  })
})

describe('parse', () => {
  test('discriminates a request', () => {
    expect(Rpc.parse({ jsonrpc: '2.0', id: 1, method: 'ping', params: [] })).toMatchInlineSnapshot(`
      {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "ping",
        "params": [],
      }
    `)
  })

  test('discriminates a notification', () => {
    expect(Rpc.parse({ jsonrpc: '2.0', method: 'progress', params: [1] })).toMatchInlineSnapshot(
      `
      {
        "jsonrpc": "2.0",
        "method": "progress",
        "params": [
          1,
        ],
      }
    `,
    )
  })

  test('discriminates a success response', () => {
    expect(Rpc.parse({ jsonrpc: '2.0', id: 1, result: 42 })).toMatchInlineSnapshot(`
      {
        "id": 1,
        "jsonrpc": "2.0",
        "result": 42,
      }
    `)
  })

  test('discriminates an error response', () => {
    expect(Rpc.parse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'nope' } }))
      .toMatchInlineSnapshot(`
      {
        "error": {
          "code": -1,
          "message": "nope",
        },
        "id": 1,
        "jsonrpc": "2.0",
      }
    `)
  })

  test('rejects a non-object value', () => {
    expect(() => Rpc.parse(42)).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: JSON-RPC message must be an object]',
    )
  })

  test('rejects a request with wrong jsonrpc version', () => {
    expect(() => Rpc.parse({ jsonrpc: '1.0', id: 1, method: 'a', params: [] })).toThrowError(
      Errors.ProtocolError,
    )
  })

  test('rejects a request with missing method', () => {
    expect(() => Rpc.parse({ jsonrpc: '2.0', id: 1, params: [] })).toThrowError(
      Errors.ProtocolError,
    )
  })
})
