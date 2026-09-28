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
import { parseM3U, splitGroup, type Channel, type Playlist } from './lib/m3u';
import { proxyUrl } from './lib/proxy';
import { Player, type PlayerStatus } from './player';
import { store } from './store';
import { VirtualList } from './virtual-list';

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
  dialog: byId<HTMLDialogElement>('settings-dialog'),
  urlInput: byId<HTMLInputElement>('playlist-url'),
  proxyInput: byId<HTMLInputElement>('use-proxy'),
  epgInput: byId<HTMLInputElement>('epg-url'),
  settingsInfo: byId<HTMLParagraphElement>('settings-info'),
};

let settings = store.getSettings();
let favorites = store.getFavorites();
let playlist: Playlist = { channels: [], groups: [] };
let visible: Channel[] = [];
let current: Channel | null = null;
let lastFetchedAt: number | null = null;
let zapTimer = 0;
let guide: Guide | null = null;
/** Each channel's programmes, resolved once per guide/playlist pair. */
let guideIndex = new Map<Channel, Programme[]>();
let guideStatus = '';
let groupParts = new Map<string, { country: string; category: string }>();
let categoriesByCountry = new Map<string, Set<string>>();
let guideLoading = false;

const player = new Player(els.video, showStatus);
const list = new VirtualList<Channel>(els.list, ROW_HEIGHT, renderRow);

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

  const isFav = favorites.has(channel.url);
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
  for (const channel of playlist.channels) {
    const programmes = programmesFor(guide, channel);
    if (programmes) guideIndex.set(channel, programmes);
  }
  guideStatus =
    `Guide: ${guideIndex.size.toLocaleString()} of ${playlist.channels.length.toLocaleString()} channels matched` +
    ` · fetched ${new Date(guide.fetchedAt).toLocaleString()}`;
  console.info(`[ipman] ${guideStatus}`);
}

function setGuide(next: Guide): void {
  guide = next;
  rebuildGuideIndex();
  list.refresh();
  updateNowPlaying();
}

