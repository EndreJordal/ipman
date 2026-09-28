/**
 * Text subtitles from Matroska (MKV) movies, picked out of the data as it streams through the proxy.
 *
 * Browsers play MKV files natively but don't expose their embedded subtitle tracks to the page.
 * Every byte the browser downloads already passes through /proxy, so MkvTap reads the Matroska
 * structure on the way: the Tracks header (which tracks are text subtitles) and the subtitle
 * blocks inside each Cluster. Video and audio blocks are skipped without buffering. The cues
 * collect in a per-movie store that the player polls through GET /vod-info, together with the
 * movie's duration and audio codec (so the player can tell when the audio needs converting).
 * No extra download and no second connection to the provider.
 *
 * Only text formats (SRT, ASS/SSA, WebVTT) are extracted; bitmap formats (PGS, VobSub) are not.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { VOD_INFO_PATH } from '../src/lib/proxy.ts';

export interface MkvSubtitleTrack {
  number: number;
  codec: string;
  language: string;
  name: string;
}

export interface MkvCue {
  track: number;
  /** Seconds on the movie's timeline. */
  start: number;
  end: number;
  text: string;
}

interface Store {
  tracks: MkvSubtitleTrack[];
  /** Nanoseconds per timestamp unit (Matroska default: 1 ms). */
  timestampScale: number;
  /** Append-only, so clients can poll with a cursor. */
  cues: MkvCue[];
  seen: Set<string>;
  touched: number;
  /** Seconds, from the Info header. */
  duration: number | null;
  /** Matroska codec ID of the first audio track, e.g. "A_EAC3". */
  audioCodec: string | null;
  /** Converted (ffmpeg) streams: requested start → exact start of the output, both in seconds. */
  transcodeStarts: Map<string, number>;
}

const STORE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CUES = 50_000;
/** Assumed duration for subtitle blocks without a BlockDuration. */
const DEFAULT_CUE_S = 4;
/** Buffer limit for header elements (Info, Tracks) we parse whole. */
const MAX_BUFFERED_ELEMENT = 4 * 1024 * 1024;

const stores = new Map<string, Store>();

function storeFor(url: string): Store {
  const now = Date.now();
  for (const [key, store] of stores) if (now - store.touched > STORE_TTL_MS) stores.delete(key);
  let store = stores.get(url);
  if (!store) {
    store = { tracks: [], timestampScale: 1_000_000, cues: [], seen: new Set(), touched: now, duration: null, audioCodec: null, transcodeStarts: new Map() };
    stores.set(url, store);
  }
  store.touched = now;
  return store;
}

const ID = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  LANGUAGE: 0x22b59c,
  LANGUAGE_BCP47: 0x22b59d,
  NAME: 0x536e,
  CLUSTER: 0x1f43b675,
  CLUSTER_TIMESTAMP: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
} as const;

/** Level-1 elements that end an unknown-size Cluster. */
const TOP_LEVEL = new Set([ID.CLUSTER, 0x1c53bb6b /* Cues */, 0x1254c367 /* Tags */, 0x1941a469 /* Attachments */, 0x1043a770 /* Chapters */, ID.INFO, ID.TRACKS]);
const TRACK_TYPE_SUBTITLE = 0x11;
const TRACK_TYPE_AUDIO = 0x02;
const CRC32 = 0xbf;

