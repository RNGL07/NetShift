import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The app is a plain SPA served by Vercel's static hosting; everything under
// /api is handled by the serverless functions in ./api, which Vercel builds
// separately and which are therefore excluded from this bundle.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
          pdf: ['pdfjs-dist'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
