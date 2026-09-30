/**
 * Series from the playlist. The M3U lists every episode as its own entry, named like
 * "SE:Trespasses (2025) S01 E01"; grouping them by name and category gives the series with
 * their seasons and episodes, no Xtream account needed.
 */
import type { Channel } from './m3u';

export interface Episode {
  channel: Channel;
  season: number;
  episode: number;
}

export interface Season {
  number: number;
  episodes: Episode[];
}

export interface Series {
  /** Category and name: unique within the playlist, and stable (favorites use it). */
  key: string;
  /** The playlist's name without the episode number: "SE:Trespasses (2025)". */
  name: string;
  group: string;
  /** In watching order: season 1, 2, …, specials (season 0) last. */
  seasons: Season[];
  episodeCount: number;
  /** The first episode's image from the playlist (often a still, sometimes the poster). */
  logo?: string;
}

// "Name S01 E01", "Name S01E01", "Name - S2022 E05", "Name S-3 E03" (sic).
const EPISODE = /^(.*?)\s*[-–:]?\s*S(-?\d{1,4})\s*E(\d{1,4})\b/i;

export function parseEpisodeName(name: string): { series: string; season: number; episode: number } | null {
  const m = EPISODE.exec(name);
  if (!m || !m[1].trim()) return null;
  return { series: m[1].trim(), season: Math.abs(Number(m[2])), episode: Number(m[3]) };
}

export const seriesKey = (group: string, name: string) => `${group.trim()}\n${name.trim()}`;

export function buildSeries(episodes: Channel[]): Series[] {
  const byKey = new Map<string, { series: Series; episodes: Episode[] }>();
  for (const channel of episodes) {
    const parsed = parseEpisodeName(channel.name);
    const name = parsed?.series ?? channel.name.trim();
    const key = seriesKey(channel.group, name);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { series: { key, name, group: channel.group, seasons: [], episodeCount: 0, logo: channel.logo }, episodes: [] };
      byKey.set(key, entry);
    }
    // Names without a number: keep the playlist order within season 1.
    entry.episodes.push({ channel, season: parsed?.season ?? 1, episode: parsed?.episode ?? entry.episodes.length + 1 });
  }

  const order = (season: number) => (season === 0 ? Infinity : season);
  const result: Series[] = [];
  for (const { series, episodes: list } of byKey.values()) {
    const seasons = new Map<number, Episode[]>();
    for (const ep of list) {
      const season = seasons.get(ep.season) ?? [];
      season.push(ep);
      seasons.set(ep.season, season);
    }
    series.seasons = [...seasons]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([number, eps]) => ({ number, episodes: eps.sort((a, b) => a.episode - b.episode) }));
    series.episodeCount = list.length;
    result.push(series);
  }
  return result;
}

/** Every episode in watching order. */
export const allEpisodes = (series: Series) => series.seasons.flatMap((s) => s.episodes);

export const seasonName = (number: number) => (number === 0 ? 'Specials' : `Season ${number}`);

/** "S2 E5" */
export const episodeCode = (ep: Episode) => (ep.season === 0 ? `Special ${ep.episode}` : `S${ep.season} E${ep.episode}`);

/**
 * The episode title from the Xtream API, without the series name and number around it:
 * "Breaking Bad (ES) - S01E01 - Pilot" → "Pilot". Placeholders like "Episode 1" → "".
 */
export function cleanEpisodeTitle(title: string): string {
  const m = /S\d{1,4}\s*E\d{1,4}\s*[-–:]?\s*(.*)$/i.exec(title);
  const clean = (m ? m[1] : title).trim();
  return /^(episode|episodio|épisode|avsnitt|afsnit|jakso|folge|aflevering|odcinek)\s*\d+$/i.test(clean) ? '' : clean;
}

// ---------- Watch progress ----------

export interface WatchProgress {
  /** Seconds. */
  position: number;
  duration: number;
  /** Epoch ms. */
  updatedAt: number;
}

/** Watched to the end credits: the last 10% or 90 seconds, whichever is less. */
export const isFinished = (p: WatchProgress) => p.duration - p.position <= Math.min(90, p.duration * 0.1);

/** How much of the episode's bar to fill: 0–1, full once finished. */
export const watchedFraction = (p: WatchProgress | undefined) =>
  !p || !p.duration ? 0 : isFinished(p) ? 1 : Math.min(1, Math.max(0, p.position / p.duration));

export interface ResumeTarget {
  episode: Episode;
  /** Seconds into the episode. */
  startAt: number;
  kind: 'resume' | 'start' | 'again';
}

/**
 * What "Resume watching" plays: the episode watched last, where it was left; the next one if
 * that was finished; the first episode for a new series (or when everything has been watched).
 */
export function resumeTarget(series: Series, progressOf: (episode: Episode) => WatchProgress | undefined): ResumeTarget | null {
  const episodes = allEpisodes(series);
  if (!episodes.length) return null;
  let last = -1;
  let lastAt = 0;
  episodes.forEach((ep, i) => {
    const p = progressOf(ep);
    if (p && p.updatedAt > lastAt) {
      last = i;
      lastAt = p.updatedAt;
    }
  });
  if (last === -1) return { episode: episodes[0], startAt: 0, kind: 'start' };
  const p = progressOf(episodes[last])!;
  if (!isFinished(p)) return { episode: episodes[last], startAt: Math.max(0, p.position - 5), kind: 'resume' };
  const next = episodes[last + 1];
  if (!next) return { episode: episodes[0], startAt: 0, kind: 'again' };
  // The next episode may have been started before (watched out of order).
  const np = progressOf(next);
  return { episode: next, startAt: np && !isFinished(np) ? Math.max(0, np.position - 5) : 0, kind: 'resume' };
}