/** Reads an EBML variable-length integer. `keepMarker` for element IDs. */
function readVint(buf: Uint8Array, pos: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23; // leading zeros within the byte, plus one
  if (length > 8 || pos + length > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readFloat(buf: Uint8Array): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return buf.length === 4 ? view.getFloat32(0) : buf.length === 8 ? view.getFloat64(0) : 0;
}

function readUint(buf: Uint8Array): number {
  let v = 0;
  for (const b of buf) v = v * 256 + b;
  return v;
}

/** Walks the children of a fully buffered master element. */
function* children(buf: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
  for (let pos = 0; pos < buf.length; ) {
    const id = readVint(buf, pos, true);
    if (!id) return;
    const size = readVint(buf, pos + id.length, false);
    if (!size) return;
    const start = pos + id.length + size.length;
    yield { id: id.value, data: buf.subarray(start, start + size.value) };
    pos = start + size.value;
  }
}

const text = (data: Uint8Array) => new TextDecoder().decode(data).replace(/\0+$/, '');

/** Turns a subtitle block's payload into cue text, removing ASS/SSA styling. */
function cueText(codec: string, payload: Uint8Array): string {
  let t = text(payload);
  if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA') {
    // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    t = t.split(',').slice(8).join(',');
    t = t.replace(/\\N/gi, '\n').replace(/\\h/g, ' ');
  }
  return t.replace(/\{\\[^}]*\}/g, '').trim(); // {\an8}, {\i1} and other override tags
}

export class MkvTap {
  private store: Store;
  private buf: Buffer = Buffer.alloc(0);
  /** Absolute file offset of buf[0]. */
  private offset: number;
  /** Bytes still to skip (body of an element we don't need). */
  private skip = 0;
  /** Not yet aligned to an element boundary: the response started mid-file (a seek). */
  private syncing: boolean;
  private stack: { id: number; end: number }[] = [];
  private clusterTimestamp = 0;
  private pending: { track: MkvSubtitleTrack; start: number; text: string; duration?: number } | null = null;
  private failed = false;

  // No constructor parameter properties in server code: Node runs it with type stripping only.
  constructor(store: Store, startOffset: number) {
    this.store = store;
    this.offset = startOffset;
    this.syncing = startOffset > 0;
  }

  write(chunk: Buffer): void {
    if (this.failed) return;
    try {
      if (this.skip >= chunk.length && !this.buf.length) {
        this.skip -= chunk.length;
        this.offset += chunk.length;
        return;
      }
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.parse();
    } catch (err) {
      // A parse error must never break playback; this movie just won't get (more) subtitles.
      this.failed = true;
      console.warn(`[mkv-subs] giving up on this stream: ${(err as Error).message}`);
    }
  }

  private consume(n: number): void {
    this.buf = this.buf.subarray(n);
    this.offset += n;
  }

  private parse(): void {
    for (;;) {
      if (this.skip) {
        const n = Math.min(this.skip, this.buf.length);
        this.consume(n);
        this.skip -= n;
        if (this.skip) return;
      }
      if (this.syncing && !this.resync()) return;
      this.closeFinished();

      const id = readVint(this.buf, 0, true);
      const size = id && readVint(this.buf, id.length, false);
      if (!id || !size) {
        if (this.buf.length >= 12 || (this.buf.length && this.buf[0] === 0)) this.syncing = true; // garbage
        if (this.syncing) continue;
        return;
      }
      const headerLength = id.length + size.length;
      const bodyStart = this.offset + headerLength;
      const end = size.unknown ? Infinity : bodyStart + size.value;

      // An unknown-size Cluster ends where the next level-1 element begins.
      if (TOP_LEVEL.has(id.value as never)) {
        while (this.stack.length && this.stack[this.stack.length - 1].id !== ID.SEGMENT) this.close();
      }

      switch (id.value) {
        case ID.SEGMENT:
        case ID.CLUSTER:
        case ID.BLOCK_GROUP:
          // Descend: parse the children as they stream past.
          this.consume(headerLength);
          this.stack.push({ id: id.value, end });
          continue;
        case ID.INFO:
        case ID.TRACKS:
        case ID.CLUSTER_TIMESTAMP:
        case ID.BLOCK_DURATION: {
          if (size.unknown || size.value > MAX_BUFFERED_ELEMENT) {
            this.consume(headerLength);
            this.skip = size.unknown ? 0 : size.value;
            continue;
          }
          if (this.buf.length < headerLength + size.value) return; // wait for the whole element
          this.element(id.value, this.buf.subarray(headerLength, headerLength + size.value));
          this.consume(headerLength + size.value);
          continue;
        }
        case ID.SIMPLE_BLOCK:
        case ID.BLOCK: {
          const trackNumber = readVint(this.buf, headerLength, false);
          if (!trackNumber) {
            if (this.buf.length < headerLength + 8) return;
            this.syncing = true;
            continue;
          }
          const track = this.store.tracks.find((t) => t.number === trackNumber.value);
          if (!track) {
            // Video/audio: skip without buffering.
            this.consume(headerLength);
            this.skip = size.value;
            continue;
          }
          if (this.buf.length < headerLength + size.value) return;
          this.block(id.value, track, this.buf.subarray(headerLength, headerLength + size.value), trackNumber.length);
          this.consume(headerLength + size.value);
          continue;
        }
        default:
          this.consume(headerLength);
          this.skip = size.unknown ? 0 : size.value;
      }
    }
  }

