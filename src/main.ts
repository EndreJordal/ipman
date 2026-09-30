import './style.css';
import {
  epgServiceUrl,
  guessEpgUrl,
  nowAndNext,
  programmesFor,
  progressOf,
  type Guide,
  type Programme,
} from './lib/epg';
import { parseM3U, splitGroup, type Channel, type ChannelKind, type Playlist } from './lib/m3u';
import { proxyUrl } from './lib/proxy';
import { Player, type PlayerStatus } from './player';
import { store } from './store';
import { BitmapSubtitles } from './bitmap-subtitles';
import { PlayerControls } from './controls';
import { SubtitleMenu } from './subtitles';
import { VirtualList } from './virtual-list';
import { MoviesView } from './movies';
import { SeriesView } from './series';
import { buildSeries, type Series } from './lib/series';
import { progress, startPosition } from './progress';
import { initUpdates } from './updates';
import { detectAccount, withoutCredentials, type XtreamAccount } from './lib/xtream';
import { effectiveAccount, XtreamSettings } from './xtream-settings';
import { VodSubtitles } from './vod-subtitles';

const ROW_HEIGHT = 48;
const ALL = '__all__';
const FAVORITES = '__favorites__';
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/** Delay before tuning while zapping, so holding ↓ doesn't open a connection per channel. */
const ZAP_DELAY_MS = 300;
/** Re-download the guide after this long. The server keeps 16 h of programmes per download. */
const GUIDE_REFRESH_MS = 3 * 60 * 60 * 1000;
/** How often now/next info and progress bars update. */
const GUIDE_TICK_MS = 60 * 1000;
/** How often the position of a movie or episode is saved while it plays. */
const PROGRESS_SAVE_MS = 5000;
const LIVE_SEARCH = 'Search channels   /';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  app: byId<HTMLDivElement>('app'),
  settingsBtn: byId<HTMLButtonElement>('settings-btn'),
  collapseBtn: byId<HTMLButtonElement>('collapse-btn'),
  expandBtn: byId<HTMLButtonElement>('expand-btn'),
  country: byId<HTMLSelectElement>('country-select'),
  category: byId<HTMLSelectElement>('category-select'),
  search: byId<HTMLInputElement>('search'),
  count: byId<HTMLDivElement>('channel-count'),
  list: byId<HTMLDivElement>('channel-list'),
  playerWrap: byId<HTMLDivElement>('player-wrap'),
  video: byId<HTMLVideoElement>('video'),
  overlay: byId<HTMLDivElement>('overlay'),
  npLogo: byId<HTMLImageElement>('np-logo'),
  npName: byId<HTMLDivElement>('np-name'),
  npGroup: byId<HTMLDivElement>('np-group'),
  npEpg: byId<HTMLDivElement>('np-epg'),
  npStatus: byId<HTMLSpanElement>('np-status'),
  npResolution: byId<HTMLSpanElement>('np-resolution'),
  npFav: byId<HTMLButtonElement>('np-fav'),
  backBtn: byId<HTMLButtonElement>('back-btn'),
  dialog: byId<HTMLDialogElement>('settings-dialog'),
  movieDialog: byId<HTMLDialogElement>('movie-dialog'),
  seriesDialog: byId<HTMLDialogElement>('series-dialog'),
  urlInput: byId<HTMLInputElement>('playlist-url'),
  proxyInput: byId<HTMLInputElement>('use-proxy'),
  epgInput: byId<HTMLInputElement>('epg-url'),
  settingsInfo: byId<HTMLParagraphElement>('settings-info'),
};

let settings = store.getSettings();
let favorites = store.getFavorites();
let playlist: Playlist = { channels: [] };
/** The playlist's TV channels, for the channel list. */
let liveChannels: Channel[] = [];
/** The TV channel list after the dropdowns and search. */
let visible: Channel[] = [];
let current: Channel | null = null;
let lastFetchedAt: number | null = null;
let zapTimer = 0;
let guide: Guide | null = null;
/** The guide URL `guide` came from. */
let guideUrl = '';
/** Each channel's programmes, resolved once per guide/playlist pair. */
let guideIndex = new Map<Channel, Programme[]>();
let guideStatus = '';
let groupParts = new Map<string, { country: string; category: string }>();
let categoriesByCountry = new Map<string, Set<string>>();
/** TV, MOVIES or SERIES. Each section plays (and remembers) its own kind of stream. */
let section: ChannelKind = store.getSection();
/** The provider's Xtream account as found in the playlist (the settings can override it). */
let detectedXtream: XtreamAccount | null = null;

