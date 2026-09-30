import { defineConfig } from 'vite';
import { ipmanServices } from './server/services.ts';

export default defineConfig({
  plugins: [ipmanServices()],
  // Bind to localhost only: the proxy will fetch any URL it is given.
  // 5173 belongs to the standalone server (npm start); the dev server runs next to it.
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173 },
  // hls.js + mpegts.js are ~250 kB gzipped; irrelevant for a locally served app.
  build: { chunkSizeWarningLimit: 1200 },
});
