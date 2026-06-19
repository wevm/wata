interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface ImportMetaEnv {
  readonly VITE_DIRECTORY_URL?: string
  readonly VITE_RELAY_URL?: string
}
