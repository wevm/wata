// wata/host: host entrypoint
//
// Re-exports the host public API: host-shaped `Wata.create`, shared host
// helpers, and host-side transport factories.

export * as Wata from './Wata.js'
export * as Discovery from '../core/Discovery.js'
export * as Kv from '../core/Kv.js'
export * as Schema from '../core/Schema.js'
export * as Transport from '../core/Transport.js'

export { postMessage } from './transports/postMessage.js'
export * as PostMessage from './transports/postMessage.js'
export { deviceCode } from './transports/deviceCode.js'
export * as DeviceCode from './transports/deviceCode.js'
export { webhookCallback } from './transports/webhookCallback.js'
export * as WebhookCallback from './transports/webhookCallback.js'
export * as MessageSig from '../core/MessageSig.js'
