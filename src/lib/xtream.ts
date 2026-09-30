/**
 * Xtream Codes API (player_api.php): the account behind many IPTV playlists. It knows much more
 * about movies and series than the M3U (plot, genre, cast, rating, runtime, backdrop), plus the
 * subscription status.
 *
 * The account is either entered in the settings, or detected: from a get.php?username=&password=
 * playlist URL, or from Xtream-style stream URLs in the playlist (/movie/USER/PASS/123.mkv).
 */
export interface XtreamAccount {
  /** e.g. http://server:8080, without a trailing slash. */
  server: string;
  username: string;
  password: string;
}

export interface XtreamAccountInfo {
  status: string;
  /** Epoch ms, or null for subscriptions without an end date. */
  expiresAt: number | null;
  isTrial: boolean;
  maxConnections: number;
  activeConnections: number;
}

/** Normalizes what people paste: "server:8080", "http://server:8080/", ".../player_api.php". */
export function normalizeServer(input: string): string {
  let server = input.trim();
  if (!server) return '';
  if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
  return server.replace(/\/(player_api|get|xmltv)\.php.*$/i, '').replace(/\/+$/, '');
}

export function isComplete(account: XtreamAccount | null | undefined): account is XtreamAccount {
  return !!account && !!account.server && !!account.username && !!account.password;
}

/** Stream URLs of Xtream panels: /live|movie|series/USER/PASS/ID.ext, or /USER/PASS/ID for live TV. */
const STREAM_PATH = /^(.*?)\/(?:(?:live|movie|series)\/)?([^/]+)\/([^/]+)\/\d+(?:\.\w+)?$/i;

/** Finds the account from the playlist URL, or else from the playlist's stream URLs. */
export function detectAccount(playlistUrl: string, streamUrls: string[]): XtreamAccount | null {
  try {
    const url = new URL(playlistUrl);
    const username = url.searchParams.get('username');
    const password = url.searchParams.get('password');
    if (/\/get\.php$/i.test(url.pathname) && username && password) {
      return { server: url.origin + url.pathname.replace(/\/get\.php$/i, ''), username, password };
    }
  } catch {
    // Not a URL: fall through to the stream URLs.
  }
  for (const streamUrl of streamUrls) {
    try {
      const url = new URL(streamUrl);
      const m = STREAM_PATH.exec(url.pathname);
      if (m) return { server: url.origin + m[1], username: decodeURIComponent(m[2]), password: decodeURIComponent(m[3]) };
    } catch {
      // Try the next one.
    }
  }
  return null;
}

/**
 * A stream URL without the account in it: http://server/movie/USER/PASS/1.mkv →
 * http://server/movie/1.mkv. Favorites and watch progress use this, so they survive a new
 * password. URLs without these credentials stay as they are.
 */
export function withoutCredentials(url: string, account: XtreamAccount | null): string {
  if (!account?.username || !account.password) return url;
  return url.replace(`/${account.username}/${account.password}/`, '/');
}

/** The player_api.php URL for an action (none: account info). */
export function apiUrl(account: XtreamAccount, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ username: account.username, password: account.password, ...params });
  return `${account.server}/player_api.php?${query}`;
}

export class XtreamError extends Error {}

