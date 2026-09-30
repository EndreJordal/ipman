/**
 * What the MOVIES and SERIES sections share: the category sidebar, the sorted and searchable card
 * grid, the details dialog's common parts, the Xtream list cache, and formatting helpers.
 */
import type { Channel } from './lib/m3u';
import { parseMovieTitle, type MovieTitle } from './lib/movie-title';
import { XtreamError, type XtreamAccount } from './lib/xtream';
import { store, type CachedSummaries } from './store';
import { VirtualGrid } from './virtual-grid';

/** Title order: accents and case don't matter, "Rocky 2" before "Rocky 10", leading "-" or "'" ignored. */
export const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true, ignorePunctuation: true });

/** "Movies: Nordic 4K" → "Nordic 4K", "Series: Swedish" → "Swedish". */
export const categoryLabel = (group: string) => group.replace(/^(movies?|films?|vod|series|tv series|tv shows?)\s*[:|-]\s*/i, '').trim() || group;

/**
 * Provider panels mirror TMDb images under their own host ("…/images/series/<TMDb ID>_small.jpg"),
 * and those mirrors are often down. TMDb has the same image under the same ID.
 */
const MIRRORED = /^https?:\/\/[^/]+\/images\/[a-z]+\/([A-Za-z0-9]{20,40})(?:_small|_big)?\.(?:jpe?g|png)$/i;
const TMDB = /^(https?:\/\/image\.tmdb\.org\/t\/p\/)[^/]+\//;

/** An image at a TMDb size ("w342", "w500", "w1280"), from TMDb itself where possible. */
export function tmdbImage(url: string | undefined, size: string): string | undefined {
  if (!url) return url;
  const mirrored = MIRRORED.exec(url);
  if (mirrored) return `https://image.tmdb.org/t/p/${size}/${mirrored[1]}.jpg`;
  return url.replace(TMDB, `$1${size}/`);
}

/** TMDb posters come at 600×900; the w342 size is plenty for a card and loads much faster. */
export const cardPoster = (url: string | undefined) => tmdbImage(url, 'w342');

/** A CSS url() for an image address from the provider, quoted so it can't break out. */
export const cssUrl = (url: string) => `url(${JSON.stringify(url)})`;

/** 75 → "1:15", 4000 → "1:06:40". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Fills the sidebar with category buttons: [value, label, count], the current one highlighted. */
export function renderCategoryList(container: HTMLElement, entries: [value: string, label: string, count: number][], current: string): void {
  container.replaceChildren(
    ...entries.map(([value, label, count]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'category';
      button.dataset.category = value;
      button.ariaCurrent = value === current ? 'true' : null;
      const name = document.createElement('span');
      name.className = 'category-name';
      name.textContent = label;
      const badge = document.createElement('span');
      badge.className = 'category-count';
      badge.textContent = count.toLocaleString();
      button.append(name, badge);
      return button;
    }),
  );
}

/** Groups sorted by their label, as category entries. */
export function groupEntries(counts: Map<string, number>): [string, string, number][] {
  return [...counts]
    .map(([group, count]): [string, string, number] => [group, categoryLabel(group), count])
    .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }));
}

/** The poster part of a card: image with the title showing through until it loads, a tag badge, a ★. */
export function renderPoster(src: string | undefined, title: string, tag: string | undefined, favorite: boolean): HTMLElement {
  const poster = document.createElement('div');
  poster.className = 'poster';
  const fallback = document.createElement('span');
  fallback.className = 'poster-fallback';
  fallback.textContent = title;
  poster.append(fallback);
  if (src) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = src;
    img.addEventListener('error', () => img.remove(), { once: true });
    poster.append(img);
  }
  if (tag) {
    const badge = document.createElement('span');
    badge.className = 'poster-tag';
    badge.textContent = tag;
    poster.append(badge);
  }
  if (favorite) {
    const star = document.createElement('span');
    star.className = 'poster-fav';
    star.textContent = '★';
    star.ariaLabel = 'Favorite';
    poster.append(star);
  }
  return poster;
}

