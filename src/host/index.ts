// handshakes/host — host entrypoint
//
// Re-exports the host half of the public API. Per `tasks/plan.md`, this
// surface grows incrementally:
// - Phase 1 adds `Handshake.create` (host-shaped via the transport's `role`
//   literal) and the host-side `window` transport.
// - Later phases add the remaining host-side transports
//   (`deviceCode`, `webhookCallback`, `mobileLink`, `mobileWebAuth`, `relay`).

export {}
