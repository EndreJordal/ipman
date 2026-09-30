/**
 * How far each movie and episode has been watched, in localStorage. Keyed by the stream URL
 * without the account in it (see withoutCredentials), so a new password keeps the progress.
 * Feeds "Resume", the blue bars and "Continue watching".
 */
import { isFinished, type WatchProgress } from './lib/series';

const KEY = 'ipman.progress';
/** Enough for years of watching; the oldest entries go first. */
const MAX_ENTRIES = 5000;
/** Less than this watched counts as not started: no "Resume at 0:04". */
const MIN_RESUME_S = 10;

type Entry = [position: number, duration: number, updatedAt: number];

let entries: Map<string, Entry> | null = null;

function load(): Map<string, Entry> {
  if (entries) return entries;
  try {
    entries = new Map(Object.entries(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Entry>));
  } catch {
    entries = new Map();
  }
  return entries;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(load())));
  } catch {
    // Storage full: progress is a convenience, keep playing.
  }
}

const toProgress = (entry: Entry): WatchProgress => ({ position: entry[0], duration: entry[1], updatedAt: entry[2] });

export const progress = {
  get(key: string): WatchProgress | undefined {
    const entry = load().get(key);
    return entry && toProgress(entry);
  },

  set(key: string, position: number, duration: number): void {
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
    const map = load();
    map.delete(key); // re-insert: the map stays in last-watched order
    map.set(key, [Math.round(position), Math.round(duration), Date.now()]);
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
    save();
  },

  /** Everything watched, most recent first. */
  entries(): [key: string, progress: WatchProgress][] {
    return [...load()].reverse().map(([key, entry]) => [key, toProgress(entry)]);
  },

  /** Re-keys entries saved under an older key format (URLs with the password in them). */
  migrate(rekey: (key: string) => string): void {
    const map = load();
    let changed = false;
    for (const [key, entry] of [...map]) {
      const next = rekey(key);
      if (next === key) continue;
      map.delete(key);
      if (!map.has(next)) map.set(next, entry);
      changed = true;
    }
    if (changed) save();
  },
};

/** Started but not finished: worth a "Resume". */
export function inProgress(p: WatchProgress | undefined): p is WatchProgress {
  return !!p && p.position >= MIN_RESUME_S && !isFinished(p);
}

/** Where to start a movie or episode: a few seconds before where it was left, or the beginning. */
export function startPosition(p: WatchProgress | undefined): number {
  return inProgress(p) ? Math.max(0, p.position - 5) : 0;
}
