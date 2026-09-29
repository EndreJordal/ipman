/**
 * Standalone ipman server: serves the built app from dist/ together with the stream proxy,
 * TV guide, audio conversion, movie info and version services, without Vite.
 *
 * Runs from a project checkout (`npm start`, which builds dist/ first) or from an installed
 * package (install.ps1, where everything is bundled into app/server.mjs; see server/paths.ts).
 *
 * --open: open ipman in the browser once it's up. If ipman is already running, just open the
 * browser (that's what the Start-menu entry does).
 */
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, renameSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { format } from 'node:util';
import { epgMiddleware } from './epg.ts';
import { vodInfoMiddleware } from './mkv-subtitles.ts';
import { DATA_DIR, DIST_DIR, PACKAGED, VERSION } from './paths.ts';
import { proxyMiddleware } from './proxy.ts';
import { transcodeMiddleware } from './transcode.ts';
import { VERSION_PATH, versionMiddleware } from './version.ts';

// Bind to localhost only: the proxy will fetch any URL it is given.
const HOST = process.env.HOST ?? '127.0.0.1';
// 5173 is where the app has always run, so saved settings and favorites (stored per origin) carry over.
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : (process.env.PORT ?? 5173));
const URL_ = `http://${HOST}:${PORT}/`;
const OPEN = process.argv.includes('--open');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// An installed server runs without a console (conhost --headless), so it logs to a file.
if (PACKAGED) {
  const logFile = path.join(DATA_DIR, 'server.log');
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, path.join(DATA_DIR, 'server.old.log'));
  } catch {
    // No log yet.
  }
  const log = createWriteStream(logFile, { flags: 'a' });
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      log.write(`${new Date().toISOString()} ${format(...args)}\n`);
      original(...args);
    };
  }
}

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
  const file = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(DIST_DIR + path.sep)) return sendStatus(res, 404, 'Not found');

  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return sendStatus(res, 404, 'Not found');

  res.setHeader('content-type', MIME_TYPES[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('content-length', info.size);
  // Vite fingerprints everything in assets/, so those files never change under the same name.
  res.setHeader('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

/** Opens the default browser without a console window (rundll32 is a signed Windows binary). */
function openBrowser(): void {
  if (process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', URL_], { windowsHide: true });
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [URL_]);
}

/** Whether the program on our port is ipman (and not something else). */
async function ipmanAlreadyRunning(): Promise<boolean> {
  try {
    const res = await fetch(new URL(VERSION_PATH, URL_), { signal: AbortSignal.timeout(2000) });
    return res.ok && typeof ((await res.json()) as { version?: unknown }).version === 'string';
  } catch {
    return false;
  }
}

if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
  console.error('dist/ is missing. Run `npm run build` first (`npm start` does this for you).');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  proxyMiddleware(req, res, () =>
    epgMiddleware(req, res, () =>
      transcodeMiddleware(req, res, () =>
        vodInfoMiddleware(req, res, () =>
          versionMiddleware(req, res, () => {
            serveStatic(req, res).catch((err: Error) => sendStatus(res, 500, err.message));
          }),
        ),
      ),
    ),
  );
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(err.message);
    process.exit(1);
  }
  void ipmanAlreadyRunning().then((running) => {
    if (running && OPEN) {
      openBrowser();
      process.exit(0);
    }
    console.error(
      running
        ? `ipman is already running at ${URL_}`
        : `Port ${PORT} is already in use by another program. Is ipman's dev server running?`,
    );
    process.exit(1);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ipman ${VERSION} running at ${URL_}${PACKAGED ? ` (data: ${DATA_DIR})` : ''}`);
  if (OPEN) openBrowser();
});
