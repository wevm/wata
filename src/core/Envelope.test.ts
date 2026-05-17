import { describe, expect, test } from 'vp/test'
import { Envelope, Rpc } from 'wata'

describe('rpcRequests', () => {
  test('wraps a single request', () => {
    expect(Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]))
      .toMatchInlineSnapshot(`
      {
        "payload": [
          {
            "id": 1,
            "jsonrpc": "2.0",
            "method": "ping",
            "params": [],
          },
        ],
        "type": "rpc-requests",
      }
    `)
  })

  test('wraps a batch of requests + notifications', () => {
    expect(
      Envelope.rpcRequests([
        Rpc.request({ id: 1, method: 'ping', params: [] }),
        Rpc.notification({ method: 'announce', params: { msg: 'hi' } }),
      ]),
    ).toMatchInlineSnapshot(`
      {
        "payload": [
          {
            "id": 1,
            "jsonrpc": "2.0",
            "method": "ping",
            "params": [],
          },
          {
            "jsonrpc": "2.0",
            "method": "announce",
            "params": {
              "msg": "hi",
            },
          },
        ],
        "type": "rpc-requests",
      }
    `)
  })
})

describe('rpcResponses', () => {
  test('wraps a single success response', () => {
    expect(Envelope.rpcResponses([Rpc.success({ id: 1, result: { ok: true } })]))
      .toMatchInlineSnapshot(`
      {
        "payload": [
          {
            "id": 1,
            "jsonrpc": "2.0",
            "result": {
              "ok": true,
            },
          },
        ],
        "type": "rpc-responses",
      }
    `)
  })

  test('wraps a single error response', () => {
    expect(Envelope.rpcResponses([Rpc.error({ id: 1, code: -32601, message: 'method not found' })]))
      .toMatchInlineSnapshot(`
      {
        "payload": [
          {
            "error": {
              "code": -32601,
              "message": "method not found",
            },
            "id": 1,
            "jsonrpc": "2.0",
          },
        ],
        "type": "rpc-responses",
      }
    `)
  })
})

describe('ready', () => {
  test('defaults the payload to `{}`', () => {
    expect(Envelope.ready()).toMatchInlineSnapshot(`
      {
        "payload": {},
        "type": "ready",
      }
    `)
  })

  test('passes through caller metadata', () => {
    expect(Envelope.ready({ url: 'https://wallet.example' })).toMatchInlineSnapshot(`
      {
        "payload": {
          "url": "https://wallet.example",
        },
        "type": "ready",
      }
    `)
  })
})

describe('hello', () => {
  test('defaults the payload to `{}`', () => {
    expect(Envelope.hello()).toMatchInlineSnapshot(`
      {
        "payload": {},
        "type": "hello",
      }
    `)
  })
})

describe('encrypted', () => {
  test('builds the spec wire shape with base64url nonce + ct', () => {
    expect(
      Envelope.encrypted({
        ciphertext: '0xdeadbeef',
        from: Envelope.from.consumer,
        nonce: '0x000000000000000000000001',
      }),
    ).toMatchInlineSnapshot(`
      {
        "payload": {
          "ct": "3q2-7w",
          "from": "consumer",
          "nonce": "AAAAAAAAAAAAAAAB",
          "v": 1,
        },
        "type": "encrypted",
      }
    `)
  })

  test('round-trips through `toEncrypted`', () => {
    const env = Envelope.encrypted({
      ciphertext: '0xff00ff00',
      from: Envelope.from.host,
      nonce: '0x000000000000000000000002',
    })
    expect(Envelope.toEncrypted(env)).toMatchInlineSnapshot(`
      {
        "ciphertext": "0xff00ff00",
        "from": "host",
        "nonce": "0x000000000000000000000002",
      }
    `)
  })
})

describe('parse', () => {
  test('parses a JSON-encoded `rpc-requests` envelope', () => {
    const env = Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })])
    expect(Envelope.parse(JSON.parse(JSON.stringify(env)))).toMatchInlineSnapshot(`
      {
        "payload": [
          {
            "id": 1,
            "jsonrpc": "2.0",
            "method": "ping",
            "params": [],
          },
        ],
        "type": "rpc-requests",
      }
    `)
  })

  test('parses a JSON-encoded `encrypted` envelope', () => {
    const env = Envelope.encrypted({
      ciphertext: '0xdeadbeef',
      from: Envelope.from.consumer,
      nonce: '0x000000000000000000000001',
    })
    expect(Envelope.parse(JSON.parse(JSON.stringify(env)))).toMatchInlineSnapshot(`
      {
        "payload": {
          "ct": "3q2-7w",
          "from": "consumer",
          "nonce": "AAAAAAAAAAAAAAAB",
          "v": 1,
        },
        "type": "encrypted",
      }
    `)
  })

  test('rejects an unknown envelope type', () => {
    expect(() => Envelope.parse({ payload: 1, type: 'plain' })).toThrowErrorMatchingInlineSnapshot(
      `
    	[ProtocolError: invalid envelope
    	Details: type: Invalid input]
    `,
    )
  })

  test('rejects an encrypted envelope with invalid base64url ciphertext', () => {
    expect(() =>
      Envelope.parse({
        payload: { ct: '!!!!', from: 'consumer', nonce: 'AAAA', v: 1 },
        type: 'encrypted',
      }),
    ).toThrowError('invalid envelope')
  })

  test('rejects an encrypted envelope with the wrong protocol version', () => {
    expect(() =>
      Envelope.parse({
        payload: { ct: 'AAAA', from: 'consumer', nonce: 'AAAA', v: 2 },
        type: 'encrypted',
      }),
    ).toThrowError('invalid envelope')
  })
})
