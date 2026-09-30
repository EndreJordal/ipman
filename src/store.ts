import { get, set } from 'idb-keyval';
import type { Guide } from './lib/epg';
import type { ChannelKind } from './lib/m3u';
import type { SeriesSummary, VodSummary, XtreamAccount } from './lib/xtream';

export interface Settings {
  playlistUrl: string;
  useProxy: boolean;
  /** Overrides the auto-detected guide URL; empty means auto. */
  epgUrl: string;
  /** Overrides the account detected from the playlist; empty fields mean auto. */
  xtream: XtreamAccount;
}

export interface CachedPlaylist {
  url: string;
  text: string;
  fetchedAt: number;
}

/** A list from the Xtream API (movie ratings, series covers and IDs) for one account. */
export interface CachedSummaries<T> {
  /** Server and username it belongs to. */
  account: string;
  fetchedAt: number;
  /** [movie ID or series key, summary] */
  entries: [string, T][];
}

export interface CachedGuide {
  url: string;
  guide: Guide;
}

const KEYS = {
  settings: 'ipman.settings',
  favorites: 'ipman.favorites',
  lastChannel: 'ipman.lastChannel',
  filter: 'ipman.filter',
  volume: 'ipman.volume',
  sidebarCollapsed: 'ipman.sidebarCollapsed',
  checkUpdates: 'ipman.checkUpdates',
  skippedVersion: 'ipman.skippedVersion',
  section: 'ipman.section',
  movieSort: 'ipman.movieSort',
  seriesSort: 'ipman.seriesSort',
} as const;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage full or blocked: the setting just isn't remembered.
    console.warn(`[ipman] Could not save ${key}: ${(err as Error).message}`);
  }
}

export const store = {
  getSettings: (): Settings => ({
    playlistUrl: '',
    useProxy: true,
    epgUrl: '',
    xtream: { server: '', username: '', password: '' },
    ...readJson<Partial<Settings>>(KEYS.settings, {}),
  }),
  saveSettings: (settings: Settings) => writeJson(KEYS.settings, settings),

  getFavorites: () => new Set(readJson<string[]>(KEYS.favorites, [])),
  saveFavorites: (favorites: Set<string>) => writeJson(KEYS.favorites, [...favorites]),

  /** The last TV channel (its key), which TV resumes. Movies and series resume from their progress. */
  getLastChannel: () => readJson<string | null>(KEYS.lastChannel, null),
  setLastChannel: (key: string) => writeJson(KEYS.lastChannel, key),

  // One filter per section. TV keeps the original key, so its saved choice carries over.
  getFilter: (section: ChannelKind) =>
    readJson<{ country: string; category: string } | null>(section === 'live' ? KEYS.filter : `${KEYS.filter}.${section}`, null),
  setFilter: (section: ChannelKind, country: string, category: string) =>
    writeJson(section === 'live' ? KEYS.filter : `${KEYS.filter}.${section}`, { country, category }),

  getSection: (): ChannelKind => {
    const section = readJson<string>(KEYS.section, 'live');
    return section === 'movie' || section === 'series' ? section : 'live';
  },
  setSection: (section: ChannelKind) => writeJson(KEYS.section, section),

  getSort: (section: 'movie' | 'series') => readJson<string>(section === 'movie' ? KEYS.movieSort : KEYS.seriesSort, 'title'),
  setSort: (section: 'movie' | 'series', sort: string) => writeJson(section === 'movie' ? KEYS.movieSort : KEYS.seriesSort, sort),

  getSidebarCollapsed: () => readJson(KEYS.sidebarCollapsed, false),
  setSidebarCollapsed: (collapsed: boolean) => writeJson(KEYS.sidebarCollapsed, collapsed),

  getCheckUpdates: () => readJson(KEYS.checkUpdates, true),
  setCheckUpdates: (check: boolean) => writeJson(KEYS.checkUpdates, check),
  getSkippedVersion: () => readJson<string | null>(KEYS.skippedVersion, null),
  setSkippedVersion: (version: string) => writeJson(KEYS.skippedVersion, version),

  getVolume: () => readJson(KEYS.volume, { volume: 1, muted: false }),
  setVolume: (volume: number, muted: boolean) => writeJson(KEYS.volume, { volume, muted }),

  // Playlists can be several MB, too large for localStorage, so they live in IndexedDB.
  getCachedPlaylist: () => get<CachedPlaylist>('playlist'),
  cachePlaylist: (playlist: CachedPlaylist) => set('playlist', playlist),

  getCachedGuide: () => get<CachedGuide>('guide'),
  cacheGuide: (guide: CachedGuide) => set('guide', guide),

  // "movieSummaries", not the older "vodSummaries" (a different format).
  getCachedMovieSummaries: () => get<CachedSummaries<VodSummary>>('movieSummaries'),
  cacheMovieSummaries: (summaries: CachedSummaries<VodSummary>) => set('movieSummaries', summaries),

  getCachedSeriesSummaries: () => get<CachedSummaries<SeriesSummary>>('seriesSummaries'),
  cacheSeriesSummaries: (summaries: CachedSummaries<SeriesSummary>) => set('seriesSummaries', summaries),
};
