#!/usr/bin/env node
// Builds the web / PWA / iOS icon set from the brand logo render.
//
//   npm i --no-save sharp && node scripts/make-icons.mjs
//
// Source: design/brand/logo-source.png, a render of the gradient "S" hex mark
// on a dark tile. Its dark ground is noisy, so the mark is keyed out by
// brightness (soft edge), un-premultiplied against the near-black ground, and
// recomposed on a clean navy tile at the padding each purpose needs:
//   icons/icon-{192,512}.png           purpose "any": bare transparent mark, 90% tall
//   icons/icon-maskable-{192,512}.png  full bleed tile, mark 58% (inside the 80% safe circle)
//   icons/apple-touch-icon.png         180px, full bleed (iOS rounds the corners)
//   icons/favicon-{16,32}.png, favicon.ico (16/32/48)  bare mark filling the square
//   icons/logo-mark.png                transparent mark, 256px tall, for in-app use
// sharp is not a project dependency, so install it ad hoc (command above).
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'design', 'brand', 'logo-source.png');
const PUB = join(root, 'public');
const ICONS = join(PUB, 'icons');
mkdirSync(ICONS, { recursive: true });

const BG = '#0a0d1a';     // clean deep-navy tile
const LO = 52, HI = 112;  // brightness ramp: ≤ LO is ground, ≥ HI is mark

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const mark = Buffer.alloc(W * H * 4);
let x0 = W, y0 = H, x1 = 0, y1 = 0;
for (let i = 0, p = 0; p < W * H; p++, i += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const t = Math.min(1, Math.max(0, (Math.max(r, g, b) - LO) / (HI - LO)));
  const a = t * t * (3 - 2 * t); // smoothstep
  if (!a) continue;
  const k = Math.max(a, 0.35);   // ground ≈ black → colour ≈ observed / alpha
  mark[i] = Math.min(255, r / k);
  mark[i + 1] = Math.min(255, g / k);
  mark[i + 2] = Math.min(255, b / k);
  mark[i + 3] = Math.round(a * 255);
  if (a > 0.5) {
    const x = p % W, y = (p / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
}
// Crop to the mark (+ margin); this also drops background specks outside it.
const M = 6;
const left = Math.max(0, x0 - M), top = Math.max(0, y0 - M);
const markPng = await sharp(mark, { raw: { width: W, height: H, channels: 4 } })
  .extract({ left, top, width: Math.min(W, x1 + M + 1) - left, height: Math.min(H, y1 + M + 1) - top })
  .png().toBuffer();

const markAt = (size, frac) => sharp(markPng)
  .resize({ height: Math.round(size * frac), kernel: 'lanczos3' })
  .sharpen(size <= 64 ? { sigma: 0.6 } : undefined)
  .png().toBuffer();

/** Clean tile with a soft blue glow behind the mark; `radius` as a fraction of size. */
function tile(size, radius = 0) {
  const r = Math.round(size * radius);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <radialGradient id="g" cx="50%" cy="46%" r="62%">
        <stop offset="0" stop-color="#1b2a6b" stop-opacity="0.55"/>
        <stop offset="0.55" stop-color="#151a45" stop-opacity="0.25"/>
        <stop offset="1" stop-color="${BG}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="e" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.07"/>
        <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" rx="${r}" fill="${BG}"/>
    <rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
    ${r ? `<rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${r}" fill="none" stroke="url(#e)" stroke-width="${Math.max(1, size / 256)}"/>` : ''}
  </svg>`);
}

/** `radius === null` → no tile: the bare mark on a transparent canvas. */
async function icon(file, size, frac, radius = 0) {
  const m = await markAt(size, frac);
  const { width, height } = await sharp(m).metadata();
  const base = radius === null
    ? sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    : sharp(tile(size, radius));
  const buf = await base
    .composite([{ input: m, left: Math.round((size - width) / 2), top: Math.round((size - height) / 2) }])
    .png({ compressionLevel: 9 }).toBuffer();
  if (file) writeFileSync(file, buf);
  return buf;
}

// Tab / desktop icons: bare mark, filling the square like other apps' glyphs.
await icon(join(ICONS, 'icon-512.png'), 512, 0.9, null);
await icon(join(ICONS, 'icon-192.png'), 192, 0.9, null);
const f16 = await icon(join(ICONS, 'favicon-16.png'), 16, 1, null);
const f32 = await icon(join(ICONS, 'favicon-32.png'), 32, 0.97, null);
const f48 = await icon(null, 48, 0.96, null);
// Launchers that require an opaque square keep the tile: Android "maskable"
// (mark inside the 80% safe circle) and iOS home screen (no transparency).
await icon(join(ICONS, 'icon-maskable-512.png'), 512, 0.58);
await icon(join(ICONS, 'icon-maskable-192.png'), 192, 0.58);
await icon(join(ICONS, 'apple-touch-icon.png'), 180, 0.68);
writeFileSync(join(ICONS, 'logo-mark.png'), await sharp(markPng).resize({ height: 256, kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer());

// favicon.ico holding PNG-encoded 16/32/48 images.
const imgs = [[16, f16], [32, f32], [48, f48]];
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
const dir = Buffer.alloc(16 * imgs.length);
let offset = head.length + dir.length;
imgs.forEach(([s, b], k) => {
  const o = k * 16;
  dir[o] = s; dir[o + 1] = s;
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(b.length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += b.length;
});
writeFileSync(join(PUB, 'favicon.ico'), Buffer.concat([head, dir, ...imgs.map(([, b]) => b)]));
console.log('icons written to public/ and public/icons/');
