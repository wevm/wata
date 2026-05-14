// handshakes/host — host entrypoint
//
// Re-exports the host half of the public API. Per `tasks/PLAN.md`, this
// surface grows incrementally:
// - Phase 1 adds `Handshake.create` (host-shaped via the transport's `role`
//   literal) and the host-side `postMessage` transport.
// - Later phases add the remaining host-side transports
//   (`deviceCode`, `webhookCallback`, `mobileLink`, `mobileWebAuth`, `relay`).

export * as Handshake from './Handshake.js'
export * as Kv from '../core/Kv.js'
export * as Transport from '../core/Transport.js'

export { postMessage } from './transports/postMessage.js'
export * as PostMessage from './transports/postMessage.js'
export { deviceCode } from './transports/deviceCode.js'
export * as DeviceCode from './transports/deviceCode.js'
