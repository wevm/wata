import react from '@vitejs/plugin-react'
import regen from 'regen-ui/vite'
import { defineConfig } from 'vp'

export default defineConfig({
  optimizeDeps: {
    include: [
      'wata > ox > eventemitter3',
      'use-sync-external-store/shim',
      'use-sync-external-store/shim/with-selector',
    ],
  },
  plugins: [react(), regen()],
  resolve: {
    dedupe: ['vp'],
  },
  server: {
    port: 5181,
  },
})
