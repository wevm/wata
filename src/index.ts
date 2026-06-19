// wata: consumer entrypoint
//
// Re-exports the consumer public API: shared primitives, `Wata.create`,
// and consumer-side transport factories.

export * as Aad from './core/Aad.js'
export * as Aead from './core/Aead.js'
export * as Crypto from './core/Crypto.js'
export * as Directory from './core/Directory.js'
export * as Discovery from './core/Discovery.js'
export * as Envelope from './core/Envelope.js'
export * as Errors from './core/Errors.js'
export * as Fetch from './core/Fetch.js'
export * as Identity from './identity.js'
export * as Kdf from './core/Kdf.js'
export * as Store from './core/Store.js'
export * as MessageSig from './core/MessageSig.js'
export * as Nonce from './core/Nonce.js'
export * as Rpc from './core/Rpc.js'
export * as Schema from './core/Schema.js'
export * as Session from './consumer/Session.js'
export * as SessionKey from './core/SessionKey.js'
export * as Transport from './core/Transport.js'

export * as Wata from './consumer/Wata.js'

export { loopback } from './core/transports/loopback.js'
export { postMessage } from './consumer/transports/postMessage.js'
export * as PostMessage from './consumer/transports/postMessage.js'
export { deviceCode } from './consumer/transports/deviceCode.js'
export * as DeviceCode from './consumer/transports/deviceCode.js'
export { mobileLink } from './consumer/transports/mobileLink.js'
export * as MobileLink from './consumer/transports/mobileLink.js'
export { mobileWebAuth } from './consumer/transports/mobileWebAuth.js'
export * as MobileWebAuth from './consumer/transports/mobileWebAuth.js'
export { relay } from './consumer/transports/relay.js'
export * as Relay from './consumer/transports/relay.js'
export { webhookCallback } from './consumer/transports/webhookCallback.js'
export * as WebhookCallback from './consumer/transports/webhookCallback.js'
