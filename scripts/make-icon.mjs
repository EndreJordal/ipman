// Draws the ipman icon (a blue screen with a white play triangle) and writes assets/ipman.ico
// with several sizes, PNG-compressed (supported by Windows since Vista). Used for the Start-menu
// and autostart shortcuts. Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const ACCENT = [0x4f, 0x8c, 0xff];
const BEZEL = [0x16, 0x1a, 0x21];
const WHITE = [0xff, 0xff, 0xff];

function roundedRect(u, v, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(u, x1 - r));
  const cy = Math.max(y0 + r, Math.min(v, y1 - r));
  return u >= x0 && u <= x1 && v >= y0 && v <= y1 && Math.hypot(u - cx, v - cy) <= r;
}

/** Colour at unit coordinates (0..1), or null for transparent. */
function sample(u, v) {
  if (u >= 0.4 && u <= 0.66 && Math.abs(v - 0.47) <= 0.15 * (1 - (u - 0.4) / 0.26)) return WHITE; // play triangle
  if (roundedRect(u, v, 0.14, 0.2, 0.86, 0.74, 0.07)) return ACCENT; // screen
  if (roundedRect(u, v, 0.06, 0.12, 0.94, 0.82, 0.12) || roundedRect(u, v, 0.34, 0.84, 0.66, 0.9, 0.03)) return BEZEL; // bezel, stand
  return null;
}

/** RGBA pixels, supersampled 4×4 per pixel for smooth edges. */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (c) [r, g, b, hits] = [r + c[0], g + c[1], b + c[2], hits + 1];
        }
      }
      if (hits) px.set([r / hits, g / hits, b / hits, (hits / (ss * ss)) * 255].map(Math.round), (y * size + x) * 4);
    }
  }
  return px;
}

function png(size) {
  const rgba = draw(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((size, i) => {
  const e = Buffer.alloc(16);
  e.set([size >= 256 ? 0 : size, size >= 256 ? 0 : size], 0);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
mkdirSync('assets', { recursive: true });
writeFileSync('assets/ipman.ico', Buffer.concat([header, ...entries, ...images]));
writeFileSync('assets/ipman.png', images.at(-1));
console.log('wrote assets/ipman.ico and assets/ipman.png');
