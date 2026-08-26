// The tab icon, built from the mark the app already draws.
//
// There was no favicon at all: the site asked for /favicon.ico, got a 404, and
// every tab, bookmark and history row showed the browser's blank page glyph
// next to a map that has a logo on its own navbar.
//
// WHY A SCRIPT AND NOT A FILE. src/logo.png is the mark, in one place, drawn at
// 32px and used at 32px by .g-navbar-mark and .g-sheet-mark. A hand-made .ico
// beside it is a second copy that nobody will remember to redraw, and the first
// time the logo changes the tab keeps the old one — silently, because a favicon
// is the one image you never look at while you work. This derives the icon from
// the mark instead, so there is still only one drawing of it.
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
//
//   node scripts/build-favicon.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src/logo.png');
// public/, because an .ico has to be at the ORIGIN ROOT to be found without a
// link element — by the bookmark bar, by an RSS reader, by anything that has
// the URL but not the markup. Vite copies this directory to the root of dist/,
// which is what server/index.js serves in production.
const out = resolve(root, 'public/favicon.ico');

const png = readFileSync(src);

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

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([dir, png]));
console.log(`favicon.ico  ${width}x${height}  ${dir.length + png.length} bytes`);
