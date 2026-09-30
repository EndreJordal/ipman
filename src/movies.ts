/**
 * The MOVIES section: categories in the sidebar, the movies as a grid of poster cards, and a
 * details dialog with "Play Movie", or "Resume" for a movie already started.
 *
 * Titles, posters and categories come from the M3U. With an Xtream account (see xtream.ts),
 * cards also show the rating (one request for the whole catalogue, cached for 12 hours), and
 * the dialog loads plot, genre, runtime, cast and a backdrop per movie.
 */
import { CatalogView, cssUrl, formatClock, formatDuration, renderMeta, SummaryCache, tmdbImage, categoryLabel, type CatalogDeps } from './catalog';
import type { Channel } from './lib/m3u';
import { watchedFraction } from './lib/series';
import { fetchVodDetails, fetchVodSummaries, movieId, type VodDetails, type VodSummary } from './lib/xtream';
import { inProgress, progress, startPosition } from './progress';
import { store } from './store';

export interface MovieDeps extends CatalogDeps {
  /** The playlist's movies. */
  movies: () => Channel[];
  play: (movie: Channel, startAt: number) => void;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class MoviesView extends CatalogView<Channel> {
  private summaries: SummaryCache<VodSummary>;
  /** The playlist's movies by their key, for "Continue watching". */
  private byKey = new Map<string, Channel>();

  private els = {
    backdrop: byId('md-backdrop'),
    poster: byId<HTMLImageElement>('md-poster'),
    title: byId('md-title'),
    facts: byId('md-facts'),
    plot: byId('md-plot'),
    meta: byId('md-meta'),
    play: byId<HTMLButtonElement>('md-play'),
    restart: byId<HTMLButtonElement>('md-restart'),
  };

  constructor(private movieDeps: MovieDeps) {
    super(movieDeps, {
      section: 'movie',
      dialogPrefix: 'md',
      text: {
        all: 'All movies',
        favorites: 'Favorite movies',
        one: 'movie',
        many: 'movies',
        noFavorites: 'No favorite movies yet. Open a movie and press ☆.',
        noContinue: 'Nothing started yet. Movies you watch show up here.',
        none: 'This playlist has no movies.',
        search: 'Search movies',
      },
      cardExtraHeight: 62,
    });
    this.summaries = new SummaryCache({
      label: 'movies',
      account: movieDeps.account,
      read: store.getCachedMovieSummaries,
      write: store.cacheMovieSummaries,
      fetch: (account) => fetchVodSummaries(account, movieDeps.fetchUrl),
      changed: () => this.summariesChanged(),
    });

    this.els.play.addEventListener('click', () => this.play(false));
    this.els.restart.addEventListener('click', () => this.play(true));
  }

  playlistChanged(): void {
    this.byKey = new Map(this.movieDeps.movies().map((movie) => [this.movieDeps.keyOf(movie), movie]));
    super.playlistChanged();
  }

  // ---------- CatalogView ----------

  protected items(): Channel[] {
    return this.movieDeps.movies();
  }

  protected nameOf(movie: Channel): string {
    return movie.name;
  }

  protected groupOf(movie: Channel): string {
    return movie.group;
  }

  protected favoriteKey(movie: Channel): string {
    return this.movieDeps.keyOf(movie);
  }

  protected ratingOf(movie: Channel): number | null | undefined {
    const id = movieId(movie.url);
    return id ? this.summaries.get(id)?.rating : undefined;
  }

  protected continueWatching(): Channel[] {
    const movies: Channel[] = [];
    for (const [key, p] of progress.entries()) {
      const movie = this.byKey.get(key);
      if (movie && inProgress(p)) movies.push(movie);
    }
    return movies;
  }

  protected loadSummaries(): void {
    void this.summaries.load();
  }

  protected renderCard(movie: Channel): HTMLElement {
    const p = this.progressOf(movie);
    return this.renderCardShell(movie, movie.logo, inProgress(p) ? watchedFraction(p) : 0).card;
  }

  // ---------- Details dialog ----------

  private progressOf(movie: Channel) {
    return progress.get(this.movieDeps.keyOf(movie));
  }

  private play(fromStart: boolean): void {
    const movie = this.dialogItem;
    this.dialog.close();
    if (movie) this.movieDeps.play(movie, fromStart ? 0 : startPosition(this.progressOf(movie)));
  }

  protected openDetails(movie: Channel): void {
    const run = this.showDialog(movie);
    const { title, year, tag } = this.title(movie);
    const basic = { title, year, tag, poster: movie.logo ?? '', rating: this.ratingOf(movie) ?? null };
    this.showDetails(movie, basic);
    this.els.play.focus();

    const account = this.movieDeps.account();
    const id = movieId(movie.url);
    if (!account || !id) {
      if (!account) this.setStatus('Add an Xtream account in the settings for plot, cast and more.');
      return;
    }
    this.setStatus('Loading details…');
    fetchVodDetails(account, id, this.movieDeps.fetchUrl)
      .then((details) => {
        if (run !== this.detailsRun) return;
        this.setStatus('');
        this.showDetails(movie, { ...basic, title: details.title || title, poster: details.poster || basic.poster, rating: details.rating ?? basic.rating }, details);
      })
      .catch((err: unknown) => {
        if (run === this.detailsRun) this.setStatus(this.detailsError(err));
      });
  }

  private showDetails(
    movie: Channel,
    basic: { title: string; year?: number; tag?: string; poster: string; rating: number | null },
    details?: VodDetails,
  ): void {
    const els = this.els;
    const year = details?.releaseDate ? details.releaseDate.slice(0, 4) : basic.year ? String(basic.year) : '';
    els.title.textContent = basic.title;
    if (year) els.title.append(Object.assign(document.createElement('span'), { className: 'md-year', textContent: ` (${year})` }));

    els.poster.hidden = !basic.poster;
    if (basic.poster) els.poster.src = tmdbImage(basic.poster, 'w500')!;
    els.poster.onerror = () => (els.poster.hidden = true);
    els.backdrop.style.backgroundImage = details?.backdrop ? cssUrl(tmdbImage(details.backdrop, 'w1280')!) : '';
    els.backdrop.hidden = !details?.backdrop;

    const p = this.progressOf(movie);
    const facts: [text: string, className?: string][] = [];
    if (basic.tag) facts.push([basic.tag, 'md-tag']);
    if (basic.rating) facts.push([`★ ${basic.rating.toFixed(1)}`, 'md-rating']);
    if (details?.duration) facts.push([formatDuration(details.duration)]);
    if (details?.genre) facts.push([details.genre]);
    if (details?.age) facts.push([details.age]);
    if (inProgress(p)) facts.push([`${formatDuration(p.duration - p.position)} left`, 'md-progress']);
    els.facts.replaceChildren(...facts.map(([textContent, className = '']) => Object.assign(document.createElement('span'), { textContent, className })));

    els.plot.textContent = details?.plot ?? '';
    els.plot.hidden = !details?.plot;

    const meta: [string, string][] = [];
    if (details?.originalTitle && details.originalTitle !== basic.title) meta.push(['Original title', details.originalTitle]);
    if (details?.releaseDate) meta.push(['Released', details.releaseDate]);
    if (details?.director) meta.push(['Director', details.director]);
    if (details?.cast) meta.push(['Cast', details.cast]);
    if (details?.country) meta.push(['Country', details.country]);
    meta.push(['Category', categoryLabel(movie.group)]);
    const file = [details?.container || /\.(\w+)(?:\?|$)/.exec(movie.url)?.[1] || '', details?.bitrate ? `${(details.bitrate / 1000).toFixed(1)} Mbit/s` : '']
      .filter(Boolean)
      .join(' · ');
    if (file) meta.push(['File', file]);
    renderMeta(els.meta, meta);

    this.renderLinks(details?.trailer, details?.tmdbId, 'movie');

    // Started before: resume where it was left, or start over.
    const resuming = inProgress(p);
    els.play.textContent = resuming ? `▶ Resume (${formatClock(p.position)})` : '▶ Play Movie';
    els.restart.hidden = !resuming;
  }
}
