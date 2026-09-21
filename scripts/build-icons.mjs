// The icons a browser shows for this site, built from the mark the app draws.
//
// There was no favicon at all: the site asked for /favicon.ico, got a 404, and
// every tab, bookmark and history row showed the browser's blank page glyph
// next to a map that has a logo on its own navbar. There was no touch icon
// either, so an iPhone told to Add to Home Screen took a SCREENSHOT of the
// page and used that — a thumbnail of a map, indistinguishable at 60px from
// every other map on the springboard.
//
// WHY A SCRIPT AND NOT TWO FILES. src/logo.png is the mark, in one place,
// drawn at 32px and used at 32px by .g-navbar-mark and .g-sheet-mark. Icons
// made by hand beside it are copies nobody will remember to redraw, and the
// first time the logo changes the tab and the home screen keep the old one —
// silently, because these are the two images you never look at while you work.
// This derives both from the mark instead, so there is still only one drawing.
//
//   node scripts/build-icons.mjs
//
// The PNG reading and writing below is done with node:zlib rather than a
// dependency. It is a hundred lines, it runs at build time on one 32x32 image,
// and it is a smaller thing to own than an image library in devDependencies.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src/logo.png');
// public/, because an .ico has to be at the ORIGIN ROOT to be found without a
// link element — by the bookmark bar, by an RSS reader, by anything that has
// the URL but not the markup. iOS looks for /apple-touch-icon.png the same way.
// Vite copies this directory to the root of dist/, which is what
// server/index.js serves in production.
const pub = resolve(root, 'public');

const png = readFileSync(src);

// ---------------------------------------------------------------- favicon.ico
//
// WHAT IS IN THE FILE: the source PNG, byte for byte, and nothing else.
//
// That is the whole design, and it is the opposite of what an icon generator
// does. The mark is a PIXEL DRAWING — 32 by 32, black or white ink plus the
// red of the pin, no anti-aliasing anywhere in it. Every size that is not the
// source is a resample, and the sizes an .ico is conventionally packed with are
// exactly the ones that ruin it: 16 halves it and the M loses its middle stroke,
// the b's bowl fills in and the pin loses its stem (checked, not assumed); 48
// is one-and-a-half source pixels per screen pixel, which is the case pixel art
// has no good answer to.
//
// So the file carries the one size that is real. A browser drawing a 16px tab
// on a 2x display asks for 32 device pixels and gets this entry exactly; on a
// 1x display it downsamples 32 to 16 with a smooth filter, which is a softer
// mark but a legible one, and is strictly better than the crushed 16 a packed
// icon would have handed it. index.html links the two PNGs beside this for the
// light and dark cases, and this is the fallback under them.

// The PNG's own IHDR, so a logo redrawn at another size cannot silently ship an
// .ico whose directory entry disagrees with the image inside it.
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (png.readUInt32BE(1) !== 0x504e470d) throw new Error(`${src} is not a PNG`);
if (width > 256 || height > 256) throw new Error(`${width}x${height} is too big for an .ico`);

// ICONDIR, then one ICONDIRENTRY. Both little-endian.
const dir = Buffer.alloc(6 + 16);
dir.writeUInt16LE(0, 0);          // reserved
dir.writeUInt16LE(1, 2);          // 1 = icon (2 would be a cursor)
dir.writeUInt16LE(1, 4);          // how many images follow
// 256 is written as 0 in these two bytes, which is the format's way of saying
// "the one size that does not fit in a byte".
dir.writeUInt8(width % 256, 6);
dir.writeUInt8(height % 256, 7);
dir.writeUInt8(0, 8);             // palette size; 0 for a truecolour image
dir.writeUInt8(0, 9);             // reserved
dir.writeUInt16LE(1, 10);         // colour planes
dir.writeUInt16LE(32, 12);        // bits per pixel — RGBA
dir.writeUInt32LE(png.length, 14);
dir.writeUInt32LE(dir.length, 18); // the payload starts right after this header

mkdirSync(pub, { recursive: true });
writeFileSync(resolve(pub, 'favicon.ico'), Buffer.concat([dir, png]));
console.log(`favicon.ico          ${width}x${height}  ${dir.length + png.length} bytes`);