/** Checks the login and returns the subscription details. Throws XtreamError with a readable message. */
export async function fetchAccountInfo(account: XtreamAccount, fetchUrl: (url: string) => string): Promise<XtreamAccountInfo> {
  let res: Response;
  try {
    res = await fetch(fetchUrl(apiUrl(account)), { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new XtreamError('Could not reach the server. Check the server address.');
  }
  if (!res.ok) {
    throw new XtreamError(res.status === 404 ? 'This server has no Xtream API (player_api.php not found).' : `The server answered HTTP ${res.status}.`);
  }
  let data: { user_info?: Record<string, unknown> };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new XtreamError('This server has no Xtream API (it did not answer with account data).');
  }
  const info = data.user_info;
  if (!info || Number(info.auth) !== 1) throw new XtreamError('Wrong username or password.');
  const expires = Number(info.exp_date);
  return {
    status: String(info.status ?? ''),
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires * 1000 : null,
    isTrial: String(info.is_trial) === '1',
    maxConnections: Number(info.max_connections) || 0,
    activeConnections: Number(info.active_cons) || 0,
  };
}

// ---------- Movies (VOD) ----------

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const positive = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const roundRating = (value: unknown) => {
  const n = positive(value);
  return n ? Math.round(n * 10) / 10 : null;
};

/** The provider's movie ID from a stream URL like /movie/USER/PASS/224555.mkv. */
export function movieId(streamUrl: string): string | null {
  return /\/movie\/[^/]+\/[^/]+\/(\d+)(?:\.\w+)?(?:\?|$)/.exec(streamUrl)?.[1] ?? null;
}

/** What the movie list says about each movie: enough for the cards. */
export interface VodSummary {
  /** 0–10, or null when the provider has none. */
  rating: number | null;
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new XtreamError('Could not reach the Xtream server.');
  }
  if (!res.ok) throw new XtreamError(`The Xtream server answered HTTP ${res.status}.`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new XtreamError('The Xtream server did not answer with data.');
  }
}

/** Ratings and dates for every movie, keyed by movie ID. One request for the whole catalogue. */
export async function fetchVodSummaries(account: XtreamAccount, fetchUrl: (url: string) => string): Promise<Map<string, VodSummary>> {
  const list = await getJson<Array<{ stream_id: number | string; rating?: string | number }>>(
    fetchUrl(apiUrl(account, { action: 'get_vod_streams' })),
  );
  const summaries = new Map<string, VodSummary>();
  for (const item of Array.isArray(list) ? list : []) {
    summaries.set(String(item.stream_id), { rating: roundRating(item.rating) });
  }
  return summaries;
}

/** Everything the provider knows about one movie, for the details dialog. Missing fields are empty. */
export interface VodDetails {
  title: string;
  originalTitle: string;
  plot: string;
  genre: string;
  releaseDate: string;
  /** Seconds, or null. */
  duration: number | null;
  rating: number | null;
  director: string;
  cast: string;
  country: string;
  age: string;
  poster: string;
  backdrop: string;
  /** YouTube video ID. */
  trailer: string;
  tmdbId: string;
  /** e.g. "mkv". */
  container: string;
  /** kbit/s, or null. */
  bitrate: number | null;
}

