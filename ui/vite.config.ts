import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built app is served by the local server in src/server/, which resolves
// its static root relative to its own module URL. Building into
// src/server/static keeps one path working for both the source tree and dist.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../src/server/static',
    emptyOutDir: true,
  },
  server: {
    // `npm --prefix ui run dev` proxies the API to a running CLI instance.
    proxy: {
      '/api': 'http://127.0.0.1:5173',
    },
  },
});
