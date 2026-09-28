/**
 * Info and subtitles for MKV movies, read by the server from the movie data passing through the
 * proxy (server/mkv-subtitles.ts): duration, audio codec and the embedded text subtitles.
 *
 * The browser plays MKV files but hides their embedded subtitle tracks, so this polls for them
 * and turns them into real text tracks on the video element, which the subtitle menu then lists
 * like any other. For movies converted by ffmpeg (Dolby audio), the video element's clock starts
 * at the conversion's start point, so cue times are shifted by that offset.
 *
 * Chrome drops cues added to a track while it's disabled, or just as it's switched on, so every
 * cue is also kept here and (re)added whenever a track is on but missing some.
 */
import { VOD_INFO_PATH } from './lib/proxy';

const POLL_MS = 2000;

export interface VodInfo {
  /** Seconds, or null until the header has been read. */
  duration: number | null;
  /** Matroska codec ID of the first audio track, e.g. "A_EAC3". */
  audioCodec: string | null;
  /** Exact start (seconds) of the converted stream requested with `forStart`, once known. */
  transcodeStart: number | null;
  forStart: number | null;
}

interface ServerTrack {
  number: number;
  language: string;
  name: string;
}

interface ServerCue {
  track: number;
  start: number;
  end: number;
  text: string;
}

interface LocalTrack {
  element: HTMLTrackElement;
  cues: ServerCue[];
  /** VTTCues for the current offset. */
  vtt: VTTCue[];
}

export class VodSubtitles {
  private url = '';
  private cursor = 0;
  private timer = 0;
  private tracks = new Map<number, LocalTrack>();
  /** Seconds to subtract from cue times (start of a converted stream). */
  private offset = 0;
  /** Requested start of the converted stream, to ask the server where it really began. */
  private requestedStart: number | null = null;
  private onInfo: ((info: VodInfo) => void) | null = null;

  constructor(private video: HTMLVideoElement) {
    video.textTracks.addEventListener('change', () => this.refill());
  }

  /** Starts collecting for a movie URL (the original URL, as passed to the proxy). */
  attach(url: string, onInfo: (info: VodInfo) => void): void {
    this.detach();
    this.url = url;
    this.onInfo = onInfo;
    void this.poll();
  }

  isAttached(url: string): boolean {
    return this.url === url;
  }

  /** Channel switch: stop polling and remove this movie's tracks from the video element. */
  detach(): void {
    clearTimeout(this.timer);
    this.url = '';
    this.cursor = 0;
    this.offset = 0;
    this.requestedStart = null;
    this.onInfo = null;
    for (const { element } of this.tracks.values()) element.remove();
    this.tracks.clear();
  }

  /** The movie now plays converted from `start`; its clock starts at the (not yet known) exact start. */
  setRequestedStart(start: number): void {
    this.requestedStart = start;
    this.setOffset(start); // close enough until the server reports the exact start
    clearTimeout(this.timer);
    void this.poll();
  }

  setOffset(offset: number): void {
    if (offset === this.offset) return;
    this.offset = offset;
    for (const local of this.tracks.values()) {
      const { track } = local.element;
      for (const cue of local.vtt) if (track.cues) track.removeCue(cue);
      local.vtt = local.cues.map((c) => this.toVtt(c));
    }
    this.refill();
  }

  private toVtt(cue: ServerCue): VTTCue {
    return new VTTCue(cue.start - this.offset, cue.end - this.offset, cue.text);
  }

  private async poll(): Promise<void> {
    const url = this.url;
    const forStart = this.requestedStart;
    try {
      const start = this.requestedStart === null ? '' : `&start=${this.requestedStart.toFixed(3)}`;
      const res = await fetch(`${VOD_INFO_PATH}?url=${encodeURIComponent(url)}&cursor=${this.cursor}${start}`);
      const data = (await res.json()) as VodInfo & { tracks: ServerTrack[]; cues: ServerCue[]; cursor: number };
      if (url !== this.url) return; // switched channel meanwhile
      for (const track of data.tracks) this.ensureTrack(track);
      for (const cue of data.cues) this.addCue(cue);
      this.cursor = data.cursor;
      this.refill(); // Safety net: restores anything the browser dropped (it's a no-op otherwise).
      this.onInfo?.({ duration: data.duration, audioCodec: data.audioCodec, transcodeStart: data.transcodeStart, forStart });
    } catch {
      // Server busy or restarting: try again next round.
    }
    if (url === this.url) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.poll(), POLL_MS);
    }
  }

  private ensureTrack(track: ServerTrack): void {
    if (this.tracks.has(track.number)) return;
    const element = document.createElement('track');
    element.kind = 'subtitles';
    element.label = track.name;
    element.srclang = track.language === 'und' ? '' : track.language;
    // Switching a track on makes Chrome start "loading" it, which clears cues added just before.
    // Without a src that ends at once in an error event: refill after it.
    element.addEventListener('error', () => this.refill());
    element.addEventListener('load', () => this.refill());
    this.video.append(element);
    this.tracks.set(track.number, { element, cues: [], vtt: [] });
  }

  private addCue(cue: ServerCue): void {
    const local = this.tracks.get(cue.track);
    if (!local) return;
    local.cues.push(cue);
    const vtt = this.toVtt(cue);
    local.vtt.push(vtt);
    if (local.element.track.mode !== 'disabled') local.element.track.addCue(vtt);
  }

  /** Gives every switched-on track the cues it's missing. */
  private refill(): void {
    for (const { element, vtt } of this.tracks.values()) {
      const { track } = element;
      if (track.mode === 'disabled') continue;
      const present = new Set(track.cues ? [...track.cues] : []);
      for (const cue of vtt) if (!present.has(cue)) track.addCue(cue);
    }
  }
}