  /** Scans for the next Cluster start after landing mid-file. */
  private resync(): boolean {
    for (let i = 0; i + 4 <= this.buf.length; i++) {
      if (this.buf[i] !== 0x1f || this.buf[i + 1] !== 0x43 || this.buf[i + 2] !== 0xb6 || this.buf[i + 3] !== 0x75) continue;
      const size = readVint(this.buf, i + 4, false);
      if (!size) {
        if (i + 12 > this.buf.length) {
          this.consume(i);
          return false; // need more bytes to validate
        }
        continue;
      }
      // A real cluster starts with its Timestamp, or a CRC-32 (ffmpeg and mkvmerge write one) and then its Timestamp.
      const firstChild = i + 4 + size.length;
      if (firstChild + 7 >= this.buf.length) {
        this.consume(i);
        return false;
      }
      const first = this.buf[firstChild];
      const second = this.buf[firstChild + 6]; // after CRC-32: ID 0xBF, size 0x84, 4 bytes
      if (first !== ID.CLUSTER_TIMESTAMP && !(first === CRC32 && second === ID.CLUSTER_TIMESTAMP)) continue;
      this.consume(i);
      this.stack = [{ id: ID.SEGMENT, end: Infinity }];
      this.syncing = false;
      return true;
    }
    // Keep the last 3 bytes: a Cluster ID may straddle the chunk boundary.
    this.consume(Math.max(0, this.buf.length - 3));
    return false;
  }

  private closeFinished(): void {
    while (this.stack.length && this.stack[this.stack.length - 1].end <= this.offset) this.close();
  }

  private close(): void {
    const closed = this.stack.pop();
    if (closed?.id === ID.BLOCK_GROUP) this.flushPending();
  }

  private element(id: number, data: Uint8Array): void {
    if (id === ID.CLUSTER_TIMESTAMP) {
      this.clusterTimestamp = readUint(data);
    } else if (id === ID.BLOCK_DURATION) {
      if (this.pending) this.pending.duration = readUint(data);
    } else if (id === ID.INFO) {
      let duration: number | null = null;
      for (const child of children(data)) {
        if (child.id === ID.TIMESTAMP_SCALE) this.store.timestampScale = readUint(child.data) || 1_000_000;
        if (child.id === ID.DURATION) duration = readFloat(child.data);
      }
      // Duration is in timestamp units; TimestampScale may come after it in the header.
      if (duration !== null) this.store.duration = (duration * this.store.timestampScale) / 1e9;
    } else if (id === ID.TRACKS) {
      const tracks: MkvSubtitleTrack[] = [];
      for (const entry of children(data)) {
        if (entry.id !== ID.TRACK_ENTRY) continue;
        const t = { number: 0, type: 0, codec: '', language: 'eng', languageBcp47: '', name: '' };
        for (const field of children(entry.data)) {
          if (field.id === ID.TRACK_NUMBER) t.number = readUint(field.data);
          else if (field.id === ID.TRACK_TYPE) t.type = readUint(field.data);
          else if (field.id === ID.CODEC_ID) t.codec = text(field.data);
          else if (field.id === ID.LANGUAGE) t.language = text(field.data);
          else if (field.id === ID.LANGUAGE_BCP47) t.languageBcp47 = text(field.data);
          else if (field.id === ID.NAME) t.name = text(field.data);
        }
        if (t.type === TRACK_TYPE_AUDIO) this.store.audioCodec ??= t.codec;
        if (t.type === TRACK_TYPE_SUBTITLE && t.codec.startsWith('S_TEXT/')) {
          tracks.push({ number: t.number, codec: t.codec, language: t.languageBcp47 || t.language, name: t.name });
        }
      }
      if (tracks.length && !this.store.tracks.length) {
        this.store.tracks = tracks;
        console.log(`[mkv-subs] ${tracks.length} text subtitle track(s): ${tracks.map((t) => t.language).join(', ')}`);
      }
    }
  }

