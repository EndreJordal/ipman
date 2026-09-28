import Hls, { type ErrorData } from 'hls.js';
import mpegts from 'mpegts.js';
import type { BitmapSubtitles } from './bitmap-subtitles';
import type { VodInfo, VodSubtitles } from './vod-subtitles';
import { proxyUrl, transcodeUrl } from './lib/proxy';

export type PlayerStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'playing' }
  /** The browser blocked autoplay; the user has to press play. */
  | { state: 'blocked' }
  | { state: 'error'; message: string };

type Engine = 'hls' | 'mpegts' | 'native';

/** Seconds of video to buffer before playback starts, and before it resumes after a stall. */
const START_BUFFER_S = 3;
const REBUFFER_S = 3;
/** Start anyway after this long if the stream can't reach the buffer target. */
const MAX_BUFFER_WAIT_MS = 10_000;
const BUFFER_POLL_MS = 200;

const CODEC_MESSAGE = 'Unsupported codec: this stream probably uses HEVC video or AC-3 audio, which this browser cannot decode.';
const FFMPEG_MISSING_MESSAGE =
  "This channel's audio is Dolby Digital (AC-3), which browsers can't play. ipman can convert it, " +
  "but ffmpeg isn't installed on the ipman server: run `winget install Gyan.FFmpeg`, then restart ipman.";

/** Dolby audio: mpegts.js can demux it, but most browsers (Chrome, Firefox) can't decode it. */
function unsupportedAudio(codec: string | undefined): boolean {
  return !!codec && /^(ac-3|ec-3)$/i.test(codec) && !MediaSource.isTypeSupported(`audio/mp4; codecs="${codec}"`);
}

/**
 * Matroska audio codecs Chrome can't decode, with the codec string to double-check (Edge or
 * Safari may support some). For MKV files Chrome gives no error: it plays the video silently.
 */
const MKV_UNSUPPORTED_AUDIO: [prefix: string, codec: string][] = [
  ['A_EAC3', 'ec-3'],
  ['A_AC3', 'ac-3'],
  ['A_DTS', 'dtsc'],
  ['A_TRUEHD', 'mlpa'],
];

function mkvAudioPlayable(codec: string | null): boolean {
  const known = codec ? MKV_UNSUPPORTED_AUDIO.find(([prefix]) => codec.startsWith(prefix)) : undefined;
  return !known || MediaSource.isTypeSupported(`audio/mp4; codecs="${known[1]}"`);
}

