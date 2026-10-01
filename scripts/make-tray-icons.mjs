// Draws the tray icons into assets/tray/ as PNGs. No dependencies: the glyph
// is drawn with supersampled coverage and written with a minimal PNG encoder.
//
//   node scripts/make-tray-icons.mjs
//
// The glyph is a side-on hard disk like the app icon (build/icon.png): a
// rounded rectangle with an activity LED.
// - trayTemplate.png / @2x (16 / 32 px): black plus alpha only. macOS treats
//   a "...Template" image as a template and recolours it for light and dark
//   menu bars.
// - tray.png / @2x (16 / 32 px): colour, for Windows and Linux, where tray
//   backgrounds may be light or dark: a light body with a dark outline and a
//   green LED reads on both.

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tray');
const SUPERSAMPLE = 8;

// Geometry in a 16 x 16 unit box.
const BODY = { x0: 1, y0: 4.5, x1: 15, y1: 11.5, radius: 2 };
const STROKE = 1.25;
const LED = { cx: 4.25, cy: 9, r: 1 };

// Signed distance to a rounded rectangle (negative inside).
function roundedRectDistance(x, y, { x0, y0, x1, y1, radius }) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - radius;
  const hy = (y1 - y0) / 2 - radius;
  const dx = Math.abs(x - cx) - hx;
  const dy = Math.abs(y - cy) - hy;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

const inLed = (x, y) => Math.hypot(x - LED.cx, y - LED.cy) <= LED.r;

/** Which part of the glyph a point (in 16-unit coordinates) is in. */
function partAt(x, y) {
  const d = roundedRectDistance(x, y, BODY);
  if (d > 0) return null;
  if (d > -STROKE) return 'outline';
  if (inLed(x, y)) return 'led';
  return 'body';
}

// RGBA colours per part. null = transparent.
const STYLES = {
  template: { outline: [0, 0, 0, 255], led: [0, 0, 0, 255], body: null },
  colour: { outline: [32, 32, 32, 255], led: [40, 200, 64, 255], body: [236, 236, 236, 255] }
};

function render(size, style) {
  const pixels = new Uint8Array(size * size * 4);
  const scale = 16 / size;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Average premultiplied colour over the subsamples.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * scale;
          const part = partAt(x, y);
          const colour = part && style[part];
          if (!colour) continue;
          const alpha = colour[3] / 255;
          r += colour[0] * alpha;
          g += colour[1] * alpha;
          b += colour[2] * alpha;
          a += alpha;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(g / a);
        pixels[i + 2] = Math.round(b / a);
      }
      pixels[i + 3] = Math.round((a / samples) * 255);
    }
  }
  return pixels;
}

// --- Minimal PNG encoder (8-bit RGBA, no interlace) ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // compression, filter and interlace methods stay 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
const outputs = [
  ['trayTemplate.png', 16, STYLES.template],
  ['trayTemplate@2x.png', 32, STYLES.template],
  ['tray.png', 16, STYLES.colour],
  ['tray@2x.png', 32, STYLES.colour]
];
for (const [name, size, style] of outputs) {
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, encodePng(size, size, render(size, style)));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${size}x${size})`);
}