// ------------------------------------------------------------- the tile icons
//
// THREE SIZES OUT OF ONE DRAWING, for three things that ask differently.
//
//   180  apple-touch-icon.png, which is the size an iPhone at 3x asks for, and
//        the one every smaller ask is scaled down from. Found by iOS at the
//        origin root whether or not anything links it.
//   192  the smallest an installable web app may offer, and what Android draws
//        on the home screen. Named by public/manifest.webmanifest.
//   512  what the same manifest is asked for by the install prompt and the app
//        switcher, where the icon is shown several times larger than anything
//        above.
//
// The manifest is the reason the last two exist. There was one tile here and it
// was Apple's, so telling Android to install this app offered it a 180 — under
// the floor Chrome will accept for an installable icon, which is how a mark
// built on purpose ends up replaced by the letter B on a coloured circle.
//
// PAINTED GROUND, ROUNDED THE WAY APPLE ROUNDS IT.
//
// The ground is painted rather than left transparent because iOS composites a
// web clip's alpha against BLACK, which would take a black-ink mark with it.
// And it is white because this is src/logo.png, the light-theme drawing, and a
// home screen picks its icon once at install with no way to ask for the dark
// one later.
//
// The corners are cut, which is not what you would guess from the fact that
// iOS masks the tile itself. maps.apple.com ships its own 180 pre-rounded —
// alpha 0 in the corners, the straight edge starting 41px in — and the reason
// is that the mask is only iOS's to apply. Anything else that finds this file
// draws it as it is, and an unrounded one is a white rectangle sitting on the
// wallpaper. On iOS the two roundings coincide and the second is a no-op; the
// only alpha in the file is outside the mask, where iOS discards it anyway.
//
// The corner is FITTED, not chosen. A plain superellipse over the whole tile is
// the usual guess and it is wrong in a way you can see: it is tangent to each
// side at one point, so the flat part of every edge is half-transparent. The
// shape is a rectangle with a smoothed corner — straight edges, and inside a
// corner square of side 0.328 of the tile a superellipse of exponent MASK_N.
// Both numbers were solved against the alpha channel of maps.apple.com's own
// maps-app-icon-180x180.png, and reproduce it to a mean of 0.6 in 255. The
// radius is a fraction rather than a count of pixels so the same corner comes
// out of a 192 and a 512 as out of the 180 it was fitted to.
//
// SCALED BY A WHOLE NUMBER, NOT BY size/32. 5.625 source pixels per icon pixel
// is the exact case the .ico above refuses to touch — every sixth row of a
// drawing with no anti-aliasing in it comes out a different weight from its
// neighbours, and on a mark this small that reads as a wobble in the stroke. A
// whole number makes every source pixel a clean square block and the drawing
// survives; what the scale leaves over becomes margin, which the tile wanted
// anyway.
//
// So each size below names its own scale rather than deriving one. The three
// are the largest whole number that still leaves the mark near 78% of the tile
// — 5 into 180 and 192, 14 into 512 — and the assertion in `tile` is what
// catches a logo redrawn larger than the pair can hold.
//
// CENTRED ON THE INK, not on the source canvas. The mark sits in its 32 box
// with a spare column on the right and three spare rows under the pin's stem —
// fine in a navbar, where it is one item in a row, and visible on a tile, where
// it is the only thing there. Centring the drawn pixels puts the margin evenly
// around it. At these scales that leaves the ink between 73% and 78% of the
// tile tall, which clears the corner everywhere — checked against the fitted
// mask below, and against masks rounder than it, rather than eyeballed.

const GROUND = [0xff, 0xff, 0xff];
const MASK_N = 2.7;
// Samples per axis inside each pixel when working out how much of it the mask
// covers. 4 is 16 samples, which is enough to keep the curve from stepping.
const MASK_SAMPLES = 4;

const mark = decode(png);
const box = inkBox(mark);

for (const [name, size, scale] of [
  ['apple-touch-icon.png', 180, 5],
  ['icon-192.png', 192, 5],
  ['icon-512.png', 512, 14],
]) {
  const image = tile(size, scale);
  writeFileSync(resolve(pub, name), image);
  const ink = `${(box.right - box.left) * scale}x${(box.bottom - box.top) * scale}`;
  console.log(`${name.padEnd(20)} ${size}x${size}  ${image.length} bytes  (mark at ${scale}x, ${ink})`);
}

