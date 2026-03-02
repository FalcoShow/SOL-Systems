// ============================================================
//  SOL SYSTEMS — Vite Config (updated)
//  File: dashboard/vite.config.js
//
//  Updated from the original to add:
//    - Production build optimizations
//    - Manual chunk splitting (keeps vendor bundle separate)
//    - Source maps disabled in production (smaller build)
// ============================================================

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
  },

  build: {
    // Disable source maps in production — smaller bundle,
    // no source code exposure in public Netlify deployment
    sourcemap: false,

    // Warn if any chunk exceeds 600KB
    chunkSizeWarningLimit: 600,

    rollupOptions: {
      output: {
        // Split vendor libraries into separate cached chunks.
        // React + ReactDOM rarely change → long cache lifetime.
        // Recharts is large → separate chunk so page JS stays small.
        manualChunks: {
          'vendor-react':    ['react', 'react-dom', 'react-router-dom'],
          'vendor-recharts': ['recharts'],
        },
      },
    },
  },
})