/** The Xtream account in use, or null: settings override the detected account field by field. */
function xtreamAccount(): XtreamAccount | null {
  return effectiveAccount(settings.xtream, detectedXtream);
}

/** A stream's key for favorites, progress and "last channel": its URL without the account. */
const keyOf = (channel: Channel) => withoutCredentials(channel.url, detectedXtream);
const fetchUrl = (url: string) => (settings.useProxy ? proxyUrl(url) : url);

const bitmapSubtitles = new BitmapSubtitles(els.video, byId<HTMLCanvasElement>('subtitle-canvas'));
const player = new Player(els.video, showStatus, bitmapSubtitles, new VodSubtitles(els.video));
const list = new VirtualList<Channel>(els.list, ROW_HEIGHT, renderRow);
const catalogDeps = {
  isFavorite: (key: string) => favorites.has(key),
  toggleFavorite: (key: string) => toggleFavoriteKey(key),
  keyOf,
  account: () => xtreamAccount(),
  fetchUrl,
  search: els.search,
  count: els.count,
};
/** The playlist's movies, for the MOVIES section. */
let movieList: Channel[] = [];
const movies = new MoviesView({
  ...catalogDeps,
  movies: () => movieList,
  play: (movie, startAt) => tune(movie, 0, startAt),
});
/** The playlist's series, for the SERIES section. */
let seriesList: Series[] = [];
const series = new SeriesView({
  ...catalogDeps,
  series: () => seriesList,
  play: (episode, startAt) => tune(episode, 0, startAt),
  current: () => current,
  changed: () => updateNowPlaying(),
});
// "Reload stream" keeps a movie or episode where it was (after an error too: then from the saved position).
const controls = new PlayerControls(
  els.playerWrap,
  els.video,
  () => current && tune(current, 0, current.kind === 'live' ? 0 : (playbackPosition()?.position ?? progress.get(keyOf(current))?.position ?? 0)),
  () => player.timeline(),
);
new SubtitleMenu(els.video, byId<HTMLButtonElement>('subtitle-btn'), byId<HTMLDivElement>('subtitle-menu'), bitmapSubtitles);

// ---------- Channel list ----------

function renderLogo(channel: Channel): HTMLElement {
  const placeholder = document.createElement('div');
  placeholder.className = 'logo placeholder';
  placeholder.textContent = channel.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase();
  if (!channel.logo) return placeholder;

  const img = document.createElement('img');
  img.className = 'logo';
  img.loading = 'lazy';
  img.alt = '';
  img.src = channel.logo;
  img.addEventListener('error', () => img.replaceWith(placeholder), { once: true });
  return img;
}

function renderRow(channel: Channel): HTMLElement {
  const row = document.createElement('div');
  row.className = 'channel';
  row.role = 'option';
  if (channel === current) {
    row.classList.add('active');
    row.ariaSelected = 'true';
  }

  const text = document.createElement('div');
  text.className = 'channel-text';
  const name = document.createElement('span');
  name.className = 'channel-name';
  name.textContent = channel.name;
  name.title = `${channel.name}\n${channel.group}`;
  text.append(name);

  const { now } = nowAndNext(guideIndex.get(channel));
  if (now) {
    const show = document.createElement('span');
    show.className = 'channel-now';
    show.textContent = now.title;
    show.title = describeProgramme(now);
    text.append(show, renderProgress(now));
  }

  const isFav = favorites.has(keyOf(channel));
  const star = document.createElement('button');
  star.className = isFav ? 'star on' : 'star';
  star.dataset.action = 'favorite';
  star.textContent = isFav ? '★' : '☆';
  star.title = isFav ? 'Remove from favorites' : 'Add to favorites';

  row.append(renderLogo(channel), text, star);
  return row;
}

