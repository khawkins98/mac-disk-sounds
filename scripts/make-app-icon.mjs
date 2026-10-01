// Draws the app icon and writes the files electron-builder packages:
//
//   build/icon.png   1024 x 1024 PNG (Linux, and the settings window icon)
//   build/icon.icns  macOS icon: an 'icns' container of PNG entries
//   build/icon.ico   Windows icon: 16 to 256 px, PNG-compressed entries
//
//   node scripts/make-app-icon.mjs
//
// No dependencies: the drawing is a few shapes rendered with supersampled
// coverage (like make-tray-icons.mjs) and encoded with png.mjs. Each size is
// drawn from the shapes, not scaled down from the 1024 px image, and sizes up
// to 32 px leave out the fine detail so the icon stays readable.
//
// The picture: a hard disk with its lid off, seen from above, filling the
// standard macOS rounded square (824 of 1024 units, with the margin and soft
// shadow of the macOS icon grid). Dark case, silver platter, brass actuator
// arm, green activity LED.
//
// Only + - * / and Math.sqrt are used on the geometry, all exactly rounded in
// IEEE arithmetic, so the pixels are the same on every machine; the test
// (test/app-icon.test.js) redraws a few sizes and compares.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNITS = 1024;

// --- Geometry, in a 1024-unit box ---

// The macOS app icon grid: an 824-unit rounded square, centred.
const TILE = { x0: 100, y0: 100, x1: 924, y1: 924, radius: 185 };
const RIM = 10; // lighter bevel just inside the tile edge
const SHADOW = { dy: 12, blur: 28, alpha: 0.32 };

const PLATTER = { cx: 486, cy: 464, r: 300 };
const HUB = { r: 84 };
const SPINDLE = { r: 26 };
const TRACKS = [130, 170, 210, 250]; // faint rings on the platter (detail only)
const ARM = { px: 780, py: 784, hx: 590, hy: 258, r0: 56, r1: 16 }; // pivot to head, radius tapers
const PIVOT = { r: 78 };
const HEAD = { r: 30 };
const LED = { cx: 206, cy: 820, r: 30 };
const SCREWS = [[190, 190], [834, 190]];
const SCREW_R = 22;

// --- Colours (RGB) ---

const CASE_TOP = [78, 84, 94];
const CASE_BOTTOM = [36, 40, 46];
const RIM_COLOUR = [128, 136, 148];
const PLATTER_LIGHT = [238, 240, 244];
const PLATTER_DARK = [168, 174, 184];
const PLATTER_EDGE = [70, 74, 82];
const TRACK = [150, 156, 166];
const HUB_COLOUR = [118, 124, 134];
const HUB_EDGE = [60, 64, 70];
const SPINDLE_COLOUR = [44, 48, 54];
const ARM_LIGHT = [242, 196, 92];
const ARM_DARK = [196, 132, 40];
const ARM_EDGE = [70, 46, 16];
const PIVOT_COLOUR = [210, 214, 220];
const PIVOT_CENTRE = [70, 74, 82];
const SCREW = [150, 156, 166];
const SCREW_SLOT = [40, 44, 50];
const LED_COLOUR = [72, 230, 96];
const LED_CORE = [200, 255, 200];
const LED_EDGE = [16, 60, 24];

// --- Shapes ---