/** Fills a <dl> with term/value pairs. */
export function renderMeta(dl: HTMLElement, meta: [string, string][]): void {
  dl.replaceChildren(
    ...meta.flatMap(([term, value]) => [
      Object.assign(document.createElement('dt'), { textContent: term }),
      Object.assign(document.createElement('dd'), { textContent: value }),
    ]),
  );
}

// ---------- Xtream lists (movie ratings, series covers) ----------

const SUMMARIES_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * One list from the Xtream API for the whole catalogue, cached in IndexedDB for 12 hours and
 * kept per account: after an account change, the old account's data no longer applies, and a
 * late answer for it is dropped.
 */
export class SummaryCache<V> {
  private map: Map<string, V> | null = null;
  private accountKey = '';
  private loading: Promise<void> | null = null;
  /** Why the last load failed, while there's nothing to show instead. */
  error: Error | null = null;

  constructor(
    private options: {
      label: string;
      account: () => XtreamAccount | null;
      read: () => Promise<CachedSummaries<V> | undefined>;
      write: (cache: CachedSummaries<V>) => Promise<unknown>;
      fetch: (account: XtreamAccount) => Promise<Map<string, V>>;
      /** New data arrived (or the old account's was dropped). */
      changed: () => void;
      /** The account changed: drop anything else derived from the old one. */
      reset?: () => void;
    },
  ) {}

  get(key: string): V | undefined {
    return this.map?.get(key);
  }

  /** Loads once per account (again after 12 hours). Never rejects: failures are logged. */
  load(): Promise<void> {
    const account = this.options.account();
    const key = account ? `${account.server} ${account.username}` : '';
    if (key !== this.accountKey) {
      this.accountKey = key;
      this.loading = null;
      this.error = null;
      this.options.reset?.();
      if (this.map) {
        this.map = null;
        this.options.changed();
      }
    }
    if (!account) return Promise.resolve();
    this.loading ??= this.fetchFor(account, key);
    return this.loading;
  }

  private apply(entries: [string, V][]): void {
    this.map = new Map(entries);
    this.error = null;
    this.options.changed();
  }

  private async fetchFor(account: XtreamAccount, key: string): Promise<void> {
    const { label } = this.options;
    const cached = await this.options.read().catch(() => undefined);
    if (key !== this.accountKey) return;
    if (cached?.account === key) {
      this.apply(cached.entries);
      if (Date.now() - cached.fetchedAt < SUMMARIES_TTL_MS) return;
    }
    try {
      const entries = [...(await this.options.fetch(account))];
      if (key !== this.accountKey) return; // the account changed meanwhile
      this.apply(entries);
      // Caching is a speed-up; a full or blocked IndexedDB mustn't lose the fresh data.
      this.options
        .write({ account: key, fetchedAt: Date.now(), entries })
        .catch((err: Error) => console.warn(`[${label}] could not cache the list: ${err.message}`));
    } catch (err) {
      console.warn(`[${label}] could not load the list: ${(err as Error).message}`);
      if (key !== this.accountKey || cached?.account === key) return;
      this.error = err as Error;
      this.loading = null; // try again next time
    }
  }
}

// ---------- The MOVIES and SERIES views ----------

export const ALL = '__all__';
export const CONTINUE = '__continue__';
export const FAVORITES = '__favorites__';

type CatalogSort = 'title' | 'year' | 'rating';
const SORTS: CatalogSort[] = ['title', 'year', 'rating'];

export interface CatalogDeps {
  /** Favorites are shared with TV: movies use their stream key, series "series:<key>". */
  isFavorite: (key: string) => boolean;
  toggleFavorite: (key: string) => void;
  /** A movie's or episode's key for favorites and progress: its URL without the account. */
  keyOf: (channel: Channel) => string;
  account: () => XtreamAccount | null;
  /** Turns an upstream URL into one the browser can fetch (the local proxy). */
  fetchUrl: (url: string) => string;
  search: HTMLInputElement;
  count: HTMLElement;
}