/** One tile: white ground, the mark centred on it, Apple's corner cut out. */
function tile(size, scale) {
  const inkW = (box.right - box.left) * scale;
  const inkH = (box.bottom - box.top) * scale;
  if (inkW > size || inkH > size) throw new Error(`the mark is ${inkW}x${inkH} at ${scale}x, which will not fit a ${size} tile`);

  const radius = size * 0.328;

  // Where the source's own origin lands once the ink is centred.
  const originX = Math.round(size / 2 - (box.left * scale + inkW / 2));
  const originY = Math.round(size / 2 - (box.top * scale + inkH / 2));

  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels.set(GROUND, i);
    pixels[i + 3] = 0xff;
  }

  for (let y = 0; y < size; y++) {
    const sy = Math.floor((y - originY) / scale);
    if (sy < 0 || sy >= mark.height) continue;
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x - originX) / scale);
      if (sx < 0 || sx >= mark.width) continue;
      const s = (sy * mark.width + sx) * 4;
      const a = mark.pixels[s + 3] / 255;
      if (a === 0) continue;
      const d = (y * size + x) * 4;
      // Over white. The mark is hard-edged, so this only ever runs at a === 1,
      // but a redrawn logo with a soft edge should land on the ground, not on
      // whatever the alpha channel happened to be multiplied into.
      for (let c = 0; c < 3; c++) {
        pixels[d + c] = Math.round(mark.pixels[s + c] * a + GROUND[c] * (1 - a));
      }
    }
  }

  // The corner, last, so it cuts the finished tile rather than the ground it
  // was painted on.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const covered = coverage(x, y, size, radius);
      if (covered === 1) continue;
      pixels[(y * size + x) * 4 + 3] = Math.round(covered * 0xff);
    }
  }

  return encode(size, size, pixels);
}

// ------------------------------------------------------------------ PNG parts

function decode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error(`${src} is not a PNG`);
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const depth = buf.readUInt8(24);
  const colour = buf.readUInt8(25);
  const interlace = buf.readUInt8(28);
  // Narrow on purpose: this reads the one file in this repo, and a PNG that is
  // not 8-bit RGBA should stop the build rather than be guessed at.
  if (depth !== 8 || colour !== 6 || interlace !== 0) {
    throw new Error(`${src} is not an 8-bit non-interlaced RGBA PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
  }

  const parts = [];
  for (let i = 8; i + 8 <= buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IDAT') parts.push(buf.subarray(i + 8, i + 8 + len));
    if (type === 'IEND') break;
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));

  // Undo the per-row filters. bpp is 4 because the colour type says RGBA.
  const bpp = 4;
  const stride = w * bpp;
  const pixels = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) add = paeth(a, b, c);
      else if (filter !== 0) throw new Error(`unknown PNG row filter ${filter}`);
      pixels[y * stride + x] = (line[x] + add) & 0xff;
    }
  }
  return { width: w, height: h, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// How much of the pixel at x,y falls inside the mask, from 0 to 1. Sampled on a
// grid rather than solved, because the answer only has to be good to a 255th
// and this runs 32400 times once.
function coverage(x, y, size, radius) {
  let inside = 0;
  for (let sy = 0; sy < MASK_SAMPLES; sy++) {
    for (let sx = 0; sx < MASK_SAMPLES; sx++) {
      // Distance to the nearer edge on each axis, so one corner's arithmetic
      // does for all four.
      const px = x + (sx + 0.5) / MASK_SAMPLES;
      const py = y + (sy + 0.5) / MASK_SAMPLES;
      const dx = Math.min(px, size - px);
      const dy = Math.min(py, size - py);
      if (dx >= radius || dy >= radius) { inside++; continue; }
      const u = (radius - dx) / radius;
      const v = (radius - dy) / radius;
      if (u ** MASK_N + v ** MASK_N <= 1) inside++;
    }
  }
  return inside / (MASK_SAMPLES * MASK_SAMPLES);
}

// Colour type 6, because the corners have to be cut out of something. Every row
// is written with filter 0: the tile is flat blocks of one colour and deflate
// has an easy time of it either way.
function encode(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // colour type: truecolour with alpha
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter method
  ihdr.writeUInt8(0, 12);  // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}

// The drawn pixels, which are not the canvas: see the note above the tile.
function inkBox({ width: w, height: h, pixels }) {
  let left = w; let top = h; let right = 0; let bottom = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixels[(y * w + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (y < top) top = y;
      if (x >= right) right = x + 1;
      if (y >= bottom) bottom = y + 1;
    }
  }
  if (left >= right) throw new Error(`${src} has no opaque pixels in it`);
  return { left, top, right, bottom };
}
