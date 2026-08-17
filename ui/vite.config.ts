import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

// The built app is served by the local server in src/server/, which resolves
// its static root relative to its own module URL. Building into
// src/server/static keeps one path working for both the source tree and dist.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../src/server/static',
    emptyOutDir: true,
    rollupOptions: {
      // Two pages, deliberately unlinked: index.html is the existing
      // derived-architecture dashboard (App.tsx), workspace.html is the new
      // three-region shell (WorkspaceShell.tsx). Neither imports the other.
      input: {
        main: resolve(root, 'index.html'),
        workspace: resolve(root, 'workspace.html'),
      },
    },
  },
  server: {
    // `npm --prefix ui run dev` proxies the API to a running CLI instance.
    proxy: {
      '/api': 'http://127.0.0.1:5173',
    },
  },
});
