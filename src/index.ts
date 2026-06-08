// wata: consumer entrypoint
//
// Re-exports the consumer public API: shared primitives, `Wata.create`,
// and consumer-side transport factories.

export * as Aad from './core/Aad.js'
export * as Aead from './core/Aead.js'
export * as Crypto from './core/Crypto.js'
export * as Discovery from './core/Discovery.js'
export * as Envelope from './core/Envelope.js'
export * as Errors from './core/Errors.js'
export * as Fetch from './core/Fetch.js'
export * as Identity from './identity.js'
export * as Kdf from './core/Kdf.js'
export * as Kv from './core/Kv.js'
export * as MessageSig from './core/MessageSig.js'
export * as Nonce from './core/Nonce.js'
export * as Rpc from './core/Rpc.js'
export * as Schema from './core/Schema.js'
export * as Session from './core/Session.js'
export * as Transport from './core/Transport.js'

export * as Wata from './Wata.js'

export { loopback } from './core/transports/loopback.js'
export { postMessage } from './consumer/transports/postMessage.js'
export * as PostMessage from './consumer/transports/postMessage.js'
export { deviceCode } from './consumer/transports/deviceCode.js'
export * as DeviceCode from './consumer/transports/deviceCode.js'
export { mobileWebAuth } from './consumer/transports/mobileWebAuth.js'
export * as MobileWebAuth from './consumer/transports/mobileWebAuth.js'
export { webhookCallback } from './consumer/transports/webhookCallback.js'
export * as WebhookCallback from './consumer/transports/webhookCallback.js'
