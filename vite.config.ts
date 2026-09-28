import { defineConfig } from 'vite';
import { epgService } from './server/epg.ts';
import { streamProxy } from './server/proxy.ts';
import { vodInfoService } from './server/mkv-subtitles.ts';
import { transcodeService } from './server/transcode.ts';

export default defineConfig({
  plugins: [streamProxy(), epgService(), transcodeService(), vodInfoService()],
  // Bind to localhost only: the proxy will fetch any URL it is given.
  // 5173 belongs to the standalone server (npm start); the dev server runs next to it.
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173 },
  // hls.js + mpegts.js are ~250 kB gzipped; irrelevant for a locally served app.
  build: { chunkSizeWarningLimit: 1200 },
});
