import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // The browser code needs a DOM; the serverless handlers must NOT have one.
    // Running api/** under jsdom puts Node's Buffer and jsdom's Uint8Array in
    // different realms, so `buffer instanceof Uint8Array` is false — which is
    // exactly the check Stripe's webhook verification makes. Tests would then
    // exercise a code path that never happens on Vercel.
    environment: 'jsdom',
    environmentMatchGlobs: [['api/**', 'node']],
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'api/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'api/**/*.ts'],
    },
  },
});