async function loadGuide(force = false): Promise<void> {
  const epgUrl = settings.epgUrl || guessEpgUrl(settings.playlistUrl, playlist.epgUrl);
  if (!epgUrl) {
    guideStatus = 'Guide: none found for this playlist. Set a guide URL above.';
    return;
  }
  if (guideLoading) return;
  guideLoading = true;
  try {
    const cached = await store.getCachedGuide();
    if (cached?.url === epgUrl && !guide) setGuide(cached.guide);
    if (!force && cached?.url === epgUrl && Date.now() - cached.guide.fetchedAt < GUIDE_REFRESH_MS) return;

    if (!guide) guideStatus = 'Guide: loading… (the first download can take a minute)';
    const res = await fetch(epgServiceUrl(epgUrl, force));
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const fresh = (await res.json()) as Guide;
    await store.cacheGuide({ url: epgUrl, guide: fresh });
    setGuide(fresh);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[ipman] Could not load guide: ${message}`);
    guideStatus = guide ? `${guideStatus} (refresh failed: ${message})` : `Guide: ${message}`;
  } finally {
    guideLoading = false;
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

function applyFilter(): void {
  const country = els.country.value;
  const category = els.category.value;
  const query = els.search.value.trim().toLowerCase();
  visible = playlist.channels.filter((ch) => {
    if (country === FAVORITES) {
      if (!favorites.has(ch.url)) return false;
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
  if (n) els.count.textContent = `${n.toLocaleString()} channel${n === 1 ? '' : 's'}`;
  else if (els.country.value === FAVORITES && !els.search.value) els.count.textContent = 'No favorites yet. Press ☆ on a channel.';
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

/** Fills both dropdowns from the playlist's "Country - Category" groups, restoring the saved choice. */
function populateFilters(): void {
  groupParts = new Map(playlist.groups.map((g) => [g, splitGroup(g)]));
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

  const saved = store.getFilter();
  setOptions(
    els.country,
    [
      [ALL, hasCategories ? 'All countries' : 'All channels'],
      [FAVORITES, '★ Favorites'],
      ...[...categoriesByCountry.keys()].map((c): [string, string] => [c, c]),
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

function tune(channel: Channel, delay = 0): void {
  current = channel;
  store.setLastChannel(channel.url);
  updateNowPlaying();
  list.refresh();
  const index = visible.indexOf(channel);
  if (index >= 0) list.scrollToIndex(index);

  clearTimeout(zapTimer);
  if (delay) zapTimer = window.setTimeout(() => player.play(channel.url, settings.useProxy), delay);
  else player.play(channel.url, settings.useProxy);
}

function zap(step: number): void {
  if (!visible.length) return;
  const index = current ? visible.indexOf(current) : -1;
  const next = index === -1 ? 0 : (index + step + visible.length) % visible.length;
  tune(visible[next], ZAP_DELAY_MS);
}

function toggleFavorite(channel: Channel): void {
  if (favorites.has(channel.url)) favorites.delete(channel.url);
  else favorites.add(channel.url);
  store.saveFavorites(favorites);
  if (els.country.value === FAVORITES) applyFilter();
  else list.refresh();
  updateNowPlaying();
}

function updateNowPlaying(): void {
  els.npName.textContent = current?.name ?? 'No channel selected';
  els.npGroup.textContent = current?.group ?? '';
  els.npLogo.hidden = !current?.logo;
  if (current?.logo) els.npLogo.src = current.logo;
  els.npFav.hidden = !current;
  const isFav = !!current && favorites.has(current.url);
  els.npFav.textContent = isFav ? '★' : '☆';
  els.npFav.classList.toggle('on', isFav);
  document.title = current ? `${current.name} · ipman` : 'ipman';
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
    playing: '● Live',
    blocked: 'Paused',
    error: 'Error',
  };
  els.overlay.hidden = !overlayText[status.state];
  els.overlay.className = `overlay ${status.state}`;
  els.overlay.textContent = overlayText[status.state];
  els.npStatus.textContent = label[status.state];
  els.npStatus.dataset.state = status.state;
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void els.playerWrap.requestFullscreen();
}

// ---------- Playlist loading ----------

function setPlaylist(next: Playlist): void {
  playlist = next;
  rebuildGuideIndex();
  populateFilters();
  applyFilter();

  const lastUrl = current?.url ?? store.getLastChannel();
  const match = lastUrl ? next.channels.find((ch) => ch.url === lastUrl) : undefined;
  if (match && !current) {
    tune(match);
  } else if (current) {
    // Keep playing; just rebind to the channel object from the new playlist.
    current = match ?? current;
    list.refresh();
  }
}

async function loadPlaylist(force = false): Promise<void> {
  const url = settings.playlistUrl;
  if (!url) {
    showNotice('No playlist yet. Open settings (⚙) to add an M3U URL.');
    openSettings();
    return;
  }

  const cached = await store.getCachedPlaylist();
  const hasCache = cached?.url === url;
  if (hasCache && !force) {
    lastFetchedAt = cached.fetchedAt;
    setPlaylist(parseM3U(cached.text));
    if (Date.now() - cached.fetchedAt < REFRESH_AFTER_MS) return;
  }

  if (!hasCache || force) showNotice('Loading playlist…');
  try {
    const res = await fetch(settings.useProxy ? proxyUrl(url) : url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const text = await res.text();
    const parsed = parseM3U(text);
    if (!parsed.channels.length) throw new Error('no channels found. Is this an M3U playlist?');
    lastFetchedAt = Date.now();
    await store.cachePlaylist({ url, text, fetchedAt: lastFetchedAt });
    setPlaylist(parsed);
  } catch (err) {
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
  const playlistInfo = playlist.channels.length
    ? `Playlist: ${playlist.channels.length.toLocaleString()} channels in ${playlist.groups.length} groups` +
      (lastFetchedAt ? ` · fetched ${new Date(lastFetchedAt).toLocaleString()}` : '')
    : '';
  els.settingsInfo.replaceChildren(
    ...[playlistInfo, guideStatus].filter(Boolean).flatMap((line, i) => (i ? [document.createElement('br'), line] : [line])),
  );
  els.dialog.returnValue = '';
  els.dialog.showModal();
}

els.dialog.addEventListener('close', () => {
  if (els.dialog.returnValue !== 'save') return;
  settings = {
    playlistUrl: els.urlInput.value.trim(),
    useProxy: els.proxyInput.checked,
    epgUrl: els.epgInput.value.trim(),
  };
  store.saveSettings(settings);
  void loadPlaylist(true).then(() => loadGuide(true));
});

// ---------- Events ----------

els.settingsBtn.addEventListener('click', openSettings);

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

function onFilterChange(): void {
  store.setFilter(els.country.value, els.category.value);
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

document.addEventListener('keydown', (event) => {
  if (els.dialog.open || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
    if (event.key === 'Escape') target.blur();
    return;
  }

  switch (event.key) {
    case 'ArrowUp':
    case 'PageUp':
      zap(-1);
      break;
    case 'ArrowDown':
    case 'PageDown':
      zap(1);
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
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
