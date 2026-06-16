/** Demo host identity seed (RFC 8032 test vector — never use in production). */
export const hostIdentityPrivateKey =
  '0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60' as const
/** Origin the host self-asserts; served by the host discovery worker. */
export const hostOrigin = 'http://localhost:8788'
/** Custom URL scheme registered by this host (wallet) Expo app. */
export const hostScheme = 'com.wata.mobilelink.host'