// ---------- TV guide ----------

const formatTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const timeRange = (p: Programme) => `${formatTime(p.start)}–${formatTime(p.stop)}`;
const describeProgramme = (p: Programme) => `${timeRange(p)}  ${p.title}${p.desc ? `\n\n${p.desc}` : ''}`;

function renderProgress(programme: Programme): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('span');
  fill.style.width = `${(progressOf(programme) * 100).toFixed(1)}%`;
  bar.append(fill);
  return bar;
}

function rebuildGuideIndex(): void {
  guideIndex = new Map();
  if (!guide) return;
  for (const channel of liveChannels) {
    const programmes = programmesFor(guide, channel);
    if (programmes) guideIndex.set(channel, programmes);
  }
  guideStatus =
    `Guide: ${guideIndex.size.toLocaleString()} of ${liveChannels.length.toLocaleString()} TV channels matched` +
    ` · fetched ${new Date(guide.fetchedAt).toLocaleString()}`;
  console.info(`[ipman] ${guideStatus}`);
}

function setGuide(next: Guide | null, url: string): void {
  guide = next;
  guideUrl = next ? url : '';
  rebuildGuideIndex();
  list.refresh();
  updateNowPlaying();
}

/** Incremented per load, so an older download can't replace a newer guide. */
let guideRun = 0;
/** The guide URL being downloaded, so the minute tick doesn't start it again. */
let guideLoadingUrl = '';

async function loadGuide(force = false): Promise<void> {
  const epgUrl = settings.epgUrl || guessEpgUrl(settings.playlistUrl, playlist.epgUrl);
  // Another provider's guide doesn't fit this playlist's channels.
  if (guide && guideUrl !== epgUrl) setGuide(null, '');
  if (!epgUrl) {
    guideStatus = 'Guide: none found for this playlist. Set a guide URL above.';
    return;
  }
  if (!force && guideLoadingUrl === epgUrl) return;
  const run = ++guideRun;
  guideLoadingUrl = epgUrl;
  try {
    const cached = await store.getCachedGuide().catch(() => undefined);
    if (run !== guideRun) return;
    if (cached?.url === epgUrl && !guide) setGuide(cached.guide, epgUrl);
    if (!force && cached?.url === epgUrl && Date.now() - cached.guide.fetchedAt < GUIDE_REFRESH_MS) return;

    if (!guide) guideStatus = 'Guide: loading… (the first download can take a minute)';
    const res = await fetch(epgServiceUrl(epgUrl, force));
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const fresh = (await res.json()) as Guide;
    if (run !== guideRun) return;
    setGuide(fresh, epgUrl);
    store.cacheGuide({ url: epgUrl, guide: fresh }).catch((err: Error) => console.warn(`[ipman] Could not cache the guide: ${err.message}`));
  } catch (err) {
    if (run !== guideRun) return;
    const message = (err as Error).message;
    console.warn(`[ipman] Could not load guide: ${message}`);
    guideStatus = guide ? `${guideStatus} (refresh failed: ${message})` : `Guide: ${message}`;
  } finally {
    if (run === guideRun) guideLoadingUrl = '';
  }
}

function renderNowPlayingGuide(): void {
  const { now, next } = current ? nowAndNext(guideIndex.get(current)) : {};
  els.npEpg.hidden = !now && !next;
  els.npGroup.hidden = !els.npEpg.hidden;
  if (els.npEpg.hidden) return;

  const lines: HTMLElement[] = [];
  if (now) {
    const line = document.createElement('div');
    line.className = 'np-now';
    line.textContent = `${timeRange(now)}  ${now.title}`;
    line.title = describeProgramme(now);
    lines.push(line, renderProgress(now));
  }
  if (next) {
    const line = document.createElement('div');
    line.className = 'np-next';
    line.textContent = `Next ${formatTime(next.start)}  ${next.title}`;
    line.title = describeProgramme(next);
    lines.push(line);
  }
  els.npEpg.replaceChildren(...lines);
}

