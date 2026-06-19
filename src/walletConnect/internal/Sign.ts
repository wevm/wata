import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Rpc from '../../core/Rpc.js'

/** Encode an EVM chain id as CAIP-2 (`1` -> `eip155:1`). */
export function toCaip2(chainId: number): string {
  return `eip155:${chainId}`
}

/** Decode a CAIP-2 EIP-155 chain id (`eip155:1` -> `1`). Throws otherwise. */
export function fromCaip2(value: string): number {
  const [namespace, reference] = value.split(':')
  if (namespace !== 'eip155')
    throw new Errors.BaseError(`unsupported CAIP-2 namespace \`${namespace}\``, {
      details: 'wata/walletConnect maps only `eip155:*` chains',
    })
  const chainId = Number(reference)
  if (!Number.isInteger(chainId))
    throw new Errors.BaseError(`invalid CAIP-2 reference \`${reference}\``)
  return chainId
}

/** A single outbound request extracted from an `rpc-requests` envelope. */
export type ProviderRequest = {
  chainId?: number | undefined
  id: Rpc.Id
  method: string
  params: Rpc.Params
}

/**
 * Extract the single JSON-RPC request from an outbound `rpc-requests`
 * envelope. Rejects batches and notifications -- the WC dapp role only
 * sends single requests.
 */
export function toProviderRequest(envelope: Envelope.Envelope): ProviderRequest {
  if (envelope.type !== 'rpc-requests')
    throw new Errors.BaseError(
      `expected an \`rpc-requests\` envelope, received \`${envelope.type}\``,
    )
  const messages = envelope.payload
  if (messages.length !== 1)
    throw new Errors.BaseError('wata/walletConnect sends exactly one request per call')
  const message = messages[0]!
  if (!('id' in message))
    throw new Errors.BaseError('wata/walletConnect does not send consumer notifications')
  const chainId = message.context?.chainId
  return {
    id: message.id,
    method: message.method,
    params: message.params,
    ...(chainId !== undefined ? { chainId } : {}),
  }
}

/** Build an inbound `rpc-responses` envelope for a successful provider result. */
export function successEnvelope(id: Rpc.Id, result: unknown): Envelope.Envelope {
  return Envelope.rpcResponses([Rpc.success({ id, result })])
}

/** Build an inbound `rpc-responses` envelope from a provider error. */
export function errorEnvelope(id: Rpc.Id, error: unknown): Envelope.Envelope {
  const { code, data, message } = normalizeError(error)
  return Envelope.rpcResponses([
    Rpc.error({ code, id, message, ...(data !== undefined ? { data } : {}) }),
  ])
}

/** Build an inbound notification (`rpc-requests`) envelope for a wallet event. */
export function notificationEnvelope(method: string, params: Rpc.Params): Envelope.Envelope {
  return Envelope.rpcRequests([Rpc.notification({ method, params })])
}

function normalizeError(error: unknown): { code: number; data?: unknown; message: string } {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const code = typeof record['code'] === 'number' ? record['code'] : -32603
    const message =
      typeof record['message'] === 'string' ? record['message'] : 'WalletConnect request failed'
    return { code, message, ...(record['data'] !== undefined ? { data: record['data'] } : {}) }
  }
  return { code: -32603, message: 'WalletConnect request failed' }
}
