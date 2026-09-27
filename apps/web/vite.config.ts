import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(here, 'src') } },
  server: {
    port: 5173,
    // The API and the web app share an origin in production, so the dev server
    // proxies instead of enabling CORS anywhere.
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/openapi.json': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/docs': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  // INLET_WEB_OUT_DIR lets a slotted end-to-end run (scripts/e2e-server.mjs) build into its own
  // directory, so its build never empties the one another run's server is serving.
  build: { outDir: process.env.INLET_WEB_OUT_DIR || 'dist', sourcemap: true },
});
