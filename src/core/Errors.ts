/**
 * Generic error infrastructure shared across `wata`.
 *
 * Errors are the only exception to the project-wide "factory functions only"
 * rule — they're classes so consumers can branch on `instanceof`.
 *
 * This module exports only the **non-domain-specific** building blocks:
 *
 * - {@link BaseError} — the base class every other error inherits from.
 * - {@link ProtocolError} — thrown by parsers/validators across the protocol
 *   stack (`Aad`, `Nonce`, `Envelope`, `Rpc`, `Schema`, …) when an inbound
 *   value fails to parse or validate.
 *
 * Module-specific errors live next to the code that throws them, e.g.
 * `Aead.OpenError`, `Rpc.RpcError`, `Transport.ClosedError`. Importing them
 * from their owning namespace keeps each module self-describing and prevents
 * `Errors` from accumulating an open-ended catalogue.
 */

/**
 * Base error class inherited by every error thrown from `wata`.
 *
 * Subclasses set `name` (used for `instanceof` discrimination at runtime) and
 * pass a short human-readable message + optional structured fields.
 *
 * @example
 * ```ts
 * try {
 *   await handshake.send({ method: 'ping', params: [] })
 * } catch (error) {
 *   if (error instanceof Aead.OpenError) {
 *     // tampered ciphertext
 *   }
 * }
 * ```
 */
export class BaseError<cause extends Error | undefined = undefined> extends Error {
  /** Subclass name (e.g. `'Aead.OpenError'`); used for `instanceof` parity across realms. */
  override name = 'BaseError'

  /** Optional structured details about the error (e.g. peer identifier, frame index). */
  details: string | undefined

  /** Extra lines appended to the rendered message; useful for breadcrumbs. */
  metaMessages: readonly string[] | undefined

  /** Underlying cause, if this error wraps another. */
  override cause: cause

  constructor(message: string, options: BaseError.Options<cause> = {} as BaseError.Options<cause>) {
    const { cause, details, metaMessages } = options
    const lines = [message]
    if (details) lines.push(`Details: ${details}`)
    if (metaMessages?.length) lines.push(...metaMessages)
    super(lines.join('\n'))
    this.cause = cause as cause
    this.details = details
    this.metaMessages = metaMessages
  }
}

export declare namespace BaseError {
  /** Options accepted by every {@link BaseError} subclass. */
  type Options<cause extends Error | undefined = Error | undefined> = {
    /** Underlying cause of the error. */
    cause?: cause | undefined
    /** Structured details appended to the rendered message under `Details: ...`. */
    details?: string | undefined
    /** Extra lines appended after the message + details. */
    metaMessages?: readonly string[] | undefined
  }
}

/**
 * Thrown when a peer rejects an inbound frame for protocol reasons (unknown
 * envelope type, unexpected encrypted payload on a plain transport, malformed
 * JSON-RPC envelope, schema validation failure, etc.).
 *
 * Used across the protocol stack — `Aad`, `Nonce`, `Envelope`, `Rpc`,
 * `Schema`. Module-specific failure classes (e.g. {@link "./Aead".OpenError})
 * exist when the failure is meaningful enough to discriminate on.
 */
export class ProtocolError<
  cause extends Error | undefined = Error | undefined,
> extends BaseError<cause> {
  override name = 'ProtocolError'
}