// ---------- TV: dropdowns and search ----------

function applyFilter(): void {
  const country = els.country.value;
  const category = els.category.value;
  const query = els.search.value.trim().toLowerCase();
  visible = liveChannels.filter((ch) => {
    if (country === FAVORITES) {
      if (!favorites.has(keyOf(ch))) return false;
    } else {
      const parts = groupParts.get(ch.group);
      if (country !== ALL && parts?.country !== country) return false;
      if (category !== ALL && parts?.category !== category) return false;
    }
    return !query || ch.name.toLowerCase().includes(query);
  });
  list.setItems(visible);
  showCount();
}

function showCount(): void {
  const n = visible.length;
  if (n) els.count.textContent = `${n.toLocaleString()} ${n === 1 ? 'channel' : 'channels'}`;
  else if (els.country.value === FAVORITES && !els.search.value) els.count.textContent = 'No favorites yet. Press ☆ on a channel.';
  else if (!liveChannels.length) els.count.textContent = 'This playlist has no TV channels.';
  else els.count.textContent = 'No matching channels';
  els.count.classList.remove('error');
}

function showNotice(message: string, isError = false): void {
  els.count.textContent = message;
  els.count.classList.toggle('error', isError);
}

function setOptions(select: HTMLSelectElement, options: [value: string, label: string][], preferred?: string): void {
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  select.value = options.some(([value]) => value === preferred) ? preferred! : ALL;
}

/** Fills both dropdowns from the TV groups ("Country - Category"), restoring the saved choice. */
function populateFilters(): void {
  groupParts = new Map([...new Set(liveChannels.map((ch) => ch.group))].map((g) => [g, splitGroup(g)]));
  categoriesByCountry = new Map();
  for (const { country, category } of groupParts.values()) {
    const categories = categoriesByCountry.get(country) ?? new Set<string>();
    if (category) categories.add(category);
    categoriesByCountry.set(country, categories);
  }
  // Playlists without "Country - Category" groups get a single plain group dropdown.
  const hasCategories = [...categoriesByCountry.values()].some((c) => c.size);
  els.category.hidden = !hasCategories;
  els.country.ariaLabel = hasCategories ? 'Country' : 'Group';

  const saved = store.getFilter('live');
  setOptions(
    els.country,
    [
      [ALL, hasCategories ? 'All countries' : 'All channels'],
      [FAVORITES, '★ Favorites'],
      ...[...categoriesByCountry.keys()]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .map((c): [string, string] => [c, c]),
    ],
    saved?.country,
  );
  populateCategories(saved?.category);
}

/** Categories for the selected country; for "All countries", every category name (e.g. "Sport" in any country). */
function populateCategories(preferred = els.category.value): void {
  const country = els.country.value;
  const categories =
    country === FAVORITES
      ? []
      : country === ALL
        ? [...new Set([...categoriesByCountry.values()].flatMap((c) => [...c]))]
        : [...(categoriesByCountry.get(country) ?? [])];
  setOptions(els.category, [[ALL, 'All categories'], ...categories.map((c): [string, string] => [c, c])], preferred);
  els.category.disabled = !categories.length;
}

// ---------- Playback ----------

/** @param startAt seconds into a movie or episode (resume). */
function tune(channel: Channel, delay = 0, startAt = 0): void {
  saveProgress(true); // where the previous movie or episode was left
  progressReady = false;
  current = channel;
  els.app.classList.toggle('movie-playing', channel.kind === 'movie');
  els.app.classList.toggle('series-playing', channel.kind === 'series');
  if (channel.kind === 'series') series.playing(channel);
  // TV resumes its last channel; movies and episodes resume from their progress instead.
  if (channel.kind === 'live') store.setLastChannel(keyOf(channel));
  updateNowPlaying();
  list.refresh();
  const index = visible.indexOf(channel);
  if (index >= 0) list.scrollToIndex(index);

  clearTimeout(zapTimer);
  if (delay) zapTimer = window.setTimeout(() => player.play(channel.url, settings.useProxy), delay);
  else player.play(channel.url, settings.useProxy, startAt);
}

