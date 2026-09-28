import Hls, { type ErrorData } from 'hls.js';
import mpegts from 'mpegts.js';
import { proxyUrl } from './lib/proxy';

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

  constructor(
    private video: HTMLVideoElement,
    private onStatus: (status: PlayerStatus) => void,
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
    // mpegts.js runs in a worker, so relative URLs must be made absolute.
    const src = useProxy ? new URL(proxyUrl(url), location.href).href : url;
    const { engine, fallback } = guessEngine(url);
    this.onStatus({ state: 'loading' });
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
      this.fail(session, describeHlsError(data), src, fallback);
    });

    hls.loadSource(src);
    hls.attachMedia(this.video);
  }

  private startMpegts(src: string, fallback: Engine | null, session: number): void {
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
        // Keep memory bounded during long viewing sessions.
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 60,
        autoCleanupMinBackwardDuration: 30,
      },
    );
    this.ts = player;

    player.on(mpegts.Events.MEDIA_INFO, () => {
      fallback = null;
    });
    player.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { code?: number; msg?: string }) => {
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

  private teardown(): void {
    this.cancelBufferWait();
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