export interface CatalogConfig {
  section: 'movie' | 'series';
  /** The dialog's element IDs start with this: md-play, sd-play, … */
  dialogPrefix: 'md' | 'sd';
  text: {
    all: string;
    favorites: string;
    one: string;
    many: string;
    noFavorites: string;
    noContinue: string;
    none: string;
    search: string;
  };
  /** Room under the poster for the text lines. */
  cardExtraHeight: number;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The shared half of MoviesView and SeriesView: categories in the sidebar (with "Continue
 * watching" and favorites), the card grid with sort and search, and the dialog's close,
 * favorite and link parts. Subclasses supply the items, the cards and the dialog's content.
 * Element IDs follow the section: movie-grid, movie-heading, movie-dialog, series-grid, …
 */
export abstract class CatalogView<T extends object> {
  protected category: string;
  protected visible: T[] = [];
  protected active = false;
  /** The item in the details dialog. */
  protected dialogItem: T | null = null;
  /** Incremented per dialog opening, so late details for an earlier one are dropped. */
  protected detailsRun = 0;
  protected readonly grid: VirtualGrid<T>;
  protected readonly dialog: HTMLDialogElement;
  private sort: CatalogSort;
  private counts = new Map<string, number>();
  /**
   * Every item in the current sort order, computed once per sort, playlist and list update, so
   * filtering and searching just walk it instead of sorting 56,000 titles on every keystroke.
   */
  private sorted: T[] | null = null;
  private titles = new WeakMap<T, MovieTitle>();
  private searchNames = new WeakMap<T, string>();
  private base: {
    categories: HTMLElement;
    heading: HTMLElement;
    headingCount: HTMLElement;
    sort: HTMLSelectElement;
    fav: HTMLButtonElement;
    status: HTMLElement;
    trailer: HTMLAnchorElement;
    tmdb: HTMLAnchorElement;
  };

  constructor(
    protected deps: CatalogDeps,
    private config: CatalogConfig,
  ) {
    const { section, dialogPrefix: d } = config;
    this.base = {
      categories: byId(`${section}-categories`),
      heading: byId(`${section}-heading`),
      headingCount: byId(`${section}-count`),
      sort: byId(`${section}-sort`),
      fav: byId(`${d}-fav`),
      status: byId(`${d}-status`),
      trailer: byId(`${d}-trailer`),
      tmdb: byId(`${d}-tmdb`),
    };
    this.dialog = byId(`${section}-dialog`);
    this.category = store.getFilter(section)?.country ?? ALL;
    this.sort = SORTS.find((s) => s === store.getSort(section)) ?? 'title';

    const gridEl = byId(`${section}-grid`);
    this.grid = new VirtualGrid(gridEl, (item) => this.renderCard(item), {
      minCardWidth: 150,
      gap: 18,
      aspect: 1.5,
      extraHeight: config.cardExtraHeight,
    });
    gridEl.addEventListener('click', (event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('.movie-card');
      const item = card && this.visible[Number(card.dataset.index)];
      if (item) this.openDetails(item);
    });

    this.base.categories.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-category]');
      if (!button) return;
      this.category = button.dataset.category!;
      store.setFilter(section, this.category, ALL);
      this.renderCategories();
      this.grid.scrollToTop();
      this.applyFilter();
    });

    this.base.sort.value = this.sort;
    this.base.sort.addEventListener('change', () => {
      this.sort = this.base.sort.value as CatalogSort;
      store.setSort(section, this.sort);
      this.sorted = null;
      this.grid.scrollToTop();
      this.applyFilter();
    });