/** Stops playback; in MOVIES and SERIES this brings back the card grid. */
function stopPlayback(): void {
  saveProgress(true);
  progressReady = false;
  clearTimeout(zapTimer);
  player.stop();
  current = null;
  els.app.classList.remove('movie-playing', 'series-playing');
  movies.refresh();
  series.refresh();
  updateNowPlaying();
  list.refresh();
}

/** TV: plays the channel watched last, if nothing plays. */
function resumeLastChannel(): void {
  if (current) return;
  const key = store.getLastChannel();
  const match = key ? liveChannels.find((ch) => keyOf(ch) === key) : undefined;
  if (match) tune(match);
}

function zap(step: number): void {
  if (!visible.length) return;
  const index = current ? visible.indexOf(current) : -1;
  const next = index === -1 ? 0 : (index + step + visible.length) % visible.length;
  tune(visible[next], ZAP_DELAY_MS);
}

/** A channel's or movie's favorite key is its stream key; an episode's is its series'. */
function favoriteKey(channel: Channel): string {
  return (channel.kind === 'series' && series.favoriteKeyOf(channel)) || keyOf(channel);
}

function toggleFavorite(channel: Channel): void {
  toggleFavoriteKey(favoriteKey(channel));
}

function toggleFavoriteKey(key: string): void {
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  store.saveFavorites(favorites);
  if (section === 'live' && els.country.value === FAVORITES) applyFilter();
  else list.refresh();
  movies.favoritesChanged();
  series.favoritesChanged();
  updateNowPlaying();
}

// ---------- Watch progress (movies and episodes) ----------

/** Only save once the new stream really plays: before that the video is still at 0. */
let progressReady = false;
let lastProgressSave = 0;

function playbackPosition(): { position: number; duration: number } | null {
  const timeline = player.timeline(); // movies converted by ffmpeg
  if (timeline) return timeline;
  const { currentTime, duration } = els.video;
  return Number.isFinite(duration) && duration > 0 ? { position: currentTime, duration } : null;
}

function saveProgress(force = false): void {
  if (!current || current.kind === 'live' || !progressReady) return;
  if (!force && Date.now() - lastProgressSave < PROGRESS_SAVE_MS) return;
  const at = playbackPosition();
  if (!at) return;
  lastProgressSave = Date.now();
  progress.set(keyOf(current), at.position, at.duration);
  if (current.kind === 'series') series.progressChanged(current);
  // Pausing or switching: "Continue watching" in the sidebar may change.
  if (force) (current.kind === 'movie' ? movies : series).refresh();
}

function updateNowPlaying(): void {
  const episode = current?.kind === 'series' ? series.describe(current) : null;
  els.npName.textContent = episode?.name ?? current?.name ?? 'No channel selected';
  els.npGroup.textContent = episode?.detail ?? current?.group ?? '';
  els.npLogo.hidden = !current?.logo;
  if (current?.logo) els.npLogo.src = current.logo;
  els.npFav.hidden = !current;
  const isFav = !!current && favorites.has(favoriteKey(current));
  els.npFav.textContent = isFav ? '★' : '☆';
  els.npFav.classList.toggle('on', isFav);
  document.title = current ? `${episode ? `${episode.name} ${episode.detail}` : current.name} · ipman` : 'ipman';
  renderNowPlayingGuide();
}

function showStatus(status: PlayerStatus): void {
  const overlayText: Record<PlayerStatus['state'], string> = {
    idle: '',
    loading: 'Loading…',
    playing: '',
    blocked: 'Click to play',
    error: status.state === 'error' ? status.message : '',
  };
  const label: Record<PlayerStatus['state'], string> = {
    idle: '',
    loading: 'Loading',
    // Movies and series have a finite duration; only live streams are "Live".
    playing: controls.isVod ? '▶ Playing' : '● Live',
    blocked: 'Paused',
    error: 'Error',
  };
  els.overlay.hidden = !overlayText[status.state];
  els.overlay.className = `overlay ${status.state}`;
  els.overlay.textContent = overlayText[status.state];
  els.npStatus.textContent = label[status.state];
  els.npStatus.dataset.state = status.state;
}

