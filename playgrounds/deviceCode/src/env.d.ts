declare global {
  namespace NodeJS {
    interface ProcessEnv {
      BASE_URL?: string
      PORT?: string
      PRIVATE_KEY?: `0x${string}`
    }
  }
}

export {}
