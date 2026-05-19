export const hostPrivateKey =
  process.env.EXPO_PUBLIC_HOST_PRIVATE_KEY ??
  '0x2222222222222222222222222222222222222222222222222222222222222222'
export const hostPublicKey =
  process.env.EXPO_PUBLIC_HOST_PUBLIC_KEY ?? 'oJql9HpnWYAv-VX43C0qFKXJnSO-l_hkEn_5ODRVpPA'
export const hostPath = process.env.EXPO_PUBLIC_HOST_PATH ?? '/auth/mobile-link'
export const hostScheme = process.env.EXPO_PUBLIC_HOST_SCHEME ?? 'example-ironbank'
export const hostUrl = process.env.EXPO_PUBLIC_HOST_URL ?? `${hostScheme}://${hostPath}`
export const permissions = ['Account balance', 'Recent transactions', 'Account holder name']
