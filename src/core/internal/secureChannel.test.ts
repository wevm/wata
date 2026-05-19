import { describe, expect, test } from 'vp/test'
import { Crypto, Envelope, Rpc, Session } from 'wata'

import * as SecureChannel from './secureChannel.js'

describe('create', () => {
  test('does not advance inbound nonce when authentication fails', () => {
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()
    const consumerChannel = SecureChannel.create({
      keys: Session.derive({
        peer: { publicKey: host.x25519.publicKey },
        role: 'consumer',
        self: consumer.x25519,
        transportId: 'mobile-link',
      }),
      publicKey: consumer.x25519.publicKey,
      role: 'consumer',
    })
    const hostChannel = SecureChannel.create({
      keys: Session.derive({
        peer: { publicKey: consumer.x25519.publicKey },
        role: 'host',
        self: host.x25519,
        transportId: 'mobile-link',
      }),
      publicKey: consumer.x25519.publicKey,
      role: 'host',
    })

    const valid = consumerChannel.seal(
      Envelope.rpcRequests([Rpc.request({ id: 1, method: 'ping', params: [] })]),
    )
    const tampered = consumerChannel.seal(
      Envelope.rpcRequests([Rpc.request({ id: 2, method: 'pong', params: [] })]),
    )
    const prefix = tampered.payload.ct.startsWith('A') ? 'B' : 'A'
    tampered.payload.ct = `${prefix}${tampered.payload.ct.slice(1)}`

    expect(() => hostChannel.open(tampered)).toThrowErrorMatchingInlineSnapshot(
      `[Aead.OpenError: AEAD authentication failed]`,
    )
    expect(hostChannel.open(valid)).toMatchInlineSnapshot(`
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
})
