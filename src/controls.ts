/**
 * The player's own control bar, replacing the browser's: play/pause, volume, subtitles (wired
 * up by subtitles.ts), fullscreen and a ⋮ menu. Live streams show a LIVE badge and can't be
 * seeked; streams with a known duration (movies, series) get a seek bar and elapsed/total time.
 * The bar hides after a few seconds without mouse movement while playing.
 */
import type { Timeline } from './player';

const IDLE_MS = 3000;

/** 75 → "1:15", 4000 → "1:06:40". */
function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const ICONS = {
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />',
  play: '<path d="M8 5v14l11-7z" />',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />',
  muted: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="M16 9.5l5 5M21 9.5l-5 5" />',
  enterFullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />',
  exitFullscreen: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />',
};

export class PlayerControls {
  private idleTimer = 0;
  private playBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private volume: HTMLInputElement;
  private fullscreenBtn: HTMLButtonElement;
  private moreBtn: HTMLButtonElement;
  private moreMenu: HTMLElement;
  private seekRow: HTMLElement;
  private seek: HTMLInputElement;
  private timeLabel: HTMLElement;
  private liveBadge: HTMLElement;
  /** While the seek thumb is dragged, playback position updates must not move it. */
  private dragging = false;

  constructor(
    private wrap: HTMLElement,
    private video: HTMLVideoElement,
    onReload: () => void,
    /** The player's timeline for movies converted by ffmpeg, whose stream has none. */
    private externalTimeline: () => Timeline | null = () => null,
  ) {
    const find = <T extends HTMLElement>(id: string) => wrap.querySelector<T>(`#${id}`)!;
    this.playBtn = find('play-btn');
    this.muteBtn = find('mute-btn');
    this.volume = find('volume');
    this.fullscreenBtn = find('fullscreen-btn');
    this.moreBtn = find('more-btn');
    this.moreMenu = find('more-menu');
    this.seekRow = find('seek-row');
    this.seek = find('seek');
    this.timeLabel = find('ctl-time');
    this.liveBadge = find('ctl-live');
    const pipItem = find<HTMLButtonElement>('pip-item');

    // Mouse clicks shouldn't leave focus on a control: Space would then press that button instead
    // of pausing, and the bar would never auto-hide. Keyboard users still reach them with Tab.
    for (const btn of wrap.querySelectorAll<HTMLElement>('.ctl-btn')) {
      btn.addEventListener('mousedown', (event) => event.preventDefault());
    }

    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.muteBtn.addEventListener('click', () => (video.muted = !video.muted));
    this.volume.addEventListener('input', () => {
      video.volume = Number(this.volume.value);
      video.muted = video.volume === 0;
    });
    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

    // Seek on release, not on every drag step: each seek of a remote movie is a new download.
    this.seek.addEventListener('input', () => {
      this.dragging = true;
      this.renderProgress(this.seekTarget());
    });
    this.seek.addEventListener('change', () => {
      this.dragging = false;
      this.timeline()?.seek(this.seekTarget());
      this.syncMode();
    });
    // Sliders keep focus after a mouse drag, which would swallow Space and keep the bar visible.
    for (const slider of [this.seek, this.volume]) {
      slider.addEventListener('pointerup', () => slider.blur());
    }
    for (const type of ['durationchange', 'loadedmetadata', 'emptied']) video.addEventListener(type, () => this.syncMode());
    // syncMode, not just syncProgress: a converted movie's duration arrives later, from the server.
    for (const type of ['timeupdate', 'progress', 'seeking']) video.addEventListener(type, () => this.syncMode());
    video.addEventListener('dblclick', () => this.toggleFullscreen());

    this.moreBtn.addEventListener('click', () => this.setMoreOpen(!!this.moreMenu.hidden));
    pipItem.hidden = !document.pictureInPictureEnabled;
    pipItem.addEventListener('click', () => {
      this.setMoreOpen(false);
      if (document.pictureInPictureElement) void document.exitPictureInPicture();
      else void video.requestPictureInPicture().catch(() => {});
    });
    find('reload-item').addEventListener('click', () => {
      this.setMoreOpen(false);
      onReload();
    });
    // Any click outside the button and menu closes it (including opening the subtitle menu).
    document.addEventListener('click', (event) => {
      const target = event.target as Node;
      if (!this.moreBtn.contains(target) && !this.moreMenu.contains(target)) this.setMoreOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.moreMenu.hidden) {
        this.setMoreOpen(false);
        this.moreBtn.focus();
      }
    });

    for (const type of ['play', 'pause', 'emptied']) video.addEventListener(type, () => this.syncPlay());
    video.addEventListener('volumechange', () => this.syncVolume());
    document.addEventListener('fullscreenchange', () => this.syncFullscreen());

