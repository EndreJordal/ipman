/**
 * Standalone ipman server: serves the built app from dist/ together with the stream proxy
 * and TV guide service, without Vite. Started by `npm start`, which builds dist/ first.
 */
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { epgMiddleware } from './epg.ts';
import { proxyMiddleware } from './proxy.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
process.chdir(ROOT); // The guide cache in .cache/ is relative to the project root.
const DIST = path.join(ROOT, 'dist');
// Bind to localhost only: the proxy will fetch any URL it is given.
const HOST = process.env.HOST ?? '127.0.0.1';
// 5173 is where the app has always run, so saved settings and favorites (stored per origin) carry over.
const PORT = Number(process.env.PORT ?? 5173);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendStatus(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendStatus(res, 405, 'Method not allowed');

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return sendStatus(res, 400, 'Bad request');
  }
  const file = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(DIST + path.sep)) return sendStatus(res, 404, 'Not found');

  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return sendStatus(res, 404, 'Not found');

  res.setHeader('content-type', MIME_TYPES[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('content-length', info.size);
  // Vite fingerprints everything in assets/, so those files never change under the same name.
  res.setHeader('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/ is missing. Run `npm run build` first (`npm start` does this for you).');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  proxyMiddleware(req, res, () =>
    epgMiddleware(req, res, () => {
      serveStatic(req, res).catch((err: Error) => sendStatus(res, 500, err.message));
    }),
  );
});

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is ipman (or its dev server) already running?` : err.message,
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`ipman running at http://${HOST}:${PORT}`));
