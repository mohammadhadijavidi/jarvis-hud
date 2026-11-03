import { defineConfig } from 'vite';

const backend = process.env.JARVIS_BACKEND ?? 'http://127.0.0.1:8787';

export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/ws': { target: backend.replace(/^http/, 'ws'), ws: true } },
  },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
