interface ImportMetaEnv {
  VITE_HOST_URL?: string
  VITE_RELAY_PAIRING_SECRET?: string
  VITE_RELAY_SESSION_ID?: string
}

interface ImportMeta {
  env: ImportMetaEnv
}

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      BASE_URL?: string
      PAIRING_SECRET?: string
      PORT?: string
      SESSION_ID?: string
    }
  }
}

export {}
