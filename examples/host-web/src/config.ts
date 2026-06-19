/** Origin this web host is reachable at (discovery + approval UI live here). */
export const baseUrl = 'http://localhost:5173'

/**
 * Long-term Ed25519 identity published in `host.json` and used to sign
 * handshakes. Demo key — never reuse it in production.
 */
export const identityPrivateKey =
  '0x2222222222222222222222222222222222222222222222222222222222222222' as const