  private block(id: number, track: MkvSubtitleTrack, data: Uint8Array, trackNumberLength: number): void {
    const relative = (data[trackNumberLength] << 24) >> 16 | data[trackNumberLength + 1]; // signed int16
    const scale = this.store.timestampScale / 1e9;
    const start = (this.clusterTimestamp + relative) * scale;
    const payload = cueText(track.codec, data.subarray(trackNumberLength + 3));
    if (id === ID.SIMPLE_BLOCK) {
      this.addCue(track, start, start + DEFAULT_CUE_S, payload);
    } else {
      // Inside a BlockGroup; its BlockDuration may follow the Block.
      this.pending = { track, start, text: payload };
    }
  }

  private flushPending(): void {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    const duration = p.duration !== undefined ? p.duration * (this.store.timestampScale / 1e9) : DEFAULT_CUE_S;
    this.addCue(p.track, p.start, p.start + duration, p.text);
  }

  private addCue(track: MkvSubtitleTrack, start: number, end: number, cue: string): void {
    const key = `${track.number}:${start.toFixed(3)}`;
    if (!cue || this.store.seen.has(key) || this.store.cues.length >= MAX_CUES) return;
    this.store.seen.add(key);
    this.store.cues.push({ track: track.number, start, end, text: cue });
  }
}

/** Called by server/transcode.ts once it knows where a converted movie stream really starts. */
export function recordTranscodeStart(url: string, requestedStart: string, actualStart: number): void {
  storeFor(url).transcodeStarts.set(requestedStart, actualStart);
}

/** Offset where a proxied response starts: from Content-Range ("bytes 123-456/789"), else 0. */
function responseOffset(contentRange: string | null): number {
  const m = /bytes\s+(\d+)-/.exec(contentRange ?? '');
  return m ? Number(m[1]) : 0;
}

/** Returns a tap for proxied MKV responses (called by server/proxy.ts), or null for anything else. */
export function tapForResponse(url: string, contentType: string, contentRange: string | null): MkvTap | null {
  const isMkv = /matroska/i.test(contentType) || /\.mkv$/i.test(new URL(url).pathname);
  return isMkv ? new MkvTap(storeFor(url), responseOffset(contentRange)) : null;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const params = new URL(req.url ?? '', 'http://localhost').searchParams;
  const url = params.get('url') ?? '';
  const cursor = Math.max(0, Number(params.get('cursor')) || 0);
  const start = params.get('start');
  const store = stores.get(url);
  if (store) store.touched = Date.now();
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(
    JSON.stringify({
      duration: store?.duration ?? null,
      audioCodec: store?.audioCodec ?? null,
      // Where the converted stream requested with this start really begins (null until known).
      transcodeStart: start === null ? null : (store?.transcodeStarts.get(start) ?? null),
      tracks: store?.tracks ?? [],
      cues: store?.cues.slice(cursor) ?? [],
      cursor: store?.cues.length ?? 0,
    }),
  );
}

export function vodInfoMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (req.url?.split('?')[0] !== VOD_INFO_PATH) return next();
  handle(req, res);
}

export function vodInfoService(): Plugin {
  return {
    name: 'ipman-vod-info',
    configureServer(server) {
      server.middlewares.use(vodInfoMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(vodInfoMiddleware);
    },
  };
}
