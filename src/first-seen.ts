/**
 * When ipman first saw each movie or series in the playlist: "Recently added" for playlists
 * without an Xtream account (which has the provider's own dates). A series counts as updated
 * when its number of episodes grows.
 *
 * Kept in IndexedDB per section. On the first run, or when most of the playlist is unknown
 * (another provider), everything already there counts as old: time 0.
 */
import { get, set } from 'idb-keyval';

interface Stored {
  /** key → [first seen or last updated (ms, 0 = was there from the start), marker (episodes)] */
  items: Record<string, [at: number, marker: number]>;
}

/**
 * Records the playlist's items, given as [key, marker] (a series' episode count; 0 for movies),
 * and returns each key's time, 0 for "already there".
 */
export async function trackFirstSeen(section: 'movie' | 'series', entries: [key: string, marker: number][], now = Date.now()): Promise<Map<string, number>> {
  const storeKey = `firstSeen.${section}`;
  const stored = await get<Stored>(storeKey).catch(() => undefined);
  const old = stored?.items ?? {};
  const oldCount = Object.keys(old).length;
  const known = entries.reduce((n, [key]) => n + (key in old ? 1 : 0), 0);
  const fresh = !stored || known < entries.length / 2;

  const items: Stored['items'] = {};
  let changed = fresh || known !== oldCount;
  for (const [key, marker] of entries) {
    const prev = fresh ? undefined : old[key];
    if (!prev) {
      items[key] = [fresh ? 0 : now, marker];
      changed ||= !fresh;
    } else if (marker > prev[1]) {
      items[key] = [now, marker];
      changed = true;
    } else {
      items[key] = prev;
    }
  }
  // Items gone from the playlist are forgotten, unless most of it vanished at once: then it's
  // more likely a provider hiccup, and they'd all look new when they came back.
  if (!fresh && oldCount - known > oldCount / 2) {
    for (const [key, value] of Object.entries(old)) items[key] ??= value;
  }
  if (changed) await set(storeKey, { items } satisfies Stored).catch((err: Error) => console.warn(`[${section}] could not save first-seen dates: ${err.message}`));
  return new Map(entries.map(([key]) => [key, items[key][0]]));
}
