import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { landingPage, publicContactUrl } from './web/landing.js';
const environmentRoot = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig(({ mode }) => ({
  envDir: environmentRoot,
  root: 'web',
  plugins: [
    {
      name: 'prerender-public-landing',
      apply: 'build',
      transformIndexHtml(html) {
        const env = loadEnv(mode, environmentRoot, 'VITE_');
        const contact = publicContactUrl(process.env.VITE_CONTACT_URL ?? env.VITE_CONTACT_URL);
        return html.replace(
          '<div id="app"><p class="startup">Carregando Blackout Create…</p></div>',
          `<div id="app">${landingPage(contact)}</div>`,
        );
      },
    },
  ],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
}));
