/**
 * Where the server finds its files. Two layouts:
 *
 * - Installed package (install.ps1): everything bundled into app/server.mjs, next to app/dist/
 *   and app/version.json; ffmpeg in ../ffmpeg/; cache and log in %LOCALAPPDATA%\ipman.
 * - Project checkout (npm start / npm run dev): server/*.ts, the frontend in ../dist/, cache in
 *   ../.cache/, ffmpeg from the PATH.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;

/** True when running from an installed package rather than a project checkout. */
export const PACKAGED = existsSync(path.join(here, 'version.json')) && existsSync(path.join(here, 'dist', 'index.html'));

const PROJECT_ROOT = path.resolve(here, '..');

export const DIST_DIR = PACKAGED ? path.join(here, 'dist') : path.join(PROJECT_ROOT, 'dist');

/** Cache and log. */
export const DATA_DIR = process.env.IPMAN_DATA_DIR
  ? path.resolve(process.env.IPMAN_DATA_DIR)
  : PACKAGED
    ? path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? here, 'AppData', 'Local'), 'ipman')
    : path.join(PROJECT_ROOT, '.cache');
mkdirSync(DATA_DIR, { recursive: true });

export const VERSION: string = (() => {
  try {
    const file = PACKAGED ? path.join(here, 'version.json') : path.join(PROJECT_ROOT, 'package.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

/** ffmpeg: IPMAN_FFMPEG, then the installed copy next to the app, then the PATH. */
export const FFMPEG: string = (() => {
  if (process.env.IPMAN_FFMPEG) return process.env.IPMAN_FFMPEG;
  const bundled = path.join(here, '..', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return PACKAGED && existsSync(bundled) ? bundled : 'ffmpeg';
})();
