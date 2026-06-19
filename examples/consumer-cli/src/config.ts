/** Directory the consumer queries to discover wallets (`examples/directory`). */
export const directoryUrl = process.env.DIRECTORY_URL ?? 'http://localhost:4870'

/**
 * Relay broker the `relay` transport pairs through to reach a mobile wallet.
 *
 * On a physical phone, set `RELAY_URL` to the dev machine's LAN address (e.g.
 * `http://192.168.x.x:4860`) so the device can reach the relay; `localhost`
 * only works for the iOS simulator, which shares the Mac's network.
 */
export const relayUrl = process.env.RELAY_URL ?? 'http://localhost:4860'
