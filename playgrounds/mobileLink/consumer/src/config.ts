/** Origin serving the host's `host.json` (the discovery worker). */
export const hostOrigin = 'http://localhost:8788'
/** Origin serving this consumer's `consumer.json`; sent to the host as `id`. */
export const consumerOrigin = 'http://localhost:8789'
/** Custom URL scheme registered by the host (wallet) Expo app. */
export const hostScheme = 'com.wata.mobilelink.host'
/** Sticky deep link the host opens to deliver messages back to this app. */
export const consumerReturnUrl = 'com.wata.mobilelink.consumer://cb'
