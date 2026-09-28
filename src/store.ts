import { get, set } from 'idb-keyval';
import type { Guide } from './lib/epg';

export interface Settings {
  playlistUrl: string;
  useProxy: boolean;
  /** Overrides the auto-detected guide URL; empty means auto. */
  epgUrl: string;
}

export interface CachedPlaylist {
  url: string;
  text: string;
  fetchedAt: number;
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
  localStorage.setItem(key, JSON.stringify(value));
}

export const store = {
  getSettings: (): Settings => ({
    playlistUrl: '',
    useProxy: true,
    epgUrl: '',
    ...readJson<Partial<Settings>>(KEYS.settings, {}),
  }),
  saveSettings: (settings: Settings) => writeJson(KEYS.settings, settings),

  getFavorites: () => new Set(readJson<string[]>(KEYS.favorites, [])),
  saveFavorites: (favorites: Set<string>) => writeJson(KEYS.favorites, [...favorites]),

  getLastChannel: () => readJson<string | null>(KEYS.lastChannel, null),
  setLastChannel: (url: string) => writeJson(KEYS.lastChannel, url),

  getFilter: () => readJson<{ country: string; category: string } | null>(KEYS.filter, null),
  setFilter: (country: string, category: string) => writeJson(KEYS.filter, { country, category }),

  getSidebarCollapsed: () => readJson(KEYS.sidebarCollapsed, false),
  setSidebarCollapsed: (collapsed: boolean) => writeJson(KEYS.sidebarCollapsed, collapsed),

  getVolume: () => readJson(KEYS.volume, { volume: 1, muted: false }),
  setVolume: (volume: number, muted: boolean) => writeJson(KEYS.volume, { volume, muted }),

  // Playlists can be several MB, too large for localStorage, so they live in IndexedDB.
  getCachedPlaylist: () => get<CachedPlaylist>('playlist'),
  cachePlaylist: (playlist: CachedPlaylist) => set('playlist', playlist),

  getCachedGuide: () => get<CachedGuide>('guide'),
  cacheGuide: (guide: CachedGuide) => set('guide', guide),
};
