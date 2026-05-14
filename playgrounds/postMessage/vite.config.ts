import path from 'node:path'
import react from '@vitejs/plugin-react'
import regen from 'regen-ui/vite'
import { defineConfig } from 'vp'

export default defineConfig({
  plugins: [react(), regen()],
  resolve: {
    dedupe: ['vp'],
  },
  build: {
    rollupOptions: {
      input: {
        consumer: path.resolve(import.meta.dirname, 'index.html'),
        host: path.resolve(import.meta.dirname, 'host.html'),
      },
    },
  },
  optimizeDeps: {
    include: [
      'use-sync-external-store/shim',
      'use-sync-external-store/shim/with-selector',
    ],
  },
  server: {
    port: 5180,
  },
})
