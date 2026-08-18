// Temporary dev-only config: plain HTTP (no basic-ssl), bound to all hosts.
// Created to test the Knowledge UI without the self-signed-cert friction.
// Safe to delete — your real vite.config.ts is untouched.
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
    port: 5173,
  },
})
