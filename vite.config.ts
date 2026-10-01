/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // Pinned so the suite does not read the operator's `.env.local`. `USE_API` falls back to
    // `VITE_USE_API` when no data mode is stored, and jsdom starts with an empty localStorage —
    // so setting that flag on a real box silently swapped every mock-backed render test onto the
    // API repository and failed thirteen of them. Tests decide their own mode; `live-api.test.tsx`
    // opts in by writing `lyra:data-mode` before its imports run.
    env: { VITE_USE_API: 'false' },
  },
  plugins: [
    react(),
    tailwindcss(),
    basicSsl(),
    VitePWA({
      devOptions: { enabled: false },
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.svg', 'icon-512.svg'],
      manifest: {
        name: 'Life-OS',
        short_name: 'Life-OS',
        description: 'Self-hosted life management system',
        theme_color: '#18181b',
        background_color: '#09090b',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.ics$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'ical-feeds',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    // The dev server is HTTPS (`basicSsl` above), and the API is plain HTTP on :3001. A page
    // served over HTTPS calling `http://localhost:3001` is mixed content, which some browsers
    // block outright and others only tolerate because localhost is a trustworthy origin — a
    // difference nobody should have to discover.
    //
    // Proxying makes the API same-origin in dev, which is also what it is in production: one
    // binary serves the UI and the API from one port, so `/api` is the correct path in both and
    // the dev loop stops being a special case.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // The dev server's own certificate is self-signed; this is about the *upstream*, which
        // is plain HTTP and has no certificate to verify.
        secure: false,
        // The queue and the agents page hold a socket open.
        ws: true,
      },
    },
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          'vendor-ui': ['radix-ui', 'class-variance-authority', 'clsx', 'tailwind-merge', 'lucide-react'],
          'vendor-data': ['@tanstack/react-query', 'zustand', 'zod', 'react-hook-form', '@hookform/resolvers'],
          'vendor-charts': ['recharts'],
          'vendor-maps': ['maplibre-gl'],
          'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
        },
      },
    },
  },
})
