/**
 * DVB bitmap subtitles for raw MPEG-TS streams (mpegts.js exposes none of its own).
 *
 * The player feeds in the stream's PMT descriptors, which announce the subtitle tracks, and
 * the raw subtitle PES packets. Only the selected track is decoded. Its display sets are
 * queued by presentation time and drawn on a canvas laid over the video picture, timed
 * against video.currentTime, which shares mpegts.js's timeline.
 */
import { DvbSubtitleDecoder, type DisplaySet } from './lib/dvb-subtitle-decoder';

export interface BitmapSubtitleTrack {
  id: string;
  pid: number;
  /** ISO 639-2 code from the stream, e.g. "nor". */
  language: string;
  hardOfHearing: boolean;
  pageIds: number[];
}

/** Descriptor tag announcing DVB subtitle tracks (EN 300 468, 6.2.41). */
const SUBTITLING_DESCRIPTOR = 0x59;
/** Show a display set this many seconds early, so it doesn't lag one frame behind. */
const EARLY_S = 0.02;
/** Safety cap in case timestamps are far ahead of the video clock. */
const MAX_QUEUE = 200;

export class BitmapSubtitles {
  private tracks: BitmapSubtitleTrack[] = [];
  private selectedId: string | null = null;
  private decoder: DvbSubtitleDecoder | null = null;
  private queue: DisplaySet[] = [];
  private shown: DisplaySet | null = null;
  private frame = 0;
  private listeners = new Set<() => void>();
  private ctx: CanvasRenderingContext2D;

  constructor(
    private video: HTMLVideoElement,
    private canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.layout()).observe(video);
    video.addEventListener('resize', () => this.layout());
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  list(): readonly BitmapSubtitleTrack[] {
    return this.tracks;
  }

  selected(): string | null {
    return this.selectedId;
  }

  /** Registers the DVB subtitle tracks announced in a private-data PID's PMT descriptors. */
  addDescriptors(pid: number, descriptors: Uint8Array): void {
    let added = false;
    for (let i = 0; i + 2 <= descriptors.length; i += 2 + descriptors[i + 1]) {
      if (descriptors[i] !== SUBTITLING_DESCRIPTOR) continue;
      const end = Math.min(i + 2 + descriptors[i + 1], descriptors.length);
      for (let o = i + 2; o + 8 <= end; o += 8) {
        const composition = (descriptors[o + 4] << 8) | descriptors[o + 5];
        const id = `${pid}:${composition}`;
        if (this.tracks.some((t) => t.id === id)) continue; // The PMT repeats every ~100 ms.
        const type = descriptors[o + 3];
        this.tracks.push({
          id,
          pid,
          language: String.fromCharCode(descriptors[o], descriptors[o + 1], descriptors[o + 2]),
          hardOfHearing: type >= 0x20 && type <= 0x25,
          pageIds: [composition, (descriptors[o + 6] << 8) | descriptors[o + 7]],
        });
        added = true;
      }
    }
    if (added) this.notify();
  }

  /** Feeds a private-data PES payload. `ptsMs` is on mpegts.js's media timeline, in milliseconds. */
  push(pid: number, ptsMs: number | undefined, data: Uint8Array): void {
    if (!this.decoder || ptsMs === undefined || pid !== this.current()?.pid) return;
    this.decoder.push(data, ptsMs / 1000);
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.queue = [];
    this.show(null);
    const track = this.current();
    this.decoder = track ? new DvbSubtitleDecoder(new Set(track.pageIds), (set) => this.enqueue(set)) : null;
    cancelAnimationFrame(this.frame);
    if (track) this.frame = requestAnimationFrame(this.tick);
    this.notify();
  }

  /** Channel switch: forget the tracks; the next stream starts with subtitles off. */
  reset(): void {
    this.tracks = [];
    this.select(null);
  }

  private current(): BitmapSubtitleTrack | undefined {
    return this.tracks.find((t) => t.id === this.selectedId);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private enqueue(set: DisplaySet): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].pts > set.pts) i--;
    this.queue.splice(i, 0, set);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  private tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    const time = this.video.currentTime + EARLY_S;

    // The newest display set that has started is the one on screen; older ones are done.
    let latest = -1;
    while (latest + 1 < this.queue.length && this.queue[latest + 1].pts <= time) latest++;
    if (latest > 0) this.queue.splice(0, latest);
    let active: DisplaySet | null = latest >= 0 ? this.queue[0] : null;
    // page_time_out: the page disappears if nothing replaces it in time (0 = no timeout).
    if (active && active.timeout && time > active.pts + active.timeout) active = null;
    if (active !== this.shown) this.show(active);
  };

  private show(set: DisplaySet | null): void {
    this.shown = set;
    const { canvas, ctx } = this;
    if (set && (canvas.width !== set.displayWidth || canvas.height !== set.displayHeight)) {
      canvas.width = set.displayWidth;
      canvas.height = set.displayHeight;
      this.layout();
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = !set?.bitmaps.length;
    for (const b of set?.bitmaps ?? []) ctx.putImageData(new ImageData(b.rgba, b.width, b.height), b.x, b.y);
  }

  /** Lays the canvas exactly over the video picture (the <video> letterboxes with object-fit: contain). */
  private layout(): void {
    const { videoWidth, videoHeight, clientWidth, clientHeight, offsetLeft, offsetTop } = this.video;
    if (!videoWidth || !videoHeight) return;
    const scale = Math.min(clientWidth / videoWidth, clientHeight / videoHeight);
    const width = videoWidth * scale;
    const height = videoHeight * scale;
    Object.assign(this.canvas.style, {
      left: `${offsetLeft + (clientWidth - width) / 2}px`,
      top: `${offsetTop + (clientHeight - height) / 2}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }
}