// ---------- Playlist loading ----------

/**
 * Favorites, progress and the last channel used to be keyed by the full stream URL, which has
 * the account's password in it. Re-key them without it (once; then this finds nothing to do).
 */
function migrateKeys(): void {
  if (!detectedXtream) return;
  const rekey = (key: string) => (key.startsWith('series:') ? key : withoutCredentials(key, detectedXtream));
  const rekeyed = new Set([...favorites].map(rekey));
  if ([...rekeyed].some((key) => !favorites.has(key))) {
    favorites = rekeyed;
    store.saveFavorites(favorites);
  }
  progress.migrate(rekey);
  const last = store.getLastChannel();
  if (last && rekey(last) !== last) store.setLastChannel(rekey(last));
}

function setPlaylist(next: Playlist): void {
  playlist = next;
  liveChannels = next.channels.filter((ch) => ch.kind === 'live');
  movieList = next.channels.filter((ch) => ch.kind === 'movie');
  seriesList = buildSeries(next.channels.filter((ch) => ch.kind === 'series'));
  // Movie and series URLs first: their /movie/USER/PASS/ID pattern is unambiguous.
  const samples = [...next.channels.filter((ch) => ch.kind !== 'live').slice(0, 3), ...next.channels.slice(0, 3)];
  detectedXtream = detectAccount(settings.playlistUrl, samples.map((ch) => ch.url));
  migrateKeys();
  rebuildGuideIndex();
  populateFilters();
  if (section === 'live') applyFilter();
  movies.playlistChanged();
  series.playlistChanged();

  if (current) {
    // Keep playing; just rebind to the channel object from the new playlist.
    const key = keyOf(current);
    current = next.channels.find((ch) => keyOf(ch) === key) ?? current;
    list.refresh();
  } else if (section === 'live') {
    // Resume the last TV channel at startup. Movies and episodes never start by themselves.
    resumeLastChannel();
  }
}

/** Incremented per load, so an older download can't replace a newer playlist. */
let playlistRun = 0;

async function loadPlaylist(force = false): Promise<void> {
  const run = ++playlistRun;
  const url = settings.playlistUrl;
  if (!url) {
    showNotice('No playlist yet. Open settings (⚙) to add an M3U URL.');
    openSettings();
    return;
  }

  const cached = await store.getCachedPlaylist().catch(() => undefined);
  if (run !== playlistRun) return;
  const hasCache = cached?.url === url;
  if (hasCache && !force) {
    lastFetchedAt = cached.fetchedAt;
    setPlaylist(parseM3U(cached.text));
    if (Date.now() - cached.fetchedAt < REFRESH_AFTER_MS) return;
  }

  if (!hasCache || force) showNotice('Loading playlist…');
  try {
    const res = await fetch(fetchUrl(url));
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const text = await res.text();
    if (run !== playlistRun) return;
    const parsed = parseM3U(text);
    if (!parsed.channels.length) throw new Error('no channels found. Is this an M3U playlist?');
    lastFetchedAt = Date.now();
    setPlaylist(parsed);
    // Caching is a speed-up; a full or blocked IndexedDB mustn't lose the fresh playlist.
    store.cachePlaylist({ url, text, fetchedAt: lastFetchedAt }).catch((err: Error) => console.warn(`[ipman] Could not cache the playlist: ${err.message}`));
  } catch (err) {
    if (run !== playlistRun) return;
    let message = `Could not load playlist: ${(err as Error).message}`;
    if (!settings.useProxy && err instanceof TypeError) message += ' (likely CORS; try enabling the proxy)';
    if (hasCache) {
      console.warn(message);
      if (force) setPlaylist(parseM3U(cached.text));
    }
    showNotice(hasCache ? `${message}. Showing cached copy.` : message, true);
  }
}

// ---------- Settings ----------

