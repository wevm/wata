/**
 * Identity helpers for transports that need authenticated discovery or
 * RFC 9421-signed HTTP messages.
 */

import { Ed25519, type Hex } from 'ox'

import * as Crypto from './core/Crypto.js'
import * as MessageSig from './core/MessageSig.js'
import type * as Transport from './core/Transport.js'

/**
 * Create a signer-backed WATA identity from an Ed25519 private seed.
 *
 * The private key stays inside the returned signer closure. `Wata.create`
 * and transports receive only `{ publicKey, sign }`, which keeps private
 * key material out of the runtime binding contract.
 *
 * @example
 * ```ts
 * import { Identity, Wata, webhookCallback } from 'wata'
 *
 * const wata = Wata.create({
 *   identity: Identity.fromPrivateKey('0x...'),
 *   transports: [webhookCallback({ host: 'https://wallet.example' })],
 * })
 * ```
 */
export function fromPrivateKey(privateKey: fromPrivateKey.PrivateKey): fromPrivateKey.ReturnType {
  const publicKey = Crypto.encodePublicKey(Ed25519.getPublicKey({ privateKey }))

  return {
    publicKey,
    sign(options) {
      return MessageSig.sign({ ...options, privateKey })
    },
  }
}

export declare namespace fromPrivateKey {
  /** 32-byte Ed25519 private seed (`0x`-prefixed hex). */
  type PrivateKey = Hex.Hex

  /** Signer-backed identity accepted by `Wata.create`. */
  type ReturnType = Transport.Identity
}
