/**
 * The SERIES section: categories in the sidebar, series as poster cards, a details dialog with
 * "Resume watching", and while an episode plays, the seasons and episodes under the player.
 *
 * Series, seasons and episodes come from the M3U (see lib/series.ts). With an Xtream account,
 * cards get covers and ratings (one list for the whole catalogue, cached for 12 hours), and
 * opening a series loads its plot, cast and the episodes' titles, plots, runtimes and stills.
 */
import {
  CatalogView,
  categoryLabel,
  cssUrl,
  formatDuration,
  plural,
  renderMeta,
  renderWatchBar,
  SummaryCache,
  tmdbImage,
  type CatalogDeps,
} from './catalog';
import type { Channel } from './lib/m3u';
import {
  allEpisodes,
  cleanEpisodeTitle,
  episodeCode,
  isFinished,
  resumeTarget,
  seasonName,
  seriesKey,
  watchedFraction,
  type Episode,
  type Series,
} from './lib/series';
import {
  episodeId,
  fetchSeriesDetails,
  fetchSeriesSummaries,
  XtreamError,
  type EpisodeInfo,
  type SeriesDetails,
  type SeriesSummary,
} from './lib/xtream';
import { progress, startPosition } from './progress';
import { store } from './store';

export interface SeriesDeps extends CatalogDeps {
  /** The playlist's series. */
  series: () => Series[];
  play: (episode: Channel, startAt: number) => void;
  /** What's playing, to highlight its episode. */
  current: () => Channel | null;
  /** Episode titles arrived: the now-playing bar can show them. */
  changed: () => void;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class SeriesView extends CatalogView<Series> {
  private summaries: SummaryCache<SeriesSummary>;
  private details = new Map<string, SeriesDetails>();
  private detailsLoading = new Map<string, Promise<SeriesDetails | null>>();
  /** Each episode's series, by the episode's key. */
  private episodes = new Map<string, { series: Series; episode: Episode }>();
  /** The series whose seasons and episodes show under the player, and the season shown. */
  private panelSeries: Series | null = null;
  private panelSeason = 1;

  private els = {
    backdrop: byId('sd-backdrop'),
    poster: byId<HTMLImageElement>('sd-poster'),
    title: byId('sd-title'),
    facts: byId('sd-facts'),
    plot: byId('sd-plot'),
    meta: byId('sd-meta'),
    play: byId<HTMLButtonElement>('sd-play'),
    seasonTabs: byId('season-tabs'),
    episodeList: byId('episode-list'),
  };

  constructor(private seriesDeps: SeriesDeps) {
    super(seriesDeps, {
      section: 'series',
      dialogPrefix: 'sd',
      text: {
        all: 'All series',
        favorites: 'Favorite series',
        one: 'series',
        many: 'series',
        noFavorites: 'No favorite series yet. Open a series and press ☆.',
        noContinue: 'Nothing started yet. Series you watch show up here.',
        none: 'This playlist has no series.',
        search: 'Search series',
      },
      cardExtraHeight: 80,
    });
    this.summaries = new SummaryCache({
      label: 'series',
      account: seriesDeps.account,
      read: store.getCachedSeriesSummaries,
      write: store.cacheSeriesSummaries,
      fetch: (account) => fetchSeriesSummaries(account, seriesDeps.fetchUrl, seriesKey),
      changed: () => {
        this.summariesChanged();
        const series = this.dialogItem;
        if (series && this.dialog.open) this.showDetails(series, this.details.get(series.key));
      },
      // Another account: its series IDs and details don't apply.
      reset: () => {
        this.details.clear();
        this.detailsLoading.clear();
      },
    });

    this.els.play.addEventListener('click', () => {
      const target = this.dialogItem && resumeTarget(this.dialogItem, this.progressOf);
      this.dialog.close();
      if (target) this.seriesDeps.play(target.episode.channel, target.startAt);
    });
    this.els.seasonTabs.addEventListener('click', (event) => {
      const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-season]');
      if (!tab) return;
      this.panelSeason = Number(tab.dataset.season);
      this.renderPanel();
    });
    this.els.episodeList.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
      const entry = row && this.episodes.get(row.dataset.key!);
      if (entry) this.seriesDeps.play(entry.episode.channel, startPosition(this.progressOf(entry.episode)));
    });
  }

  playlistChanged(): void {
    this.episodes = new Map();
    for (const series of this.seriesDeps.series()) {
      for (const episode of allEpisodes(series)) this.episodes.set(this.seriesDeps.keyOf(episode.channel), { series, episode });
    }
    // Rebind the panel to the new playlist's objects.
    this.panelSeries = this.entryOf(this.seriesDeps.current())?.series ?? null;
    super.playlistChanged();
  }

  /** An episode's favorite key is its series'. */
  favoriteKeyOf(episode: Channel): string | null {
    const entry = this.entryOf(episode);
    return entry ? this.favoriteKey(entry.series) : null;
  }

  // ---------- CatalogView ----------

  protected items(): Series[] {
    return this.seriesDeps.series();
  }

  protected nameOf(series: Series): string {
    return series.name;
  }

  protected groupOf(series: Series): string {
    return series.group;
  }

  protected favoriteKey(series: Series): string {
    return `series:${series.key}`;
  }

  protected ratingOf(series: Series): number | null | undefined {
    return this.summaries.get(series.key)?.rating;
  }

  protected yearOf(series: Series): number | undefined {
    return this.title(series).year ?? this.summaries.get(series.key)?.year ?? undefined;
  }

  /** Series with an episode in progress, or a next one to watch, most recently watched first. */
  protected continueWatching(): Series[] {
    const seen = new Set<Series>();
    const result: Series[] = [];
    for (const [key] of progress.entries()) {
      const series = this.episodes.get(key)?.series;
      if (!series || seen.has(series)) continue;
      seen.add(series);
      if (resumeTarget(series, this.progressOf)?.kind === 'resume') result.push(series);
    }
    return result;
  }

  protected loadSummaries(): void {
    void this.summaries.load();
  }

  protected renderCard(series: Series): HTMLElement {
    const episodes = allEpisodes(series);
    const watched = episodes.reduce((n, ep) => n + watchedFraction(this.progressOf(ep)), 0);
    // A sliver at least, so a started series shows it.
    const fraction = watched > 0 ? Math.max(0.03, watched / episodes.length) : 0;
    const { card } = this.renderCardShell(series, this.summaries.get(series.key)?.cover || series.logo, fraction);
    card.classList.add('series-card');
    card.append(Object.assign(document.createElement('div'), { className: 'series-counts', textContent: this.countsLabel(series) }));
    return card;
  }

  // ---------- Details ----------

  private progressOf = (episode: Episode) => progress.get(this.seriesDeps.keyOf(episode.channel));

  private entryOf(channel: Channel | null) {
    return channel ? this.episodes.get(this.seriesDeps.keyOf(channel)) : undefined;
  }

  private countsLabel(series: Series): string {
    const seasons = series.seasons.filter((s) => s.number !== 0).length || series.seasons.length;
    return `${plural(seasons, 'season')} · ${plural(series.episodeCount, 'episode')}`;
  }

  /** Plot, cast and the episodes' titles for one series (once per session). Null without an account. */
  private async loadDetails(series: Series): Promise<SeriesDetails | null> {
    const cached = this.details.get(series.key);
    if (cached) return cached;
    let loading = this.detailsLoading.get(series.key);
    if (!loading) {
      loading = (async () => {
        const account = this.seriesDeps.account();
        if (!account) return null;
        await this.summaries.load();
        const id = this.summaries.get(series.key)?.id;
        if (!id) {
          // Without the series list there's no ID to ask for: say why, rather than "no details".
          if (this.summaries.error) throw new XtreamError(`the series list did not load (${this.summaries.error.message})`);
          return null;
        }
        const details = await fetchSeriesDetails(account, id, this.seriesDeps.fetchUrl);
        if (this.detailsLoading.get(series.key) === loading) this.details.set(series.key, details);
        return details;
      })();
      this.detailsLoading.set(series.key, loading);
      // Failures may be temporary: allow a retry the next time.
      loading.catch(() => {}).finally(() => this.detailsLoading.delete(series.key));
    }
    return loading;
  }

  private episodeInfo(series: Series, episode: Episode): EpisodeInfo | undefined {
    const id = episodeId(episode.channel.url);
    return id ? this.details.get(series.key)?.episodes.get(id) : undefined;
  }

  private episodeTitle(series: Series, episode: Episode): string {
    const info = this.episodeInfo(series, episode);
    return info ? cleanEpisodeTitle(info.title) : '';
  }

  protected openDetails(series: Series): void {
    const run = this.showDialog(series);
    this.showDetails(series, this.details.get(series.key));
    this.els.play.focus();

    if (this.details.has(series.key)) return;
    if (!this.seriesDeps.account()) {
      this.setStatus('Add an Xtream account in the settings for plot, cast and episode titles.');
      return;
    }
    this.setStatus('Loading details…');
    this.loadDetails(series)
      .then((details) => {
        if (run !== this.detailsRun) return;
        this.setStatus(details ? '' : 'The provider has no details for this series.');
        if (details) this.showDetails(series, details);
      })
      .catch((err: unknown) => {
        if (run === this.detailsRun) this.setStatus(this.detailsError(err));
      });
  }

  private showDetails(series: Series, details?: SeriesDetails): void {
    const els = this.els;
    const { title, tag } = this.title(series);
    const summary = this.summaries.get(series.key);
    const shownYear = details?.releaseDate.slice(0, 4) || this.yearOf(series) || '';
    els.title.textContent = title;
    if (shownYear) els.title.append(Object.assign(document.createElement('span'), { className: 'md-year', textContent: ` (${shownYear})` }));

    const poster = tmdbImage(details?.cover || summary?.cover || series.logo, 'w500') ?? '';
    els.poster.hidden = !poster;
    if (poster) els.poster.src = poster;
    els.poster.onerror = () => (els.poster.hidden = true);
    els.backdrop.style.backgroundImage = details?.backdrop ? cssUrl(tmdbImage(details.backdrop, 'w1280')!) : '';
    els.backdrop.hidden = !details?.backdrop;

    const rating = details?.rating ?? summary?.rating;
    const facts: [text: string, className?: string][] = [];
    if (tag) facts.push([tag, 'md-tag']);
    if (rating) facts.push([`★ ${rating.toFixed(1)}`, 'md-rating']);
    facts.push([this.countsLabel(series)]);
    if (details?.genre) facts.push([details.genre]);
    els.facts.replaceChildren(...facts.map(([textContent, className = '']) => Object.assign(document.createElement('span'), { textContent, className })));

    els.plot.textContent = details?.plot ?? '';
    els.plot.hidden = !details?.plot;

    const meta: [string, string][] = [];
    if (details?.releaseDate) meta.push(['First aired', details.releaseDate]);
    if (details?.director) meta.push(['Created by', details.director]);
    if (details?.cast) meta.push(['Cast', details.cast]);
    meta.push(['Category', categoryLabel(series.group)]);
    renderMeta(els.meta, meta);

    this.renderLinks(details?.trailer, details?.tmdbId, 'tv');
    this.renderResumeButton(series);
  }

  /** "▶ Resume watching (S2 E5 · Title)", "▶ Start watching (S1 E1 · Pilot)" or "▶ Watch again (…)". */
  private renderResumeButton(series: Series): void {
    const target = resumeTarget(series, this.progressOf);
    this.els.play.disabled = !target;
    if (!target) return;
    const verb = { resume: 'Resume watching', start: 'Start watching', again: 'Watch again' }[target.kind];
    const episodeTitle = this.episodeTitle(series, target.episode);
    this.els.play.textContent = `▶ ${verb} (${[episodeCode(target.episode), episodeTitle].filter(Boolean).join(' · ')})`;
  }

  // ---------- Seasons and episodes under the player ----------

  /** An episode started: show its series' seasons, with its season selected. */
  playing(episode: Channel): void {
    const entry = this.entryOf(episode);
    if (!entry) return;
    const changedSeries = entry.series !== this.panelSeries;
    this.panelSeries = entry.series;
    this.panelSeason = entry.episode.season;
    this.renderPanel();
    this.scrollToCurrent(changedSeries ? 'instant' : 'smooth');
    if (!this.details.has(entry.series.key)) {
      this.loadDetails(entry.series)
        .then((details) => {
          if (!details || this.panelSeries !== entry.series) return;
          this.renderPanel();
          this.seriesDeps.changed();
        })
        .catch(() => {}); // the list works without titles
    }
  }

  /** For the now-playing bar: the series title, and "S1 E2 · Pilot". */
  describe(episode: Channel): { name: string; detail: string } | null {
    const entry = this.entryOf(episode);
    if (!entry) return null;
    const episodeTitle = this.episodeTitle(entry.series, entry.episode);
    return { name: this.title(entry.series).title, detail: [episodeCode(entry.episode), episodeTitle].filter(Boolean).join(' · ') };
  }

  /** The episode after this one, for playing on when it ends. */
  nextEpisode(episode: Channel): Channel | null {
    const entry = this.entryOf(episode);
    if (!entry) return null;
    const list = allEpisodes(entry.series);
    return list[list.indexOf(entry.episode) + 1]?.channel ?? null;
  }

  /** The playing episode's progress was saved: update its bar. */
  progressChanged(episode: Channel): void {
    const key = this.seriesDeps.keyOf(episode);
    const row = this.els.episodeList.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    const entry = this.episodes.get(key);
    if (!row || !entry) return;
    const focused = row.contains(document.activeElement);
    const next = this.renderEpisode(entry.series, entry.episode);
    row.replaceWith(next);
    if (focused) next.focus();
  }

  private renderPanel(): void {
    const series = this.panelSeries;
    if (!series) {
      this.els.seasonTabs.replaceChildren();
      this.els.episodeList.replaceChildren();
      return;
    }
    const season = series.seasons.find((s) => s.number === this.panelSeason) ?? series.seasons[0];
    this.panelSeason = season.number;
    this.els.seasonTabs.replaceChildren(
      ...series.seasons.map((s) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'season-tab';
        tab.role = 'tab';
        tab.dataset.season = String(s.number);
        tab.ariaSelected = String(s === season);
        tab.textContent = seasonName(s.number);
        // Seasons fully watched get a check mark.
        if (s.episodes.every((ep) => watchedFraction(this.progressOf(ep)) === 1)) {
          tab.append(Object.assign(document.createElement('span'), { className: 'season-done', textContent: ' ✓' }));
        }
        return tab;
      }),
    );
    this.els.episodeList.replaceChildren(...season.episodes.map((ep) => this.renderEpisode(series, ep)));
  }

  private scrollToCurrent(behavior: ScrollBehavior): void {
    const row = this.els.episodeList.querySelector<HTMLElement>('.episode[aria-current="true"]');
    if (row) row.scrollIntoView({ block: 'nearest', behavior });
    this.els.seasonTabs.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
  }

  private renderEpisode(series: Series, episode: Episode): HTMLElement {
    const info = this.episodeInfo(series, episode);
    const key = this.seriesDeps.keyOf(episode.channel);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'episode';
    row.dataset.key = key;
    if (this.entryOf(this.seriesDeps.current())?.episode === episode) row.ariaCurrent = 'true';
    if (info?.plot) row.title = info.plot;

    const thumb = document.createElement('div');
    thumb.className = 'episode-thumb';
    const image = tmdbImage(info?.image || episode.channel.logo, 'w300');
    if (image) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = image;
      img.addEventListener('error', () => img.remove(), { once: true });
      thumb.append(img);
    }
    thumb.append(Object.assign(document.createElement('span'), { className: 'episode-number', textContent: String(episode.episode) }));
    // The blue bar: empty, part-filled while in progress, full once watched.
    const p = this.progressOf(episode);
    thumb.append(renderWatchBar(watchedFraction(p)));

    const text = document.createElement('div');
    text.className = 'episode-text';
    const title = document.createElement('div');
    title.className = 'episode-title';
    title.textContent = `${episode.episode}. ${this.episodeTitle(series, episode) || `Episode ${episode.episode}`}`;
    const meta = document.createElement('div');
    meta.className = 'episode-meta';
    const duration = info?.duration ?? p?.duration;
    const facts: string[] = [];
    if (p && isFinished(p)) facts.push('Watched');
    else if (p && p.position > 0) facts.push(`${formatDuration(p.duration - p.position)} left`);
    else if (duration) facts.push(formatDuration(duration));
    if (info?.airDate) facts.push(info.airDate);
    meta.textContent = facts.join(' · ');
    text.append(title, meta);
    if (info?.plot) text.append(Object.assign(document.createElement('div'), { className: 'episode-plot', textContent: info.plot }));

    row.append(thumb, text);
    return row;
  }
}