function openSettings(): void {
  els.urlInput.value = settings.playlistUrl;
  els.proxyInput.checked = settings.useProxy;
  els.epgInput.value = settings.epgUrl;
  const episodes = seriesList.reduce((n, s) => n + s.episodeCount, 0);
  const playlistInfo = playlist.channels.length
    ? `Playlist: ${liveChannels.length.toLocaleString()} TV channels, ${movieList.length.toLocaleString()} movies, ` +
      `${seriesList.length.toLocaleString()} series (${episodes.toLocaleString()} episodes)` +
      (lastFetchedAt ? ` · fetched ${new Date(lastFetchedAt).toLocaleString()}` : '')
    : '';
  els.settingsInfo.replaceChildren(
    ...[playlistInfo, guideStatus].filter(Boolean).flatMap((line, i) => (i ? [document.createElement('br'), line] : [line])),
  );
  els.dialog.returnValue = '';
  els.dialog.showModal();
  xtreamSettings.open(settings.xtream, detectedXtream);
}

// The provider's API doesn't allow browser requests (CORS), so it goes through the local proxy.
const xtreamSettings = new XtreamSettings(fetchUrl);

els.dialog.addEventListener('close', () => {
  if (els.dialog.returnValue !== 'save') return;
  settings = {
    playlistUrl: els.urlInput.value.trim(),
    useProxy: els.proxyInput.checked,
    epgUrl: els.epgInput.value.trim(),
    xtream: xtreamSettings.value(),
  };
  store.saveSettings(settings);
  void loadPlaylist(true).then(() => loadGuide(true));
});

// ---------- Events ----------

els.settingsBtn.addEventListener('click', openSettings);
initUpdates(els.settingsBtn);

function setSidebarCollapsed(collapsed: boolean, moveFocus = false): void {
  els.app.classList.toggle('sidebar-collapsed', collapsed);
  els.expandBtn.hidden = !collapsed;
  store.setSidebarCollapsed(collapsed);
  // Keep keyboard focus on a visible control when its button disappears.
  if (moveFocus) (collapsed ? els.expandBtn : els.collapseBtn).focus();
}

els.collapseBtn.addEventListener('click', () => setSidebarCollapsed(true, true));
els.expandBtn.addEventListener('click', () => setSidebarCollapsed(false, true));
setSidebarCollapsed(store.getSidebarCollapsed());

// ---------- Sections: TV, MOVIES, SERIES ----------

const sectionButtons = [...document.querySelectorAll<HTMLButtonElement>('.section-btn')];

function showSection(): void {
  for (const btn of sectionButtons) btn.ariaPressed = String(btn.dataset.section === section);
  // CSS shows the channel list and player, or (MOVIES, SERIES) the categories and the card grid.
  els.app.dataset.section = section;
  els.backBtn.textContent = section === 'series' ? '← Series' : '← Movies';
  els.backBtn.title = section === 'series' ? 'Back to the series' : 'Back to the movies';
}

/**
 * Each section plays its own kind: leaving one stops what it was playing (a movie or episode
 * keeps its position). TV picks up its last channel; MOVIES and SERIES have theirs ready to resume.
 */
function switchSection(next: ChannelKind): void {
  if (next === section) return;
  if (current && current.kind !== next) stopPlayback();
  section = next;
  store.setSection(next);
  showSection();
  els.search.value = '';
  movies.hide();
  series.hide();
  if (next === 'live') {
    els.search.placeholder = LIVE_SEARCH;
    list.scrollToTop();
    applyFilter();
    resumeLastChannel();
  } else {
    (next === 'movie' ? movies : series).show();
  }
}

for (const btn of sectionButtons) btn.addEventListener('click', () => switchSection(btn.dataset.section as ChannelKind));
showSection();
if (section === 'movie') movies.show();
if (section === 'series') series.show();

els.backBtn.addEventListener('click', stopPlayback);

function onFilterChange(): void {
  store.setFilter('live', els.country.value, els.category.value);
  list.scrollToTop();
  applyFilter();
}

els.country.addEventListener('change', () => {
  // Keeps the category when the new country has it too, e.g. Norway → Sweden stays on "Sport".
  populateCategories();
  onFilterChange();
});
els.category.addEventListener('change', onFilterChange);

