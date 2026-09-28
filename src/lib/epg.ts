/** Path served by the guide service in server/epg.ts. */
export const EPG_PATH = '/epg';

export interface Programme {
  /** Epoch milliseconds (UTC). */
  start: number;
  stop: number;
  title: string;
  desc?: string;
}

/** Compact guide produced by the server from an XMLTV file. */
export interface Guide {
  fetchedAt: number;
  /** Programmes sorted by start time, keyed by lowercased XMLTV channel id. */
  programmes: Record<string, Programme[]>;
  /** normalizeName(display name) → channel id, for channels whose tvg-id doesn't match. */
  names: Record<string, string>;
}

export function epgServiceUrl(epgUrl: string, force = false): string {
  return `${EPG_PATH}?url=${encodeURIComponent(epgUrl)}${force ? '&force=1' : ''}`;
}

/**
 * Finds the guide URL: the playlist's url-tvg header if present, otherwise the Xtream
 * `xmltv.php` endpoint derived from a `get.php?username=…&password=…` playlist URL.
 */
export function guessEpgUrl(playlistUrl: string, headerUrl?: string): string | undefined {
  const fromHeader = headerUrl?.split(',')[0].trim();
  if (fromHeader) return fromHeader;
  try {
    const url = new URL(playlistUrl);
    const username = url.searchParams.get('username');
    const password = url.searchParams.get('password');
    if (!url.pathname.endsWith('/get.php') || !username || !password) return undefined;
    const xmltv = new URL('xmltv.php', url);
    xmltv.search = new URLSearchParams({ username, password }).toString();
    return xmltv.href;
  } catch {
    return undefined;
  }
}

/** Normalizes a channel name for fuzzy matching: "NO: TV 2 Sport 1 HD" → "tv2sport1". */
export function normalizeName(name: string): string {
  return name
    .replace(/^\s*(\|[^|]*\||\[[^\]]*\]|[A-Z]{2,3}\s*[:|])\s*/, '') // Provider prefixes: "|NO|", "[NO]", "NO:"
    .toLowerCase()
    .replace(/\b(uhd|fhd|hd|sd|4k|hevc|h\.?265|backup)\b/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function programmesFor(guide: Guide, channel: { name: string; tvgId?: string }): Programme[] | undefined {
  const byId = channel.tvgId && guide.programmes[channel.tvgId.toLowerCase()];
  if (byId) return byId;
  const id = guide.names[normalizeName(channel.name)];
  return id ? guide.programmes[id] : undefined;
}

export function nowAndNext(programmes: Programme[] | undefined, time = Date.now()): { now?: Programme; next?: Programme } {
  if (!programmes) return {};
  const i = programmes.findIndex((p) => p.stop > time);
  if (i === -1) return {};
  const p = programmes[i];
  return p.start <= time ? { now: p, next: programmes[i + 1] } : { next: p };
}

/** 0–1 progress of a programme at the given time. */
export function progressOf(programme: Programme, time = Date.now()): number {
  return Math.min(1, Math.max(0, (time - programme.start) / (programme.stop - programme.start)));
}
