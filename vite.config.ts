import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