els.search.addEventListener('input', () => {
  if (section === 'movie') return movies.applyFilter();
  if (section === 'series') return series.applyFilter();
  list.scrollToTop();
  applyFilter();
});

els.list.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('.channel');
  const channel = row && visible[Number(row.dataset.index)];
  if (!channel) return;
  if (target.closest('[data-action="favorite"]')) toggleFavorite(channel);
  else tune(channel);
});

els.npFav.addEventListener('click', () => current && toggleFavorite(current));
els.npLogo.addEventListener('error', () => (els.npLogo.hidden = true));
els.overlay.addEventListener('click', () => void els.video.play());

const savedVolume = store.getVolume();
els.video.volume = savedVolume.volume;
els.video.muted = savedVolume.muted;
els.video.addEventListener('volumechange', () => store.setVolume(els.video.volume, els.video.muted));

/** Resolution tiers by decoded height. Ranges, not exact values: channels often send e.g. 1088 or 576 lines. */
function resolutionTier(height: number): { label: string; tier: string } {
  if (height >= 2000) return { label: '2160p', tier: 'uhd' };
  if (height >= 1000) return { label: '1080p', tier: 'fhd' };
  if (height >= 700) return { label: '720p', tier: 'hd' };
  return { label: `${height}p`, tier: 'sd' };
}

// `resize` fires when the first frame is decoded and whenever HLS switches quality level.
function updateResolution(): void {
  const { videoWidth, videoHeight } = els.video;
  els.npResolution.hidden = !videoHeight;
  if (!videoHeight) return;
  const { label, tier } = resolutionTier(videoHeight);
  els.npResolution.textContent = label;
  els.npResolution.dataset.tier = tier;
  els.npResolution.title = `${videoWidth} × ${videoHeight}`;
}
els.video.addEventListener('resize', updateResolution);
els.video.addEventListener('emptied', updateResolution); // Channel switch or stop: hide until the new stream decodes.

els.video.addEventListener('playing', () => (progressReady = true));
els.video.addEventListener('timeupdate', () => saveProgress());
els.video.addEventListener('pause', () => saveProgress(true));
window.addEventListener('pagehide', () => saveProgress(true));
// At the end of an episode, the next one starts (where it was left, if it was started before).
els.video.addEventListener('ended', () => {
  if (current?.kind !== 'series') return;
  saveProgress(true);
  const next = series.nextEpisode(current);
  if (next) tune(next, 0, startPosition(progress.get(keyOf(next))));
});

document.addEventListener('keydown', (event) => {
  if (els.dialog.open || els.movieDialog.open || els.seriesDialog.open || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (target.closest('.ctl-menu')) return; // Arrow keys move through the menu there.
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
    if (event.key === 'Escape') target.blur();
    return;
  }

  switch (event.key) {
    case 'ArrowLeft':
      if (!controls.seekBy(-10)) return;
      break;
    case 'ArrowRight':
      if (!controls.seekBy(10)) return;
      break;
    case 'ArrowUp':
    case 'PageUp':
      if (section !== 'live') return; // no channel zapping between movies or episodes
      zap(-1);
      break;
    case 'ArrowDown':
    case 'PageDown':
      if (section !== 'live') return;
      zap(1);
      break;
    case 'f':
    case 'F':
      controls.toggleFullscreen();
      break;
    case ' ':
    case 'k':
    case 'K':
      if (target instanceof HTMLButtonElement) return; // Space on a focused button presses it.
      controls.togglePlay();
      break;
    case 'm':
    case 'M':
      els.video.muted = !els.video.muted;
      break;
    case 's':
    case 'S':
      if (current) toggleFavorite(current);
      break;
    case '/':
      if (els.app.classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
      els.search.focus();
      els.search.select();
      break;
    default:
      return;
  }
  event.preventDefault();
});

// Roll shows over and keep progress bars moving; also picks up a stale guide after sleep.
setInterval(() => {
  if (!guide) return;
  list.refresh();
  renderNowPlayingGuide();
  if (Date.now() - guide.fetchedAt > GUIDE_REFRESH_MS) void loadGuide();
}, GUIDE_TICK_MS);

void loadPlaylist().then(() => loadGuide());
