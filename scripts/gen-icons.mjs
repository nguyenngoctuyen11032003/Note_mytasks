#!/usr/bin/env node
// Regenerates the PWA icons in public/icons (+ public/favicon.svg) from one
// vector description, with no dependencies (node:zlib only).
//
//   node scripts/gen-icons.mjs
//
// Colours follow the "Coffee Glass" theme (src/css/tokens.css, dark):
//   background --paper #180a06 · glyph --ink #ede4d8 · dot --accent #d99a62
// Keep manifest.webmanifest theme_color/background_color = BG.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = [0x18, 0x0a, 0x06];
const INK = [0xed, 0xe4, 0xd8];
const ACCENT = [0xd9, 0x9a, 0x62];

// Artwork on a 64×64 grid (same as favicon.svg): a monoline "N" and a dot.
const N_GLYPH = [[18, 46], [18, 18], [24, 18], [40, 38], [40, 18], [46, 18], [46, 46], [40, 46], [24, 26], [24, 46]];
const DOT = { cx: 48, cy: 48, r: 4 };
const RADIUS = 14; // rounded-square corner (64 grid)

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 64 - r);
  const cy = Math.min(Math.max(y, r), 64 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * @param {number} size     output px
 * @param {object} o
 * @param {boolean} o.rounded  transparent corners (purpose "any"); otherwise full-bleed square
 * @param {number}  o.scale    artwork scale around the centre (maskable: keep inside the 80% safe zone)
 */
function render(size, { rounded, scale = 1 }) {
  const SS = 4; // 4×4 supersampling
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((pxl + (sx + 0.5) / SS) / size) * 64;
          const y = ((py + (sy + 0.5) / SS) / size) * 64;
          if (rounded && !inRoundRect(x, y, RADIUS)) continue;
          // artwork coordinates (scaled about the centre)
          const ax = 32 + (x - 32) / scale, ay = 32 + (y - 32) / scale;
          let c = BG;
          if (inPolygon(ax, ay, N_GLYPH)) c = INK;
          else if ((ax - DOT.cx) ** 2 + (ay - DOT.cy) ** 2 <= DOT.r ** 2) c = ACCENT;
          a++; r += c[0]; g += c[1]; b += c[2];
        }
      }
      const i = (py * size + pxl) * 4;
      if (a) { px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a); }
      px[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, size, px);
}

/* ---------- minimal PNG encoder (RGBA8, filter 0) ---------- */
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- outputs ---------- */
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const OUT = [
  ['icons/icon-192.png', 192, { rounded: true }],
  ['icons/icon-512.png', 512, { rounded: true }],
  ['icons/icon-maskable-192.png', 192, { rounded: false, scale: 0.72 }],
  ['icons/icon-maskable-512.png', 512, { rounded: false, scale: 0.72 }],
  ['icons/apple-touch-icon.png', 180, { rounded: false, scale: 0.86 }], // iOS applies its own mask
];
mkdirSync(join(root, 'icons'), { recursive: true });
for (const [file, size, opts] of OUT) {
  writeFileSync(join(root, file), render(size, opts));
  console.log('wrote public/' + file);
}
const pts = N_GLYPH.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('') + 'z';
writeFileSync(join(root, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${RADIUS}" fill="${hex(BG)}"/>` +
  `<path d="${pts}" fill="${hex(INK)}"/><circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="${hex(ACCENT)}"/></svg>\n`);
console.log('wrote public/favicon.svg');
