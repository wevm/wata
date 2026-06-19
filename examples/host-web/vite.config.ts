import { cloudflare } from '@cloudflare/vite-plugin'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            host: fileURLToPath(new URL('./host.html', import.meta.url)),
            main: fileURLToPath(new URL('./index.html', import.meta.url)),
          },
        },
      },
    },
  },
  plugins: [cloudflare()],
  server: {
    port: 5173,
    strictPort: true,
  },
})
