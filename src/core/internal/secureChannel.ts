/**
 * Internal AEAD wrapper for transports that key themselves before handing
 * plaintext envelopes back to `Wata`.
 */

import { Bytes, type Hex } from 'ox'

import * as Aad from '../Aad.js'
import * as Aead from '../Aead.js'
import * as Envelope from '../Envelope.js'
import * as Errors from '../Errors.js'
import * as Nonce from '../Nonce.js'
import * as Session from '../Session.js'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** Directional AEAD state for one transport session. */
export type Channel = {
  /** Open an encrypted envelope from the peer. */
  open: (envelope: Extract<Envelope.Envelope, { type: 'encrypted' }>) => Envelope.Envelope
  /** Seal a plaintext envelope for the peer. */
  seal: (envelope: Envelope.Envelope) => Extract<Envelope.Envelope, { type: 'encrypted' }>
}

/** Create directional AEAD state from an already-derived session. */
export function create(options: create.Options): Channel {
  const { keys, publicKey, role } = options
  const inbound = Nonce.decoder()
  const outbound = Nonce.encoder()

  const from = role === 'consumer' ? Envelope.from.consumer : Envelope.from.host
  const peerFrom = role === 'consumer' ? Envelope.from.host : Envelope.from.consumer
  const openKey = role === 'consumer' ? keys.h2c : keys.c2h
  const sealKey = role === 'consumer' ? keys.c2h : keys.h2c
  const openAad = Aad.encode({
    publicKey,
    role: role === 'consumer' ? Aad.role.host : Aad.role.consumer,
  })
  const sealAad = Aad.encode({
    publicKey,
    role: role === 'consumer' ? Aad.role.consumer : Aad.role.host,
  })

  return {
    open(envelope) {
      const encrypted = Envelope.toEncrypted(envelope)
      if (encrypted.from !== peerFrom)
        throw new Errors.ProtocolError(
          `encrypted envelope came from \`${encrypted.from}\`, expected \`${peerFrom}\``,
        )
      inbound.accept(encrypted.nonce)
      return Envelope.parse(
        JSON.parse(
          decoder.decode(
            Bytes.from(
              Aead.open({
                aad: openAad,
                ciphertext: encrypted.ciphertext,
                key: openKey,
                nonce: encrypted.nonce,
              }),
            ),
          ),
        ),
      )
    },
    seal(envelope) {
      const nonce = outbound.next()
      const ciphertext = Aead.seal({
        aad: sealAad,
        key: sealKey,
        nonce,
        plaintext: encoder.encode(JSON.stringify(envelope)),
      })
      return Envelope.encrypted({ ciphertext, from, nonce })
    },
  }
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options = {
    /** Directional keys derived with {@link Session.derive}. */
    keys: Session.derive.ReturnType
    /** Consumer session public key, used in AEAD AAD. */
    publicKey: Hex.Hex | Bytes.Bytes
    /** Local role for directional key selection. */
    role: 'consumer' | 'host'
  }
}
