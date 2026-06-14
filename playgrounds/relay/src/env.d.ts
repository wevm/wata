declare namespace NodeJS {
  type ProcessEnv = {
    PORT?: string | undefined
    RECEIVE?: 'poll' | 'sse' | undefined
    RELAY_URL?: string | undefined
  }
}
