// wata — consumer entrypoint
//
// Re-exports the consumer half of the public API. Per `tasks/plan.md`, this
// surface grows incrementally:
// - Phase 0 exposes the low-level toolkit (`Crypto`, `Aad`, `Aead`, `Nonce`,
//   `Envelope`, `Rpc`, `Schema`, `Discovery`, `Errors`, `Transport`) and the
//   in-process `loopback` transport factory.
// - Phase 1 adds `Handshake.create` and the consumer `postMessage` transport.
// - Later phases add the remaining consumer-side transports.

export * as Aad from './core/Aad.js'
export * as Aead from './core/Aead.js'
export * as Crypto from './core/Crypto.js'
export * as Discovery from './core/Discovery.js'
export * as Envelope from './core/Envelope.js'
export * as Errors from './core/Errors.js'
export * as Kdf from './core/Kdf.js'
export * as Kv from './core/Kv.js'
export * as Nonce from './core/Nonce.js'
export * as Rpc from './core/Rpc.js'
export * as Schema from './core/Schema.js'
export * as Session from './core/Session.js'
export * as Transport from './core/Transport.js'

export * as Handshake from './Handshake.js'

export { loopback } from './core/transports/loopback.js'
export { postMessage } from './consumer/transports/postMessage.js'
export * as PostMessage from './consumer/transports/postMessage.js'
export { deviceCode } from './consumer/transports/deviceCode.js'
export * as DeviceCode from './consumer/transports/deviceCode.js'