const length = (x, y) => Math.sqrt(x * x + y * y);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Signed distance to a rounded rectangle (negative inside).
function roundedRectDistance(x, y, { x0, y0, x1, y1, radius }) {
  const dx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - radius);
  const dy = Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - radius);
  const outside = length(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

// Distance from the arm's centre line and the position along it (0 at the
// pivot, 1 at the head).
function armPosition(x, y) {
  const ax = ARM.hx - ARM.px;
  const ay = ARM.hy - ARM.py;
  const t = clamp01(((x - ARM.px) * ax + (y - ARM.py) * ay) / (ax * ax + ay * ay));
  return { d: length(x - (ARM.px + ax * t), y - (ARM.py + ay * t)), t };
}

/**
 * Colour of the icon at a point, as [r, g, b, alpha 0..1], for the tile and
 * everything on it (the shadow is added separately).
 */
function tileColourAt(x, y, detailed) {
  const tile = roundedRectDistance(x, y, TILE);
  if (tile > 0) return null;
  const edge = detailed ? 3 : 0; // dark hairline at the tile edge, large sizes only

  // Case: vertical gradient, lighter rim.
  let colour = mix(CASE_TOP, CASE_BOTTOM, clamp01((y - TILE.y0) / (TILE.y1 - TILE.y0)));
  if (tile > -edge) return [...CASE_BOTTOM.map((c) => c * 0.6), 1];
  if (tile > -RIM - edge) colour = mix(colour, RIM_COLOUR, 0.5);

  // Screws (detail only).
  if (detailed) {
    for (const [sx, sy] of SCREWS) {
      const d = length(x - sx, y - sy);
      if (d <= SCREW_R) {
        // A cross slot.
        const slot = Math.abs(x - sx) < 4 || Math.abs(y - sy) < 4;
        return [...(slot && d < SCREW_R - 5 ? SCREW_SLOT : SCREW), 1];
      }
    }
  }

  // Activity LED.
  const ledR = detailed ? LED.r : LED.r * 1.6;
  const led = length(x - LED.cx, y - LED.cy);
  if (led <= ledR) {
    if (led > ledR - (detailed ? 6 : 10)) return [...LED_EDGE, 1];
    return [...mix(LED_CORE, LED_COLOUR, clamp01(led / (ledR * 0.7))), 1];
  }
  if (detailed && led <= ledR * 2.2) {
    // Soft glow around the LED.
    const glow = 1 - (led - ledR) / (ledR * 1.2);
    colour = mix(colour, LED_COLOUR, 0.35 * glow * glow);
  }

  // Actuator arm, drawn over the platter.
  const arm = armPosition(x, y);
  const armR = (ARM.r0 + (ARM.r1 - ARM.r0) * arm.t) * (detailed ? 1 : 1.25);
  const armEdge = detailed ? 6 : 10;
  const pivot = length(x - ARM.px, y - ARM.py);
  if (pivot <= PIVOT.r) {
    if (pivot > PIVOT.r - armEdge) return [...ARM_EDGE, 1];
    if (detailed && pivot < 22) return [...PIVOT_CENTRE, 1];
    return [...PIVOT_COLOUR, 1];
  }
  const head = length(x - ARM.hx, y - ARM.hy);
  const headR = HEAD.r * (detailed ? 1 : 1.25);
  if (arm.d <= armR || head <= headR) {
    if (arm.d > armR - armEdge && head > headR - armEdge) return [...ARM_EDGE, 1];
    if (head <= headR) return [...(head > headR - armEdge ? ARM_EDGE : ARM_DARK), 1];
    // Lit from the top left: lighter on that side of the centre line.
    const ax = ARM.hx - ARM.px;
    const ay = ARM.hy - ARM.py;
    const side = ((x - ARM.px) * ay - (y - ARM.py) * ax) / length(ax, ay);
    return [...mix(ARM_DARK, ARM_LIGHT, clamp01(0.5 + side / (2 * armR))), 1];
  }

  // Platter.
  const p = length(x - PLATTER.cx, y - PLATTER.cy);
  if (p <= PLATTER.r) {
    const platterEdge = detailed ? 8 : 16;
    if (p > PLATTER.r - platterEdge) return [...PLATTER_EDGE, 1];
    if (p <= SPINDLE.r && detailed) return [...SPINDLE_COLOUR, 1];
    const hubR = detailed ? HUB.r : HUB.r * 1.15;
    if (p <= hubR) {
      if (p > hubR - (detailed ? 6 : 12)) return [...HUB_EDGE, 1];
      return [...HUB_COLOUR, 1];
    }
    // A diagonal sheen: light top left, darker bottom right.
    const along = ((x - PLATTER.cx) + (y - PLATTER.cy)) / (2 * PLATTER.r);
    let platter = mix(PLATTER_LIGHT, PLATTER_DARK, clamp01(0.5 + along));
    if (detailed && TRACKS.some((r) => Math.abs(p - r) < 2)) platter = mix(platter, TRACK, 0.7);
    return [...platter, 1];
  }

  return [...colour, 1];
}

// The soft drop shadow under the tile (alpha only, black).
function shadowAlpha(x, y) {
  const d = roundedRectDistance(x, y - SHADOW.dy, TILE);
  if (d >= SHADOW.blur) return 0;
  const t = 1 - clamp01(d / SHADOW.blur);
  return SHADOW.alpha * t * t;
}

/** Render the icon at size x size pixels; returns RGBA bytes. */
export function renderIcon(size) {
  const detailed = size > 32;
  const supersample = size >= 512 ? 3 : size >= 128 ? 4 : 8;
  const samples = supersample * supersample;
  const scale = UNITS / size;
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Average premultiplied colour over the subsamples.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const x = (px + (sx + 0.5) / supersample) * scale;
          const y = (py + (sy + 0.5) / supersample) * scale;
          const colour = tileColourAt(x, y, detailed);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 1;
          } else {
            a += shadowAlpha(x, y); // black: adds alpha, no colour
          }
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

// --- Containers ---

// icns entry types holding PNG data, and their pixel sizes. The @2x types
// repeat a size another type also has; each entry carries its own copy.
export const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic07', 128],
  ['ic13', 256], // 128@2x
  ['ic08', 256],
  ['ic14', 512], // 256@2x
  ['ic09', 512],
  ['ic10', 1024] // 512@2x
];

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** An icns file: 'icns' + total length, then (type, length, data) entries. */
export function buildIcns(pngBySize) {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const data = pngBySize.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([header, data]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
  return Buffer.concat([header, ...entries]);
}

/** An ico file with one PNG-compressed image per size (Windows Vista and later). */
export function buildIco(pngBySize, sizes = ICO_SIZES) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const directory = Buffer.alloc(16 * sizes.length);
  let offset = header.length + directory.length;
  sizes.forEach((size, n) => {
    const data = pngBySize.get(size);
    const at = n * 16;
    directory[at] = size >= 256 ? 0 : size; // 0 means 256
    directory[at + 1] = size >= 256 ? 0 : size;
    directory[at + 2] = 0; // no palette
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...sizes.map((size) => pngBySize.get(size))]);
}

/** Every size the outputs need, rendered and PNG-encoded. */
export function renderAll() {
  const sizes = new Set([...ICNS_TYPES.map(([, size]) => size), ...ICO_SIZES, 1024]);
  const pngBySize = new Map();
  for (const size of [...sizes].sort((a, b) => a - b)) {
    pngBySize.set(size, encodePng(size, size, renderIcon(size)));
  }
  return pngBySize;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pngBySize = renderAll();
  const outputs = [
    ['build/icon.png', pngBySize.get(1024)],
    ['build/icon.icns', buildIcns(pngBySize)],
    ['build/icon.ico', buildIco(pngBySize)]
  ];
  for (const [file, data] of outputs) {
    writeFileSync(path.join(ROOT, file), data);
    console.log(`wrote ${file} (${data.length} bytes)`);
  }
}