export async function fetchVodDetails(account: XtreamAccount, id: string, fetchUrl: (url: string) => string): Promise<VodDetails> {
  const data = await getJson<{ info?: Record<string, unknown>; movie_data?: Record<string, unknown> }>(
    fetchUrl(apiUrl(account, { action: 'get_vod_info', vod_id: id })),
  );
  const info = data.info ?? {};
  const text = (...keys: string[]) => {
    for (const key of keys) {
      const value = info[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const number = (key: string) => {
    const value = Number(info[key]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const backdrops = info.backdrop_path;
  const rating = number('rating');
  return {
    title: text('name', 'o_name'),
    originalTitle: text('o_name'),
    plot: text('plot', 'description'),
    genre: text('genre'),
    releaseDate: text('releasedate', 'release_date'),
    duration: number('duration_secs') ?? (number('episode_run_time') ? number('episode_run_time')! * 60 : null),
    rating: rating ? Math.round(rating * 10) / 10 : null,
    director: text('director'),
    cast: text('cast', 'actors'),
    country: text('country'),
    age: text('age', 'mpaa_rating'),
    poster: text('cover_big', 'movie_image'),
    backdrop: Array.isArray(backdrops) && typeof backdrops[0] === 'string' ? backdrops[0] : '',
    trailer: text('youtube_trailer'),
    tmdbId: text('tmdb_id'),
    container: typeof data.movie_data?.container_extension === 'string' ? data.movie_data.container_extension : '',
    bitrate: number('bitrate'),
  };
}

// ---------- Series ----------

/** The provider's episode ID from a stream URL like /series/USER/PASS/239817.mkv. */
export function episodeId(streamUrl: string): string | null {
  return /\/series\/[^/]+\/[^/]+\/(\d+)(?:\.\w+)?(?:\?|$)/.exec(streamUrl)?.[1] ?? null;
}

/** What the series list says about each series: enough for the cards. */
export interface SeriesSummary {
  id: string;
  rating: number | null;
  cover: string;
  year: number | null;
}

/**
 * Every series, keyed by `seriesKey(category name, series name)`, the same key the playlist's
 * episodes group into. Two requests for the whole catalogue: the categories and the list.
 */
export async function fetchSeriesSummaries(
  account: XtreamAccount,
  fetchUrl: (url: string) => string,
  keyOf: (group: string, name: string) => string,
): Promise<Map<string, SeriesSummary>> {
  const [categories, list] = await Promise.all([
    getJson<Array<{ category_id: string | number; category_name?: string }>>(fetchUrl(apiUrl(account, { action: 'get_series_categories' }))),
    getJson<Array<Record<string, unknown>>>(fetchUrl(apiUrl(account, { action: 'get_series' }))),
  ]);
  const names = new Map((Array.isArray(categories) ? categories : []).map((c) => [String(c.category_id), text(c.category_name)]));
  const summaries = new Map<string, SeriesSummary>();
  for (const item of Array.isArray(list) ? list : []) {
    const name = text(item.name);
    if (!name) continue;
    const year = Number(/^(\d{4})/.exec(text(item.releaseDate) || text(item.release_date))?.[1]);
    summaries.set(keyOf(names.get(String(item.category_id)) ?? '', name), {
      id: String(item.series_id),
      rating: roundRating(item.rating),
      cover: text(item.cover),
      year: year || null,
    });
  }
  return summaries;
}

export interface EpisodeInfo {
  /** As the provider has it, e.g. "Breaking Bad - S01E01 - Pilot". */
  title: string;
  plot: string;
  /** Seconds, or null. */
  duration: number | null;
  /** A still from the episode. */
  image: string;
  airDate: string;
}

/** Everything the provider knows about one series, and its episodes keyed by episode ID. */
export interface SeriesDetails {
  plot: string;
  genre: string;
  releaseDate: string;
  rating: number | null;
  director: string;
  cast: string;
  cover: string;
  backdrop: string;
  trailer: string;
  tmdbId: string;
  episodes: Map<string, EpisodeInfo>;
}

export async function fetchSeriesDetails(account: XtreamAccount, id: string, fetchUrl: (url: string) => string): Promise<SeriesDetails> {
  const data = await getJson<{ info?: Record<string, unknown>; episodes?: Record<string, Array<Record<string, unknown>>> | unknown[] }>(
    fetchUrl(apiUrl(account, { action: 'get_series_info', series_id: id })),
  );
  const info = data.info ?? {};
  const episodes = new Map<string, EpisodeInfo>();
  // An object of seasons ({"1": [...]}), or an empty array when there are none.
  for (const season of Object.values(data.episodes ?? {}) as unknown[]) {
    for (const ep of Array.isArray(season) ? (season as Record<string, unknown>[]) : []) {
      const epInfo = (ep.info ?? {}) as Record<string, unknown>;
      episodes.set(String(ep.id), {
        title: text(ep.title),
        plot: text(epInfo.plot),
        duration: positive(epInfo.duration_secs),
        image: text(epInfo.movie_image),
        airDate: text(epInfo.air_date) || text(epInfo.releasedate),
      });
    }
  }
  const backdrops = info.backdrop_path;
  return {
    plot: text(info.plot),
    genre: text(info.genre),
    releaseDate: text(info.releaseDate) || text(info.release_date),
    rating: roundRating(info.rating),
    director: text(info.director),
    cast: text(info.cast),
    cover: text(info.cover),
    backdrop: Array.isArray(backdrops) && typeof backdrops[0] === 'string' ? backdrops[0] : '',
    trailer: text(info.youtube_trailer),
    tmdbId: text(info.tmdb),
    episodes,
  };
}