    byId(`${d}-close`).addEventListener('click', () => this.dialog.close());
    // A click on the dimmed area around the dialog closes it.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
    this.base.fav.addEventListener('click', () => {
      if (!this.dialogItem) return;
      this.deps.toggleFavorite(this.favoriteKey(this.dialogItem));
      this.renderFavoriteButton();
    });
  }

  // ---------- What subclasses supply ----------

  protected abstract items(): T[];
  /** The playlist's name, for the title, year, tag and search. */
  protected abstract nameOf(item: T): string;
  protected abstract groupOf(item: T): string;
  protected abstract favoriteKey(item: T): string;
  protected abstract ratingOf(item: T): number | null | undefined;
  /** Started and not finished, most recently watched first. */
  protected abstract continueWatching(): T[];
  protected abstract renderCard(item: T): HTMLElement;
  protected abstract openDetails(item: T): void;
  /** Starts loading the Xtream list, if there's an account. */
  protected abstract loadSummaries(): void;

  protected yearOf(item: T): number | undefined {
    return this.title(item).year;
  }

  // ---------- Called from main ----------

  /** The section became visible. */
  show(): void {
    this.active = true;
    this.deps.search.placeholder = `${this.config.text.search}   /`;
    this.renderCategories();
    this.applyFilter();
    this.loadSummaries();
  }

  hide(): void {
    this.active = false;
  }

  /** Back from the player: "Continue watching" and the cards' progress may have changed. */
  refresh(): void {
    if (!this.active) return;
    this.renderCategories();
    if (this.category === CONTINUE) this.applyFilter();
    else this.grid.refresh();
  }

  /** A new playlist arrived. */
  playlistChanged(): void {
    this.sorted = null;
    this.counts = new Map();
    for (const item of this.items()) this.counts.set(this.groupOf(item), (this.counts.get(this.groupOf(item)) ?? 0) + 1);
    if (![ALL, CONTINUE, FAVORITES].includes(this.category) && !this.counts.has(this.category)) this.category = ALL;
    if (this.active) this.show();
  }

  /** Favorites changed, here or elsewhere (e.g. the ★ in the now-playing bar). */
  favoritesChanged(): void {
    if (this.dialog.open) this.renderFavoriteButton();
    if (!this.active) return;
    this.renderCategories();
    if (this.category === FAVORITES) this.applyFilter();
    else this.grid.refresh(); // the ★ on the card
  }

  applyFilter(): void {
    const query = this.deps.search.value.trim().toLowerCase();
    const { category } = this;
    const continuing = category === CONTINUE ? this.continueWatching() : null;
    // "Continue watching" keeps its own order: the most recently watched first.
    const source = continuing ?? this.sortedItems();
    this.visible = source.filter((item) => {
      if (category === FAVORITES) {
        if (!this.deps.isFavorite(this.favoriteKey(item))) return false;
      } else if (!continuing && category !== ALL && this.groupOf(item) !== category) {
        return false;
      }
      return !query || this.searchName(item).includes(query);
    });
    this.base.sort.disabled = !!continuing;
    this.base.sort.title = continuing ? 'Sorted by when you last watched' : '';
    this.grid.setItems(this.visible);

    const { text } = this.config;
    const n = this.visible.length;
    const headings: Record<string, string> = { [ALL]: text.all, [CONTINUE]: 'Continue watching', [FAVORITES]: text.favorites };
    this.base.heading.textContent = headings[category] ?? categoryLabel(category);
    const count = plural(n, text.one, text.many);
    this.base.headingCount.textContent = n ? count : '';
    this.deps.count.textContent = n
      ? count
      : category === FAVORITES && !query
        ? text.noFavorites
        : category === CONTINUE && !query
          ? text.noContinue
          : this.items().length
            ? `No matching ${text.many}`
            : text.none;
    this.deps.count.classList.remove('error');
  }

  // ---------- For subclasses ----------

  /** The Xtream list changed: ratings (and years) can change the order, not only the cards. */
  protected summariesChanged(): void {
    if (this.sort !== 'title') {
      this.sorted = null;
      if (this.active) this.applyFilter();
    } else {
      this.grid.refresh();
    }
  }

  protected title(item: T): MovieTitle {
    let parsed = this.titles.get(item);
    if (!parsed) {
      parsed = parseMovieTitle(this.nameOf(item));
      this.titles.set(item, parsed);
    }
    return parsed;
  }

  /** Opens the dialog for an item (the subclass fills in its content). Returns the run number. */
  protected showDialog(item: T): number {
    this.dialogItem = item;
    this.setStatus('');
    this.renderFavoriteButton();
    if (!this.dialog.open) this.dialog.showModal();
    return ++this.detailsRun;
  }

  protected setStatus(text: string): void {
    this.base.status.textContent = text;
  }

  protected detailsError(err: unknown): string {
    return err instanceof XtreamError ? `Could not load details: ${err.message}` : 'Could not load details.';
  }

  protected renderLinks(trailer: string | undefined, tmdbId: string | undefined, tmdbKind: 'movie' | 'tv'): void {
    const { trailer: trailerLink, tmdb } = this.base;
    trailerLink.hidden = !trailer;
    if (trailer) trailerLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(trailer)}`;
    tmdb.hidden = !tmdbId;
    if (tmdbId) tmdb.href = `https://www.themoviedb.org/${tmdbKind}/${encodeURIComponent(tmdbId)}`;
  }

  /**
   * A card: poster (with tag, ★ and the blue watched bar), title, then rating, year and, where
   * the heading doesn't say it, the category. Returns the meta line for subclasses to extend.
   */
  protected renderCardShell(item: T, posterUrl: string | undefined, watched: number): { card: HTMLButtonElement; meta: HTMLElement } {
    const { title, tag } = this.title(item);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'movie-card';
    card.title = this.nameOf(item);

    const poster = renderPoster(cardPoster(posterUrl), title, tag, this.deps.isFavorite(this.favoriteKey(item)));
    if (watched > 0) poster.append(renderWatchBar(watched));

    const name = document.createElement('div');
    name.className = 'movie-title';
    name.textContent = title;

    const meta = document.createElement('div');
    meta.className = 'movie-meta';
    const rating = this.ratingOf(item);
    if (rating) meta.append(Object.assign(document.createElement('span'), { className: 'movie-rating', textContent: `★ ${rating.toFixed(1)}` }));
    const year = this.yearOf(item);
    if (year) meta.append(Object.assign(document.createElement('span'), { textContent: String(year) }));
    // Across categories the same title often appears several times (language versions): the
    // category tells them apart. Inside one category it would only repeat the heading.
    if (this.category === ALL || this.category === FAVORITES || this.category === CONTINUE) {
      meta.append(Object.assign(document.createElement('span'), { className: 'movie-category', textContent: categoryLabel(this.groupOf(item)) }));
    }

    card.append(poster, name, meta);
    return { card, meta };
  }

  // ---------- Internals ----------

  private searchName(item: T): string {
    let name = this.searchNames.get(item);
    if (name === undefined) {
      name = this.nameOf(item).toLowerCase();
      this.searchNames.set(item, name);
    }
    return name;
  }

  /** Title: A–Z. Year: newest first. Rating: highest first. Ties, and missing years or ratings, by title. */
  private sortedItems(): T[] {
    if (this.sorted) return this.sorted;
    const byTitle = (a: T, b: T) => collator.compare(this.title(a).title, this.title(b).title);
    const year = (item: T) => this.yearOf(item) ?? -1;
    const rating = (item: T) => this.ratingOf(item) ?? -1;
    const compare: Record<CatalogSort, (a: T, b: T) => number> = {
      title: byTitle,
      year: (a, b) => year(b) - year(a) || byTitle(a, b),
      rating: (a, b) => rating(b) - rating(a) || byTitle(a, b),
    };
    this.sorted = [...this.items()].sort(compare[this.sort]);
    return this.sorted;
  }

  private renderCategories(): void {
    const items = this.items();
    const favorites = items.reduce((n, item) => n + (this.deps.isFavorite(this.favoriteKey(item)) ? 1 : 0), 0);
    renderCategoryList(
      this.base.categories,
      [
        [ALL, this.config.text.all, items.length],
        [CONTINUE, '▶ Continue watching', this.continueWatching().length],
        [FAVORITES, '★ Favorites', favorites],
        ...groupEntries(this.counts),
      ],
      this.category,
    );
  }

  private renderFavoriteButton(): void {
    const fav = !!this.dialogItem && this.deps.isFavorite(this.favoriteKey(this.dialogItem));
    this.base.fav.textContent = fav ? '★ Favorite' : '☆ Favorite';
    this.base.fav.classList.toggle('on', fav);
    this.base.fav.ariaPressed = String(fav);
  }
}

/** The blue bar along the bottom of a poster or still: how much has been watched (0–1). */
export function renderWatchBar(fraction: number): HTMLElement {
  const bar = document.createElement('span');
  bar.className = 'watch-bar';
  const fill = document.createElement('span');
  fill.style.width = `${(Math.min(1, fraction) * 100).toFixed(1)}%`;
  bar.append(fill);
  return bar;
}
