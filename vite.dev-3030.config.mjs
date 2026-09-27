// Dev config: the working-tree UI against the *installed* Lyra service on :3030.
//
// For working on the frontend without reinstalling after every edit — `ops/lyra-server.sh install`
// rebuilds and redeploys, which is right for shipping and far too slow for a loop on one component.
//
//   VITE_API_URL=/api VITE_USE_API=true npx vite --config vite.dev-3030.config.mjs
//
// Why a proxy rather than VITE_API_URL pointing straight at :3030 — the service's CORS default
// allows only localhost:5173 and localhost:8080, and 5173 is taken by another project. Proxying
// /api keeps the browser on one origin, so CORS never comes into it and the service needs no
// restart and no CORS_ORIGINS change. `api-url.ts` returns a relative path as-is, so /api works.
//
// Nothing in the build references this file; deleting it costs only the shortcut.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  server: {
    host: true,
    port: 5175,
    strictPort: true,
    proxy: {
      // 127.0.0.1, not localhost: the service listens on IPv4 and localhost can resolve to ::1.
      '/api': { target: 'http://127.0.0.1:3030', changeOrigin: true },
    },
  },
})
