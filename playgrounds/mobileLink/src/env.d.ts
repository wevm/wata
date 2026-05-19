declare global {
  namespace NodeJS {
    interface ProcessEnv {
      BASE_URL?: string
      EXPO_PUBLIC_HOST_PUBLIC_KEY?: string
      EXPO_PUBLIC_HOST_URL?: string
      PORT?: string
      PRIVATE_KEY?: `0x${string}`
    }
  }
}

export {}
