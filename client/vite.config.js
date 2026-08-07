import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run client:dev` the UI runs on :5173 and proxies API + WebSocket
// traffic to the Express server on :3000, so there is no CORS to deal with.
const BACKEND = process.env.BACKEND || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