    // Auto-hide: any pointer activity shows the bar; it hides again after IDLE_MS while playing.
    wrap.addEventListener('pointermove', () => this.wake());
    wrap.addEventListener('pointerdown', () => this.wake());
    wrap.addEventListener('pointerleave', () => this.sleep());
    wrap.addEventListener('focusin', () => this.wake());

    this.syncPlay();
    this.syncVolume();
    this.syncFullscreen();
    this.syncMode();
  }

  /**
   * The timeline to show: the player's for movies converted by ffmpeg (their stream has no
   * duration), else the video element's own. Live streams have none (duration Infinity).
   */
  private timeline(): Timeline | null {
    const external = this.externalTimeline();
    if (external) return external;
    const { duration, currentTime, buffered } = this.video;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    let bufferedEnd = currentTime;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime + 0.5 && buffered.end(i) > bufferedEnd) bufferedEnd = buffered.end(i);
    }
    return { duration, position: currentTime, bufferedEnd, seek: (t) => (this.video.currentTime = t) };
  }

  /** Movies and series have a timeline; live streams don't. */
  get isVod(): boolean {
    return this.timeline() !== null;
  }

  /** Jumps within a movie (←/→ keys). Returns false for live streams, which can't seek. */
  seekBy(seconds: number): boolean {
    const timeline = this.timeline();
    if (!timeline) return false;
    timeline.seek(Math.min(Math.max(timeline.position + seconds, 0), timeline.duration - 0.5));
    this.syncMode();
    this.wake();
    return true;
  }

  togglePlay(): void {
    if (this.video.paused) void this.video.play().catch(() => {});
    else this.video.pause();
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.wrap.requestFullscreen();
  }

  /** Shows the bar and restarts the hide timer. */
  wake(): void {
    this.wrap.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.sleep(), IDLE_MS);
  }

  private sleep(): void {
    clearTimeout(this.idleTimer);
    // Keep the bar while paused, while a menu is open, or while it has keyboard focus.
    const menuOpen = !!this.wrap.querySelector('.ctl-menu:not([hidden])');
    if (this.video.paused || menuOpen || this.wrap.querySelector('.controls:focus-within')) return;
    this.wrap.classList.add('idle');
  }

  private setMoreOpen(open: boolean): void {
    if (this.moreMenu.hidden === !open) return;
    this.moreMenu.hidden = !open;
    this.moreBtn.ariaExpanded = String(open);
    if (open) this.moreMenu.querySelector<HTMLElement>('.menu-item:not([hidden])')?.focus();
  }

  private seekTarget(): number {
    return (Number(this.seek.value) / Number(this.seek.max)) * (this.timeline()?.duration ?? 0);
  }

  private syncMode(): void {
    const vod = this.isVod;
    this.seekRow.hidden = !vod;
    this.timeLabel.hidden = !vod;
    this.liveBadge.hidden = vod;
    this.syncProgress();
  }

  private syncProgress(): void {
    const timeline = this.timeline();
    if (!timeline || this.dragging) return;
    this.seek.value = String(Math.round((timeline.position / timeline.duration) * Number(this.seek.max)));
    this.renderProgress(timeline.position);
  }

  /** Updates the time label and the played/buffered fill of the seek bar for position `time`. */
  private renderProgress(time: number): void {
    const timeline = this.timeline();
    if (!timeline) return;
    const { duration } = timeline;
    const bufferedEnd = Math.max(time, timeline.bufferedEnd);
    this.seek.style.setProperty('--played', `${(time / duration) * 100}%`);
    this.seek.style.setProperty('--buffered', `${(bufferedEnd / duration) * 100}%`);
    this.timeLabel.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
  }

  private setIcon(button: HTMLButtonElement, paths: string): void {
    button.querySelector('svg')!.innerHTML = paths;
  }

  private syncPlay(): void {
    const paused = this.video.paused;
    this.setIcon(this.playBtn, paused ? ICONS.play : ICONS.pause);
    const label = paused ? 'Play' : 'Pause';
    this.playBtn.ariaLabel = label;
    this.playBtn.title = `${label} (Space)`;
    if (paused) this.wake();
  }

  private syncVolume(): void {
    const { muted, volume } = this.video;
    this.setIcon(this.muteBtn, muted || volume === 0 ? ICONS.muted : ICONS.volume);
    this.muteBtn.ariaLabel = muted ? 'Unmute' : 'Mute';
    this.muteBtn.title = `${muted ? 'Unmute' : 'Mute'} (M)`;
    this.volume.value = String(muted ? 0 : volume);
  }

  private syncFullscreen(): void {
    const full = document.fullscreenElement === this.wrap;
    this.setIcon(this.fullscreenBtn, full ? ICONS.exitFullscreen : ICONS.enterFullscreen);
    this.fullscreenBtn.ariaLabel = full ? 'Exit fullscreen' : 'Fullscreen';
    this.fullscreenBtn.title = `${full ? 'Exit fullscreen' : 'Fullscreen'} (F)`;
  }
}
