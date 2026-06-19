/**
 * Directory the consumer queries to discover wallets (`examples/directory`).
 *
 * Each result carries the wallet's `origin`; the consumer then fetches that
 * origin's `host.json` to learn which transports it speaks (`window` → web,
 * otherwise mobile).
 */
export const directoryUrl = import.meta.env.VITE_DIRECTORY_URL ?? 'http://localhost:4870'

/**
 * Relay broker the universal QR pairs through. Any mobile wallet can scan the
 * QR to connect, regardless of the directory.
 *
 * Defaults to the page's own hostname so a page opened via a LAN address hands
 * the phone a reachable relay too. Override with `VITE_RELAY_URL`.
 */
export const relayUrl =
  import.meta.env.VITE_RELAY_URL ??
  `http://${typeof location === 'undefined' ? 'localhost' : location.hostname}:4860`
