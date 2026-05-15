import react from '@vitejs/plugin-react'
import regen from 'regen-ui/vite'
import { defineConfig } from 'vp'

export default defineConfig({
  plugins: [react(), regen()],
  resolve: {
    dedupe: ['vp'],
  },
  optimizeDeps: {
    include: [
      'wata > ox > eventemitter3',
      'use-sync-external-store/shim',
      'use-sync-external-store/shim/with-selector',
    ],
  },
  server: {
    port: 5181,
  },
})
