declare global {
  namespace NodeJS {
    interface ProcessEnv {
      EXPO_PUBLIC_HOST_PATH?: string
      EXPO_PUBLIC_HOST_PRIVATE_KEY?: `0x${string}`
      EXPO_PUBLIC_HOST_PUBLIC_KEY?: string
      EXPO_PUBLIC_HOST_SCHEME?: string
      EXPO_PUBLIC_HOST_URL?: string
      EXPO_PUBLIC_MOBILE_LINK_ROLE?: 'consumer' | 'host'
    }
  }
}

export {}
