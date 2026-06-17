/** Origin serving the host wallet's `host.json`. */
export const hostOrigin = process.env.EXPO_PUBLIC_HOST_URL ?? 'http://localhost:5611'

/** Origin serving this app's own `consumer.json`; sent to the host as `id`. */
export const consumerOrigin = process.env.EXPO_PUBLIC_CONSUMER_URL ?? 'http://localhost:5612'

/** Reverse-DNS private-use callback URI this app registers. */
export const callback = 'com.example.mobilewebauth://callback'