function isMkv(url: string): boolean {
  try {
    return /\.mkv$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Wait for the user to stop pressing ←/→ before restarting ffmpeg at the new position. */
const SEEK_DEBOUNCE_MS = 400;
/** A converted movie stuck without new data this long is restarted at its current position. */
const STALL_RESTART_MS = 8000;

/** A seekable timeline for the control bar, for movies whose stream doesn't provide one. */
export interface Timeline {
  duration: number;
  position: number;
  bufferedEnd: number;
  seek(seconds: number): void;
}

const TRANSCODE_KEY = 'ipman.transcodeChannels';
/** Channels known to need audio conversion, so they start converted instead of failing first. */
const transcodeChannels = new Set<string>(JSON.parse(localStorage.getItem(TRANSCODE_KEY) ?? '[]') as string[]);

function rememberTranscode(url: string): void {
  if (transcodeChannels.has(url)) return;
  transcodeChannels.add(url);
  localStorage.setItem(TRANSCODE_KEY, JSON.stringify([...transcodeChannels].slice(-500)));
}

/** Picks a playback engine from the URL. Extensionless URLs try HLS first, then fall back to MPEG-TS. */
function guessEngine(url: string): { engine: Engine; fallback: Engine | null } {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    // Unparseable URL: let the engines report the failure.
  }
  if (/\.m3u8?$/.test(path)) return { engine: 'hls', fallback: null };
  if (/\.ts$/.test(path)) return { engine: 'mpegts', fallback: null };
  if (/\.(mp4|m4v|webm|mkv|mov|mp3|aac|ogg)$/.test(path)) return { engine: 'native', fallback: null };
  return { engine: 'hls', fallback: 'mpegts' };
}

const PROBE_TIMEOUT_MS = 8000;
const LEARNED_KEY = 'ipman.engineByOrigin';

/**
 * Engines detected for extensionless URLs, keyed by origin. IPTV providers serve every channel
 * the same way, so after the first probe, channels from that server start without probing.
 */
const learnedEngines = new Map<string, Engine>(
  Object.entries(JSON.parse(localStorage.getItem(LEARNED_KEY) ?? '{}') as Record<string, Engine>),
);

function learnEngine(origin: string, engine: Engine): void {
  learnedEngines.set(origin, engine);
  localStorage.setItem(LEARNED_KEY, JSON.stringify(Object.fromEntries(learnedEngines)));
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Reads the response headers and first chunk to tell an HLS playlist from a raw MPEG-TS stream. */
async function probeEngine(src: string, signal: AbortSignal): Promise<Engine | null> {
  try {
    const res = await fetch(src, { signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    void reader.cancel(); // Close the connection; many providers allow only one at a time.

    const type = res.headers.get('content-type') ?? '';
    const head = value ? new TextDecoder().decode(value.subarray(0, 16)).trim() : '';
    if (/mpegurl/i.test(type) || head.startsWith('#EXTM3U')) return 'hls';
    if (/mp2t/i.test(type) || value?.[0] === 0x47) return 'mpegts'; // 0x47 = MPEG-TS sync byte
    if (/^(video|audio)\//i.test(type)) return 'native';
    return null;
  } catch {
    return null; // Timeout, network or CORS error: fall back to guessing.
  }
}

function describeHlsError(data: ErrorData): string {
  switch (data.details) {
    case Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR:
    case Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR:
    case Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR:
      return CODEC_MESSAGE;
    case Hls.ErrorDetails.MANIFEST_PARSING_ERROR:
      return 'The server did not return a valid HLS playlist.';
  }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    const code = data.response?.code;
    return code ? `Stream unavailable (HTTP ${code}).` : 'Could not reach the stream.';
  }
  return `Playback failed (${data.details}).`;
}

function describeTsError(type: string, detail: string, info: { code?: number; msg?: string } | undefined): string {
  if (detail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED) return CODEC_MESSAGE;
  if (type === mpegts.ErrorTypes.NETWORK_ERROR) {
    return info?.code && info.code > 0 ? `Stream unavailable (HTTP ${info.code}).` : 'Could not reach the stream.';
  }
  return `Playback failed (${info?.msg ?? detail}).`;
}

export class Player {
  private hls?: Hls;
  private ts?: ReturnType<typeof mpegts.createPlayer>;
  private cleanup?: () => void;
  /** Incremented on every play/stop so callbacks from a previous stream are ignored. */
  private session = 0;
  private bufferTimer = 0;
  /** The channel URL currently playing (before proxying), needed to restart it through ffmpeg. */
  private url = '';
  /**
   * A movie played through ffmpeg (Dolby/DTS audio). Its stream is live-style with no duration,
   * so the timeline lives here: `requested` is where ffmpeg was asked to start, `start` where
   * its output really begins (the video element's currentTime 0), once the server reports it.
   */
  private vod: { duration: number; requested: number; start: number | null } | null = null;
  private seekTimer = 0;
  private stallWatch = 0;

  constructor(
    private video: HTMLVideoElement,
    private onStatus: (status: PlayerStatus) => void,
    /** Receives DVB subtitle data from MPEG-TS streams, which have no browser subtitle tracks. */
    private bitmapSubtitles?: BitmapSubtitles,
    /** Collects the subtitles the server reads out of MKV movies passing through the proxy. */
    private vodSubtitles?: VodSubtitles,
  ) {
    video.preload = 'auto';
    video.addEventListener('playing', () => this.onStatus({ state: 'playing' }));
    video.addEventListener('waiting', () => {
      this.onStatus({ state: 'loading' });
      // After a stall the browser resumes on the first frame that arrives, then stalls again.
      // Pause and rebuild a proper buffer instead.
      if (!this.video.paused && !this.bufferTimer) {
        this.video.pause();
        this.playWhenBuffered(this.session, REBUFFER_S);
      }
    });
    // The user pressing play overrides any buffering wait.
    video.addEventListener('play', () => this.cancelBufferWait());
  }

  play(url: string, useProxy: boolean): void {
    this.teardown();
    const session = ++this.session;
    this.url = url;
    // mpegts.js runs in a worker, so relative URLs must be made absolute.
    const src = useProxy ? new URL(proxyUrl(url), location.href).href : url;
    const { engine, fallback } = guessEngine(url);
    this.onStatus({ state: 'loading' });
    if (transcodeChannels.has(url)) {
      return isMkv(url) ? this.startVodTranscode(session, 0) : this.startTranscoded(session);
    }
    if (!fallback) return this.start(engine, src, null, session);

    // The URL doesn't say what it is. Guessing wrong is slow: hls.js waits for its manifest
    // timeouts before giving up on what is really an endless MPEG-TS stream. So probe it instead.
    const origin = originOf(url);
    const learned = learnedEngines.get(origin);
    if (learned) return this.start(learned, src, null, session);

    const abort = new AbortController();
    this.cleanup = () => abort.abort();
    void probeEngine(src, abort.signal).then((detected) => {
      if (session !== this.session) return;
      this.cleanup = undefined;
      if (detected) learnEngine(origin, detected);
      this.start(detected ?? engine, src, detected ? null : fallback, session);
    });
  }

  stop(): void {
    this.session++;
    this.teardown();
    this.onStatus({ state: 'idle' });
  }

  private start(engine: Engine, src: string, fallback: Engine | null, session: number): void {
    if (engine === 'hls') this.startHls(src, fallback, session);
    else if (engine === 'mpegts') this.startMpegts(src, fallback, session);
    else this.startNative(src, fallback, session);
  }

  /** Plays the current channel through the server's ffmpeg, which converts Dolby audio to AAC. */
  private startTranscoded(session: number): void {
    this.startMpegts(new URL(transcodeUrl(this.url), location.href).href, null, session, true);
  }

  /** Plays a movie through ffmpeg from `from` seconds. Seeking restarts it at the new position. */
  private startVodTranscode(session: number, from: number, duration = this.vod?.duration ?? NaN): void {
    this.teardown(true);
    this.vod = { duration, requested: from, start: null };
    const subtitles = this.vodSubtitles;
    if (subtitles && !subtitles.isAttached(this.url)) subtitles.attach(this.url, (info) => this.onMovieInfo(session, info));
    subtitles?.setRequestedStart(from);
    this.onStatus({ state: 'loading' });
    this.startMpegts(new URL(transcodeUrl(this.url, from), location.href).href, null, session, true);
    this.watchForStalls(session);
  }

  /**
   * Safety net for converted movies: if playback has run out of data and nothing new arrives for
   * a while (a dropped provider connection, a stuck loader), restart ffmpeg where we are.
   */
  private watchForStalls(session: number): void {
    clearInterval(this.stallWatch);
    let lastEnd = -1;
    let stuckSince = Date.now();
    this.stallWatch = window.setInterval(() => {
      const vod = this.vod;
      if (session !== this.session || !vod) return clearInterval(this.stallWatch);
      const { buffered, currentTime } = this.video;
      const end = buffered.length ? buffered.end(buffered.length - 1) : 0;
      const starving = end - currentTime < 0.5;
      if (end > lastEnd + 0.1 || !starving) {
        lastEnd = Math.max(lastEnd, end);
        stuckSince = Date.now();
        return;
      }
      const position = this.timeline()?.position ?? vod.requested;
      if (Date.now() - stuckSince < STALL_RESTART_MS || position >= vod.duration - 2) return; // or the movie ended
      console.warn(`[player] movie stalled at ${position.toFixed(1)} s, restarting the conversion there`);
      this.startVodTranscode(session, position);
    }, 1000);
  }

  /** What the server has read from the MKV file: duration, audio codec, exact start of a conversion. */
  private onMovieInfo(session: number, info: VodInfo): void {
    if (session !== this.session) return;
    if (!this.vod) {
      // Playing natively. If Chrome can't decode the audio it plays silently, so switch to ffmpeg.
      if (!mkvAudioPlayable(info.audioCodec)) {
        rememberTranscode(this.url);
        this.startVodTranscode(session, this.video.currentTime, info.duration ?? NaN);
      }
      return;
    }
    if (info.duration) this.vod.duration = info.duration;
    if (info.transcodeStart !== null && info.forStart === this.vod.requested && this.vod.start === null) {
      this.vod.start = info.transcodeStart;
      this.vodSubtitles?.setOffset(info.transcodeStart);
    }
  }

  private seekVod(seconds: number): void {
    const vod = this.vod;
    if (!vod) return;
    const end = Number.isFinite(vod.duration) ? vod.duration - 1 : Infinity;
    const target = Math.min(Math.max(seconds, 0), end);
    // Show the new position right away; the restart happens once the user stops seeking.
    vod.requested = target;
    vod.start = null;
    clearTimeout(this.seekTimer);
    const session = this.session;
    this.seekTimer = window.setTimeout(() => {
      if (session === this.session && this.vod) this.startVodTranscode(session, target);
    }, SEEK_DEBOUNCE_MS);
  }

  /** The timeline of a movie played through ffmpeg; null otherwise (the video element has its own). */
  timeline(): Timeline | null {
    const vod = this.vod;
    if (!vod || !Number.isFinite(vod.duration)) return null;
    const { currentTime, buffered } = this.video;
    const position = vod.start === null ? vod.requested : vod.start + currentTime;
    const bufferedEnd = vod.start !== null && buffered.length ? vod.start + buffered.end(buffered.length - 1) : position;
    return { duration: vod.duration, position, bufferedEnd, seek: (t) => this.seekVod(t) };
  }

  /** The browser can't decode this stream's audio: restart the channel through ffmpeg. */
  private switchToTranscode(session: number): void {
    if (session !== this.session) return;
    this.teardown();
    this.onStatus({ state: 'loading' });
    this.startTranscoded(session);
  }

  private fail(session: number, message: string, src: string, fallback: Engine | null): void {
    if (session !== this.session) return;
    this.teardown();
    if (fallback) this.start(fallback, src, null, session);
    else this.onStatus({ state: 'error', message });
  }

  private startHls(src: string, fallback: Engine | null, session: number): void {
    if (!Hls.isSupported()) {
      // Safari (and iOS) play HLS natively.
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) return this.startNative(src, fallback, session);
      return this.fail(session, 'This browser cannot play HLS streams.', src, fallback);
    }

    const hls = new Hls({
      enableWorker: true,
      backBufferLength: 30,
      // When HLS is only a guess, give up quickly instead of retrying for up to a minute.
      ...(fallback && {
        manifestLoadPolicy: {
          default: { maxTimeToFirstByteMs: 8000, maxLoadTimeMs: 8000, timeoutRetry: null, errorRetry: null },
        },
      }),
    });
    this.hls = hls;
    let mediaRecoveries = 0;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      fallback = null; // It is HLS; don't retry as MPEG-TS on later errors.
      this.playWhenBuffered(session, START_BUFFER_S);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) {
        hls.recoverMediaError();
        return;
      }
      // Codec trouble may be Dolby audio, which ffmpeg can convert. (If it's the video, the
      // converted stream fails too and shows the codec message.)
      if (describeHlsError(data) === CODEC_MESSAGE) return this.switchToTranscode(session);
      this.fail(session, describeHlsError(data), src, fallback);
    });

    hls.loadSource(src);
    hls.attachMedia(this.video);
  }

  private startMpegts(src: string, fallback: Engine | null, session: number, transcoding = false): void {
    if (!mpegts.isSupported()) {
      return this.fail(session, 'This browser cannot play MPEG-TS streams (no Media Source Extensions).', src, fallback);
    }

    const player = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: src },
      {
        enableWorker: true,
        lazyLoad: false,
        // No latency chasing: it keeps skipping ahead to the live edge, which throws away the
        // buffer and causes stutter. A few seconds behind live is fine for TV.
        liveBufferLatencyChasing: false,
        liveSync: false,
        // Keep little already-played video: Chrome caps the buffer at ~150 MB, which is under a
        // minute of 4K. Nothing seeks back within these streams anyway (movies restart ffmpeg).
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 20,
        autoCleanupMinBackwardDuration: 10,
      },
    );
    this.ts = player;

    player.on(mpegts.Events.MEDIA_INFO, (info: { audioCodec?: string }) => {
      fallback = null;
      if (transcoding) rememberTranscode(this.url);
      // Spotting Dolby audio here restarts the channel before the browser even tries to decode it.
      else if (unsupportedAudio(info.audioCodec)) this.switchToTranscode(session);
    });
    const subtitles = this.bitmapSubtitles;
    if (subtitles) {
      // The PMT descriptors announce the DVB subtitle tracks; the PES packets carry their data.
      player.on(mpegts.Events.PES_PRIVATE_DATA_DESCRIPTOR, (d: { pid: number; descriptor: Uint8Array }) => {
        subtitles.addDescriptors(d.pid, d.descriptor);
      });
      player.on(mpegts.Events.PES_PRIVATE_DATA_ARRIVED, (d: { pid: number; pts?: number; nearest_pts?: number; data: Uint8Array }) => {
        subtitles.push(d.pid, d.pts ?? d.nearest_pts, d.data);
      });
    }
    player.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { code?: number; msg?: string }) => {
      const dolby = detail === mpegts.ErrorDetails.MEDIA_MSE_ERROR && /\b(ac-3|ec-3)\b/i.test(info?.msg ?? '');
      if (!transcoding && dolby) return this.switchToTranscode(session);
      if (transcoding && type === mpegts.ErrorTypes.NETWORK_ERROR && info?.code === 501) {
        return this.fail(session, FFMPEG_MISSING_MESSAGE, src, null);
      }
      this.fail(session, describeTsError(type, detail, info), src, fallback);
    });

    player.attachMediaElement(this.video);
    player.load();
    this.playWhenBuffered(session, START_BUFFER_S);
  }

  private startNative(src: string, fallback: Engine | null, session: number): void {
    const onError = () => this.fail(session, 'The browser could not play this stream.', src, fallback);
    this.video.addEventListener('error', onError);
    this.cleanup = () => this.video.removeEventListener('error', onError);
    this.video.src = src;
    // MKV movies through the proxy: their embedded subtitles become available as they download.
    if (src !== this.url && isMkv(this.url)) this.vodSubtitles?.attach(this.url, (info) => this.onMovieInfo(session, info));
    this.playWhenBuffered(session, START_BUFFER_S);
  }

  /** Seconds of media ahead of the playhead, and where that buffered range starts. */
  private bufferedAhead(): { ahead: number; rangeStart: number } {
    const { buffered, currentTime } = this.video;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.end(i) > currentTime) {
        return { ahead: buffered.end(i) - Math.max(currentTime, buffered.start(i)), rangeStart: buffered.start(i) };
      }
    }
    return { ahead: 0, rangeStart: currentTime };
  }

  /** Lets the engine fill the buffer before playing, so a slow start doesn't stutter. */
  private playWhenBuffered(session: number, seconds: number): void {
    this.cancelBufferWait();
    const startedAt = Date.now();
    this.bufferTimer = window.setInterval(() => {
      if (session !== this.session) return this.cancelBufferWait();
      const { ahead, rangeStart } = this.bufferedAhead();
      // Play anyway after a while: the stream may be too slow to reach the target.
      if (ahead < seconds && Date.now() - startedAt < MAX_BUFFER_WAIT_MS) return;
      this.cancelBufferWait();
      // Live streams rarely start at t=0; jump to the buffered data instead of stalling on a gap.
      if (this.video.currentTime < rangeStart) this.video.currentTime = rangeStart;
      this.autoplay(session);
    }, BUFFER_POLL_MS);
  }

  private cancelBufferWait(): void {
    clearInterval(this.bufferTimer);
    this.bufferTimer = 0;
  }

  private autoplay(session: number): void {
    this.video.play().catch((err: DOMException) => {
      // AbortError just means a newer source interrupted this play() call.
      if (session === this.session && err.name === 'NotAllowedError') this.onStatus({ state: 'blocked' });
    });
  }

  /** @param keepMovie restarting a converted movie at a new position: keep its subtitles and timeline. */
  private teardown(keepMovie = false): void {
    this.cancelBufferWait();
    clearInterval(this.stallWatch);
    this.bitmapSubtitles?.reset();
    if (!keepMovie) {
      this.vodSubtitles?.detach();
      this.vod = null;
      clearTimeout(this.seekTimer);
    }
    this.cleanup?.();
    this.cleanup = undefined;
    this.hls?.destroy();
    this.hls = undefined;
    if (this.ts) {
      this.ts.unload();
      this.ts.detachMediaElement();
      this.ts.destroy();
      this.ts = undefined;
    }
    this.video.removeAttribute('src');
    this.video.load();
  }
}
