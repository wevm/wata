declare namespace NodeJS {
  type ProcessEnv = {
    BASE_URL?: string | undefined
    CALLBACK_URL?: string | undefined
    CONSUMER_ID?: string | undefined
    EXPO_PUBLIC_CONSUMER_ID?: string | undefined
    EXPO_PUBLIC_HOST_ORIGIN?: string | undefined
    PORT?: string | undefined
    PRIVATE_KEY?: `0x${string}` | undefined
  }
}
