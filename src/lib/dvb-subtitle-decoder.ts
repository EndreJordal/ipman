/**
 * DVB subtitle decoder (ETSI EN 300 743).
 *
 * DVB subtitles are bitmaps, not text. A stream carries display sets: a page composition
 * (which regions are visible, and where), region compositions (size, colour depth, CLUT,
 * which objects they contain), CLUT definitions (palettes in YCrCb) and object data
 * (run-length-coded pixels). The decoder keeps that state across PES packets and, at the
 * end of every display set, renders the visible regions to RGBA bitmaps.
 *
 * Pure data in, pure data out: no DOM, so it can be tested in Node.
 */

export interface SubtitleBitmap {
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA, width * height * 4 bytes. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** One complete screen of subtitles. An empty `bitmaps` list clears the screen. */
export interface DisplaySet {
  /** Presentation time in seconds on the media timeline. */
  pts: number;
  /** Seconds after `pts` when the page must disappear if nothing replaces it. */
  timeout: number;
  displayWidth: number;
  displayHeight: number;
  bitmaps: SubtitleBitmap[];
}

interface Region {
  width: number;
  height: number;
  /** Bits per pixel: 2, 4 or 8. */
  depth: 2 | 4 | 8;
  clutId: number;
  /** Background pixel code, used when the region is (re)filled. */
  fillCode: number;
  objects: { id: number; x: number; y: number }[];
}

interface ObjectData {
  nonModifyingColour: boolean;
  top: Uint8Array;
  /** Empty means "repeat the top field". */
  bottom: Uint8Array;
}

type Palette = Uint32Array; // RGBA packed as 0xRRGGBBAA

interface Clut {
  2: Palette;
  4: Palette;
  8: Palette;
}

const SEGMENT = {
  PAGE_COMPOSITION: 0x10,
  REGION_COMPOSITION: 0x11,
  CLUT_DEFINITION: 0x12,
  OBJECT_DATA: 0x13,
  DISPLAY_DEFINITION: 0x14,
  END_OF_DISPLAY_SET: 0x80,
} as const;

const rgba = (r: number, g: number, b: number, a: number) => ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Default palettes from EN 300 743 section 10 (same values as ffmpeg's dvbsubdec). */
function defaultClut(): Clut {
  const clut2 = new Uint32Array([rgba(0, 0, 0, 0), rgba(255, 255, 255, 255), rgba(0, 0, 0, 255), rgba(127, 127, 127, 255)]);

  const clut4 = new Uint32Array(16);
  for (let i = 1; i < 16; i++) {
    const v = i < 8 ? 255 : 127;
    clut4[i] = rgba(i & 1 ? v : 0, i & 2 ? v : 0, i & 4 ? v : 0, 255);
  }

  const clut8 = new Uint32Array(256);
  for (let i = 1; i < 256; i++) {
    const c = (bit: number, hi: number, lo: number, base = 0) => base + (i & bit ? lo : 0) + (i & (bit << 4) ? hi : 0);
    if (i < 8) {
      clut8[i] = rgba(i & 1 ? 255 : 0, i & 2 ? 255 : 0, i & 4 ? 255 : 0, 63);
    } else {
      switch (i & 0x88) {
        case 0x00:
          clut8[i] = rgba(c(1, 170, 85), c(2, 170, 85), c(4, 170, 85), 255);
          break;
        case 0x08:
          clut8[i] = rgba(c(1, 170, 85), c(2, 170, 85), c(4, 170, 85), 127);
          break;
        case 0x80:
          clut8[i] = rgba(c(1, 85, 43, 127), c(2, 85, 43, 127), c(4, 85, 43, 127), 255);
          break;
        case 0x88:
          clut8[i] = rgba(c(1, 85, 43), c(2, 85, 43), c(4, 85, 43), 255);
          break;
      }
    }
  }
  return { 2: clut2, 4: clut4, 8: clut8 };
}

/** BT.601 limited-range YCrCb + transparency to RGBA. Y = 0 means fully transparent. */
function ycrcbToRgba(y: number, cr: number, cb: number, t: number): number {
  if (y === 0) return rgba(0, 0, 0, 0);
  const yy = 1.164 * (y - 16);
  return rgba(clamp(yy + 1.596 * (cr - 128)), clamp(yy - 0.813 * (cr - 128) - 0.391 * (cb - 128)), clamp(yy + 2.018 * (cb - 128)), 255 - t);
}

class BitReader {
  private bit = 0;
  constructor(
    private buf: Uint8Array,
    public pos: number,
  ) {}

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos] ?? 0;
      v = (v << 1) | ((byte >> (7 - this.bit)) & 1);
      if (++this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    return v;
  }

  /** Pixel code strings are padded to a byte boundary. */
  align(): void {
    if (this.bit) {
      this.bit = 0;
      this.pos++;
    }
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

type PixelSink = (count: number, code: number) => void;

// Run-length pixel code strings, EN 300 743 section 7.2.5.2. Each returns at "end of string".
function read2bit(r: BitReader, emit: PixelSink): void {
  while (!r.done) {
    const code = r.read(2);
    if (code) {
      emit(1, code);
    } else if (r.read(1)) {
      const run = r.read(3) + 3;
      emit(run, r.read(2));
    } else if (r.read(1)) {
      emit(1, 0);
    } else {
      switch (r.read(2)) {
        case 0:
          return r.align();
        case 1:
          emit(2, 0);
          break;
        case 2: {
          const run = r.read(4) + 12;
          emit(run, r.read(2));
          break;
        }
        case 3: {
          const run = r.read(8) + 29;
          emit(run, r.read(2));
          break;
        }
      }
    }
  }
}

function read4bit(r: BitReader, emit: PixelSink): void {
  while (!r.done) {
    const code = r.read(4);
    if (code) {
      emit(1, code);
    } else if (!r.read(1)) {
      const run = r.read(3);
      if (!run) return r.align();
      emit(run + 2, 0);
    } else if (!r.read(1)) {
      const run = r.read(2) + 4;
      emit(run, r.read(4));
    } else {
      switch (r.read(2)) {
        case 0:
          emit(1, 0);
          break;
        case 1:
          emit(2, 0);
          break;
        case 2: {
          const run = r.read(4) + 9;
          emit(run, r.read(4));
          break;
        }
        case 3: {
          const run = r.read(8) + 25;
          emit(run, r.read(4));
          break;
        }
      }
    }
  }
}

function read8bit(r: BitReader, emit: PixelSink): void {
  while (!r.done) {
    const code = r.read(8);
    if (code) {
      emit(1, code);
    } else if (!r.read(1)) {
      const run = r.read(7);
      if (!run) return r.align();
      emit(run, 0);
    } else {
      const run = r.read(7);
      emit(run, r.read(8));
    }
  }
}

export class DvbSubtitleDecoder {
  private displayWidth = 720;
  private displayHeight = 576;
  private displayOffsetX = 0;
  private displayOffsetY = 0;
  private regions = new Map<number, Region>();
  private cluts = new Map<number, Clut>();
  private objects = new Map<number, ObjectData>();
  private page: { timeout: number; regions: { id: number; x: number; y: number }[] } | null = null;
  private pendingPts: number | null = null;

  /**
   * @param pageIds composition and ancillary page ids of the selected track; segments for other
   *   pages (e.g. other languages sharing the PID) are ignored.
   */
  constructor(
    private pageIds: Set<number>,
    private onDisplaySet: (set: DisplaySet) => void,
  ) {}

  /** Feeds one PES payload (starting with data_identifier 0x20). `pts` is in seconds. */
  push(data: Uint8Array, pts: number): void {
    if (data.length < 2 || data[0] !== 0x20) return;
    let i = 2; // data_identifier, subtitle_stream_id
    while (i + 6 <= data.length && data[i] === 0x0f) {
      const type = data[i + 1];
      const pageId = (data[i + 2] << 8) | data[i + 3];
      const length = (data[i + 4] << 8) | data[i + 5];
      const segment = data.subarray(i + 6, i + 6 + length);
      i += 6 + length;
      if (!this.pageIds.has(pageId)) continue;
      try {
        this.segment(type, segment, pts);
      } catch (err) {
        // A corrupt segment shouldn't take the decoder down; the next display set recovers.
        console.warn('[dvb-subs] bad segment', type, err);
      }
    }
  }

  private segment(type: number, s: Uint8Array, pts: number): void {
    switch (type) {
      case SEGMENT.PAGE_COMPOSITION:
        return this.pageComposition(s, pts);
      case SEGMENT.REGION_COMPOSITION:
        return this.regionComposition(s);
      case SEGMENT.CLUT_DEFINITION:
        return this.clutDefinition(s);
      case SEGMENT.OBJECT_DATA:
        return this.objectData(s);
      case SEGMENT.DISPLAY_DEFINITION:
        return this.displayDefinition(s);
      case SEGMENT.END_OF_DISPLAY_SET:
        return this.flush();
    }
  }

  private pageComposition(s: Uint8Array, pts: number): void {
    // Some encoders omit the end-of-display-set segment; a new page closes the previous set.
    if (this.pendingPts !== null) this.flush();
    const timeout = s[0];
    const state = (s[1] >> 2) & 3;
    if (state === 1 || state === 2) {
      // Acquisition point or mode change: everything needed is (re)sent in this set.
      this.regions.clear();
      this.objects.clear();
      this.cluts.clear();
    }
    const regions: { id: number; x: number; y: number }[] = [];
    for (let o = 2; o + 6 <= s.length; o += 6) {
      regions.push({ id: s[o], x: (s[o + 2] << 8) | s[o + 3], y: (s[o + 4] << 8) | s[o + 5] });
    }
    this.page = { timeout, regions };
    this.pendingPts = pts;
  }

  private regionComposition(s: Uint8Array): void {
    const id = s[0];
    const fill = (s[1] & 0x08) !== 0;
    const width = (s[2] << 8) | s[3];
    const height = (s[4] << 8) | s[5];
    const depthCode = (s[6] >> 2) & 7;
    const depth: 2 | 4 | 8 = depthCode === 1 ? 2 : depthCode === 2 ? 4 : 8;
    const clutId = s[7];
    const fillCode = depth === 8 ? s[8] : depth === 4 ? s[9] >> 4 : (s[9] >> 2) & 3;
    const objects: Region['objects'] = [];
    for (let o = 10; o + 6 <= s.length; ) {
      const objectId = (s[o] << 8) | s[o + 1];
      const objectType = s[o + 2] >> 6;
      const x = ((s[o + 2] & 0x0f) << 8) | s[o + 3];
      const y = ((s[o + 4] & 0x0f) << 8) | s[o + 5];
      objects.push({ id: objectId, x, y });
      o += objectType === 1 || objectType === 2 ? 8 : 6; // character objects carry fg/bg codes
    }
    const previous = this.regions.get(id);
    this.regions.set(id, {
      width,
      height,
      depth,
      clutId,
      fillCode: fill || !previous ? (fill ? fillCode : 0) : previous.fillCode,
      objects,
    });
  }

  private clutDefinition(s: Uint8Array): void {
    const id = s[0];
    const clut = this.cluts.get(id) ?? defaultClut();
    for (let o = 2; o + 2 <= s.length; ) {
      const entry = s[o];
      const flags = s[o + 1];
      let y: number, cr: number, cb: number, t: number;
      if (flags & 1) {
        [y, cr, cb, t] = [s[o + 2], s[o + 3], s[o + 4], s[o + 5]];
        o += 6;
      } else {
        const v = (s[o + 2] << 8) | s[o + 3];
        y = (v >> 10) << 2;
        cr = ((v >> 6) & 0x0f) << 4;
        cb = ((v >> 2) & 0x0f) << 4;
        t = (v & 3) << 6;
        o += 4;
      }
      const colour = ycrcbToRgba(y, cr, cb, t);
      if (flags & 0x80 && entry < 4) clut[2][entry] = colour;
      if (flags & 0x40 && entry < 16) clut[4][entry] = colour;
      if (flags & 0x20) clut[8][entry] = colour;
    }
    this.cluts.set(id, clut);
  }

  private objectData(s: Uint8Array): void {
    const id = (s[0] << 8) | s[1];
    const codingMethod = (s[2] >> 2) & 3;
    if (codingMethod !== 0) return; // Character-coded objects are practically unused.
    const nonModifyingColour = (s[2] & 0x02) !== 0;
    const topLength = (s[3] << 8) | s[4];
    const bottomLength = (s[5] << 8) | s[6];
    this.objects.set(id, {
      nonModifyingColour,
      top: s.slice(7, 7 + topLength),
      bottom: s.slice(7 + topLength, 7 + topLength + bottomLength),
    });
  }

  private displayDefinition(s: Uint8Array): void {
    const windowed = (s[0] & 0x08) !== 0;
    this.displayWidth = ((s[1] << 8) | s[2]) + 1;
    this.displayHeight = ((s[3] << 8) | s[4]) + 1;
    [this.displayOffsetX, this.displayOffsetY] = windowed ? [(s[5] << 8) | s[6], (s[9] << 8) | s[10]] : [0, 0];
  }

  /** Renders the visible regions of the current page and emits the display set. */
  private flush(): void {
    if (this.pendingPts === null || !this.page) return;
    const bitmaps: SubtitleBitmap[] = [];
    for (const placement of this.page.regions) {
      const region = this.regions.get(placement.id);
      if (!region || !region.width || !region.height) continue;
      const bitmap = this.renderRegion(region);
      if (bitmap) {
        bitmaps.push({ ...bitmap, x: placement.x + this.displayOffsetX, y: placement.y + this.displayOffsetY });
      }
    }
    this.onDisplaySet({
      pts: this.pendingPts,
      timeout: this.page.timeout,
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
      bitmaps,
    });
    this.pendingPts = null;
  }

  private renderRegion(region: Region): Omit<SubtitleBitmap, 'x' | 'y'> | null {
    const { width, height, depth } = region;
    const pixels = new Uint8Array(width * height).fill(region.fillCode);
    for (const placement of region.objects) {
      const object = this.objects.get(placement.id);
      if (!object) continue;
      this.drawField(pixels, region, placement.x, placement.y, object.top, object.nonModifyingColour);
      this.drawField(pixels, region, placement.x, placement.y + 1, object.bottom.length ? object.bottom : object.top, object.nonModifyingColour);
    }

    const palette = (this.cluts.get(region.clutId) ?? defaultClut())[depth];
    const rgbaOut = new Uint8ClampedArray(width * height * 4);
    let visible = false;
    for (let p = 0; p < pixels.length; p++) {
      const colour = palette[pixels[p]] ?? 0;
      const alpha = colour & 0xff;
      if (!alpha) continue;
      visible = true;
      const o = p * 4;
      rgbaOut[o] = colour >>> 24;
      rgbaOut[o + 1] = (colour >>> 16) & 0xff;
      rgbaOut[o + 2] = (colour >>> 8) & 0xff;
      rgbaOut[o + 3] = alpha;
    }
    return visible ? { width, height, rgba: rgbaOut } : null;
  }

  /** Decodes one field (every other line) of an object's pixel data into the region. */
  private drawField(pixels: Uint8Array, region: Region, x0: number, y0: number, block: Uint8Array, nonModifying: boolean): void {
    const { width, height, depth } = region;
    let map2to4 = [0x0, 0x7, 0x8, 0xf];
    let map2to8 = [0x00, 0x77, 0x88, 0xff];
    let map4to8 = Array.from({ length: 16 }, (_, i) => i * 0x11);
    let x = x0;
    let y = y0;

    const sink =
      (map: (code: number) => number): PixelSink =>
      (count, code) => {
        if (y < height && !(nonModifying && code === 1)) {
          const value = map(code);
          const row = y * width;
          for (let k = 0; k < count && x + k < width; k++) pixels[row + x + k] = value;
        }
        x += count;
      };

    for (let i = 0; i < block.length; ) {
      const dataType = block[i++];
      switch (dataType) {
        case 0x10: {
          const r = new BitReader(block, i);
          read2bit(r, sink((c) => (depth === 4 ? map2to4[c] : depth === 8 ? map2to8[c] : c)));
          i = r.pos;
          break;
        }
        case 0x11: {
          const r = new BitReader(block, i);
          read4bit(r, sink((c) => (depth === 8 ? map4to8[c] : depth === 2 ? c >> 2 : c)));
          i = r.pos;
          break;
        }
        case 0x12: {
          const r = new BitReader(block, i);
          read8bit(r, sink((c) => (depth === 8 ? c : depth === 4 ? c >> 4 : c >> 6)));
          i = r.pos;
          break;
        }
        case 0x20:
          map2to4 = [block[i] >> 4, block[i] & 0xf, block[i + 1] >> 4, block[i + 1] & 0xf];
          i += 2;
          break;
        case 0x21:
          map2to8 = Array.from(block.subarray(i, i + 4));
          i += 4;
          break;
        case 0x22:
          map4to8 = Array.from(block.subarray(i, i + 16));
          i += 16;
          break;
        case 0xf0: // end of object line
          x = x0;
          y += 2;
          break;
        default:
          return; // Unknown data type: the rest of the block can't be interpreted.
      }
    }
  }
}
