/**
 * GET /version[?check=1]: the running version and, when asked, whether a newer release exists.
 *
 * The check only contacts GitHub when the browser passes check=1 (the "Check for updates"
 * setting), at most every 12 hours. Failures (offline, rate limit) are silent.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathOf, sendError } from './http.ts';
import { currentVersion, PACKAGED } from './paths.ts';

export const VERSION_PATH = '/version';
const REPO = 'EndreJordal/ipman';
const RELEASES_API = process.env.IPMAN_RELEASES_API ?? `https://api.github.com/repos/${REPO}/releases/latest`;
/** Running the installer again updates in place, keeping settings. */
export const INSTALL_COMMAND = `irm https://github.com/${REPO}/releases/latest/download/install.ps1 | iex`;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 8000;

interface Latest {
  version: string;
  url: string;
  checkedAt: number;
}

let latest: Latest | null = null;
let checking: Promise<void> | null = null;

/** Compares "1.2.3" style versions (a leading "v" and any suffix are ignored). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1) ?? ['0', '0', '0']).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `ipman/${currentVersion()}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = (await res.json()) as { tag_name: string; html_url: string };
    latest = { version: release.tag_name.replace(/^v/, ''), url: release.html_url, checkedAt: Date.now() };
  } catch (err) {
    console.warn(`[version] update check failed: ${(err as Error).message}`);
    // Don't retry on every page load while offline.
    latest = latest ? { ...latest, checkedAt: Date.now() } : null;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Running from source (dev server, npm start) is the newest code by definition: no update check.
  const check = PACKAGED && new URL(req.url ?? '', 'http://localhost').searchParams.get('check') === '1';
  if (check && (!latest || Date.now() - latest.checkedAt > CHECK_INTERVAL_MS)) {
    checking ??= refresh().finally(() => (checking = null));
    await checking;
  }
  const version = currentVersion();
  const updateAvailable = PACKAGED && !!latest && compareVersions(latest.version, version) > 0;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(
    JSON.stringify({
      version,
      packaged: PACKAGED,
      latest: latest?.version ?? null,
      releaseUrl: latest?.url ?? null,
      updateAvailable,
      installCommand: INSTALL_COMMAND,
    }),
  );
}

export function versionMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (pathOf(req) !== VERSION_PATH) return next();
  handle(req, res).catch((err: Error) => sendError(res, 500, err.message));
}
