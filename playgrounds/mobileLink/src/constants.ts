export const callbackPath = '/callback'
export const defaultHostPrivateKey =
  '0x2222222222222222222222222222222222222222222222222222222222222222'
export const defaultHostPublicKey = 'oJql9HpnWYAv-VX43C0qFKXJnSO-l_hkEn_5ODRVpPA'

export const hostPrivateKey = process.env.EXPO_PUBLIC_HOST_PRIVATE_KEY ?? defaultHostPrivateKey
export const hostPath = process.env.EXPO_PUBLIC_HOST_PATH ?? '/auth/mobile-link'
export const hostPublicKey = process.env.EXPO_PUBLIC_HOST_PUBLIC_KEY ?? defaultHostPublicKey
export const hostScheme = process.env.EXPO_PUBLIC_HOST_SCHEME ?? 'ironbank'
export const hostUrl = process.env.EXPO_PUBLIC_HOST_URL ?? `${hostScheme}://${hostPath}`
