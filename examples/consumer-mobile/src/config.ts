/**
 * Directory the app queries to discover wallets (`examples/directory`).
 *
 * `localhost` works for the iOS simulator (shares the Mac's network); on a
 * physical device use the dev machine's LAN address.
 */
export const directoryUrl = 'http://localhost:4870'

/** Origin serving this app's own `consumer.json`; sent to hosts as `id`. */
export const consumerOrigin = 'http://localhost:8789'
/** Reverse-DNS callback URI registered for the `mobileWebAuth` flow. */
export const mobileWebAuthCallback = 'com.wata.consumer://callback'
/** Sticky deep link the mobile host opens to deliver `mobileLink` responses. */
export const mobileLinkReturnUrl = 'com.wata.consumer://cb'
