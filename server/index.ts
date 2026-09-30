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
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, renameSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { format } from 'node:util';
import { sendError } from './http.ts';
import { DATA_DIR, DIST_DIR, PACKAGED, VERSION } from './paths.ts';
import { handleServices } from './services.ts';
import { VERSION_PATH } from './version.ts';

// Bind to localhost only: the proxy will fetch any URL it is given.
const HOST = process.env.HOST ?? '127.0.0.1';
// 5173 is where the app has always run, so saved settings and favorites (stored per origin) carry over.
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : (process.env.PORT ?? 5173));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid port "${portArg > 0 ? process.argv[portArg + 1] : process.env.PORT}": use a number from 1 to 65535.`);
  process.exit(1);
}
const URL_ = `http://${HOST}:${PORT}/`;
const OPEN = process.argv.includes('--open');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_CHECK_MS = 60 * 60 * 1000;

// An installed server runs without a console (conhost --headless), so it logs to a file.
if (PACKAGED) {
  const logFile = path.join(DATA_DIR, 'server.log');
  /** Starts a new log once it's large; the previous one is kept as server.old.log. */
  const rotate = () => {
    try {
      if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, path.join(DATA_DIR, 'server.old.log'));
    } catch {
      // No log yet, or it's in use: try again later.
    }
  };
  const open = () => {
    const stream = createWriteStream(logFile, { flags: 'a' });
    // A full disk or a locked file must not take the server down: logging just stops.
    stream.on('error', () => (log = null));
    return stream;
  };
  rotate();
  let log: ReturnType<typeof createWriteStream> | null = open();
  // An autostarted server runs for weeks: rotate while running, too.
  setInterval(() => {
    const size = (() => {
      try {
        return statSync(logFile).size;
      } catch {
        return 0;
      }
    })();
    if (size <= MAX_LOG_BYTES) return;
    log?.end();
    rotate();
    log = open();
  }, LOG_CHECK_MS).unref();
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      log?.write(`${new Date().toISOString()} ${format(...args)}\n`);
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

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return sendError(res, 400, 'Bad request');
  }
  const file = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(DIST_DIR + path.sep)) return sendError(res, 404, 'Not found');

  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return sendError(res, 404, 'Not found');

  res.setHeader('content-type', MIME_TYPES[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('content-length', info.size);
  // Vite fingerprints everything in assets/, so those files never change under the same name.
  res.setHeader('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.method === 'HEAD') return void res.end();
  // The file can vanish or be locked mid-read (an update replacing app files): end this response only.
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

/**
 * Opens the default browser. On Windows the address goes to explorer.exe, which hands it to the
 * running Windows shell, and the shell starts the browser. It must be detached: Node kills its
 * child processes when it exits (the Start-menu entry exits right after this), and anything
 * started inside the headless console would die with it.
 */
function openBrowser(): void {
  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [URL_]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [URL_]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
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
  handleServices(req, res, () => {
    serveStatic(req, res).catch((err: Error) => sendError(res, 500, err.message));
  });
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
