import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The panel is served by the agent's own Express app, so the build lands in
 * ../public-ui and is mounted at /ui. During development the dev server proxies
 * /api to the running agent, which keeps the same-origin cookie session working.
 */
export default defineConfig({
  plugins: [react()],
  base: '/ui/',
  build: { outDir: '../public-ui', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/login': 'http://127.0.0.1:8787',
      '/logout': 'http://127.0.0.1:8787',
    },
  },
});
