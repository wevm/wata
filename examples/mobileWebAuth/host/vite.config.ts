import { getRequestListener } from '@hono/node-server'
import { type Connect, type PluginOption, defineConfig } from 'vite'

import { handler } from './src/host'

// Bridge the host's web-standard fetch handler into Vite's Node dev and
// preview servers. Discovery (`/.well-known/urpc/*`) and the
// authorization endpoint (`/auth/mobile`) are served by `wata`; every
// other request falls through to the static landing page.
function wataHost(): PluginOption {
  const listener = getRequestListener(handler)
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? '/'
    if (url.startsWith('/auth/mobile') || url.startsWith('/.well-known/urpc/')) {
      listener(req, res)
      return
    }
    next()
  }
  return {
    name: 'wata-host',
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
    configureServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

export default defineConfig({
  plugins: [wataHost()],
  server: {
    host: true,
    // Fail loudly instead of silently shifting ports — the consumer dials
    // this exact port, so a collision must surface, not move.
    port: 5611,
    strictPort: true,
  },
})
