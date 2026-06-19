import { describe, expect, test } from 'vp/test'

import * as Envelope from '../../core/Envelope.js'
import * as Rpc from '../../core/Rpc.js'
import * as Sign from './Sign.js'

describe('Sign.toCaip2 / fromCaip2', () => {
  test('round-trips eip155 chain ids', () => {
    expect(Sign.toCaip2(1)).toBe('eip155:1')
    expect(Sign.toCaip2(8453)).toBe('eip155:8453')
    expect(Sign.fromCaip2('eip155:1')).toBe(1)
    expect(Sign.fromCaip2('eip155:10')).toBe(10)
  })

  test('rejects a non-eip155 namespace', () => {
    expect(() => Sign.fromCaip2('solana:mainnet')).toThrow(/unsupported CAIP-2 namespace/)
  })

  test('rejects a non-integer reference', () => {
    expect(() => Sign.fromCaip2('eip155:mainnet')).toThrow(/invalid CAIP-2 reference/)
  })
})

describe('Sign.toProviderRequest', () => {
  test('extracts a single request with its chain id', () => {
    const envelope = Envelope.rpcRequests([
      Rpc.request({
        context: { chainId: 10 },
        id: 7,
        method: 'eth_sendTransaction',
        params: [{ to: '0xabc' }],
      }),
    ])
    expect(Sign.toProviderRequest(envelope)).toEqual({
      chainId: 10,
      id: 7,
      method: 'eth_sendTransaction',
      params: [{ to: '0xabc' }],
    })
  })

  test('omits chainId when no context is present', () => {
    const envelope = Envelope.rpcRequests([
      Rpc.request({ id: 1, method: 'eth_chainId', params: [] }),
    ])
    const request = Sign.toProviderRequest(envelope)
    expect(request).toEqual({ id: 1, method: 'eth_chainId', params: [] })
    expect('chainId' in request).toBe(false)
  })

  test('rejects a batch of requests', () => {
    const envelope = Envelope.rpcRequests([
      Rpc.request({ id: 1, method: 'eth_chainId', params: [] }),
      Rpc.request({ id: 2, method: 'eth_accounts', params: [] }),
    ])
    expect(() => Sign.toProviderRequest(envelope)).toThrow(/exactly one request/)
  })

  test('rejects a consumer notification', () => {
    const envelope = Envelope.rpcRequests([Rpc.notification({ method: 'ping', params: [] })])
    expect(() => Sign.toProviderRequest(envelope)).toThrow(/does not send consumer notifications/)
  })

  test('rejects a non-rpc-requests envelope', () => {
    const envelope = Envelope.rpcResponses([Rpc.success({ id: 1, result: '0x1' })])
    expect(() => Sign.toProviderRequest(envelope)).toThrow(/expected an `rpc-requests` envelope/)
  })
})

describe('Sign envelope builders', () => {
  test('successEnvelope wraps a result', () => {
    const envelope = Sign.successEnvelope(3, '0xabc')
    expect(envelope.type).toBe('rpc-responses')
    expect(envelope.payload).toEqual([{ id: 3, jsonrpc: '2.0', result: '0xabc' }])
  })

  test('errorEnvelope maps a provider error', () => {
    const envelope = Sign.errorEnvelope(4, { code: 4001, message: 'User rejected' })
    expect(envelope.payload).toEqual([
      { error: { code: 4001, message: 'User rejected' }, id: 4, jsonrpc: '2.0' },
    ])
  })

  test('errorEnvelope falls back to -32603 for opaque errors', () => {
    const envelope = Sign.errorEnvelope(5, new Error('boom'))
    expect(envelope.payload).toEqual([
      { error: { code: -32603, message: 'boom' }, id: 5, jsonrpc: '2.0' },
    ])
  })

  test('notificationEnvelope builds an rpc-requests notification', () => {
    const envelope = Sign.notificationEnvelope('accountsChanged', [['0x1']])
    expect(envelope.type).toBe('rpc-requests')
    expect(envelope.payload).toEqual([
      { jsonrpc: '2.0', method: 'accountsChanged', params: [['0x1']] },
    ])
  })
})
