/**
 * Lift the printed campus map's own labels out of campus-map.pdf.
 *
 * The map used to be labelled from locations.json, which is my campus's *database* of
 * destinations, not a set of map labels. Those names are written to be
 * unambiguous in a search box, and on a map they are unreadable —
 * "Manufacturing, Construction, and Transportation Division - Portable Village,
 * Room 603B" is a paragraph sitting on a building.
 *
 * The PDF has a real text layer, and it holds what a cartographer actually set:
 * "Library", "Admin Bldg.", "Main Gym", "Raef Hall", "STADIUM". Short, and
 * hand-placed where they belong. Because that PDF is the same drawing as
 * ActiveMap.svg to within centimetres (see projection.mjs), those positions
 * transfer exactly. locations.json is still the right source for *search*; it
 * was only ever the wrong source for *labels*.
 *
 * Needs `pdftotext` (poppler-utils) on PATH, unlike every other script here.
 * The output is committed, so this only has to run when the PDF changes.
 *
 *   node scripts/build-labels.mjs
 *
 * ---------------------------------------------------------------------------
 * Separating labels from wreckage
 *
 * pdftotext returns 183 lines and only about 55 are wanted. Most of the
 * rejects are easy — the title block, the legend column, the version stamp,
 * the bare "P" and "BUS" chips that are already drawn as symbols.
 *
 * The hard case is text set along a curve. The PDF runs its road, aisle and
 * lot labels around bends, which means each fragment lands on its own baseline
 * and extraction returns them as separate lines: "Hut" "chis" "on L" "oop", or
 * "Bea" "ver" "Lan". Reassembling those is not worth it — every one of them is
 * a road or a parking aisle, and this is a pedestrian map with no street names
 * on campus, so they were never wanted.
 *
 * Two filters that do NOT work, both tried and measured:
 *
 *   - Dropping short single-line labels. "Music", "Pool", "Rec." and "Oak" are
 *     all real, and all short.
 *   - Asking whether the label sits on a building or a landcover polygon. The
 *     wreckage sits on car parks, because it is made of car park labels; and
 *     "Fine & Applied Arts", "Portable Village", "TENNIS COURTS" and "SOFTBALL
 *     FIELD" all sit on open ground and would be thrown away.
 *
 * What does work is how the two are set. A stacked label is centred — the lines
 * of "Technical / Education / West (TEW)" share a centre x to within 0.1 pt. A
 * curved run steps sideways, each fragment starting a few points right or left
 * of the last and on a different baseline. So: a line is a fragment when a
 * neighbour of the same size sits within NEAR_PT, its baseline differs by
 * BASELINE_PT, and its centre is offset by more than STACK_PT.
 *
 * That leaves a handful whose chain partners were removed earlier as rotated,
 * so they have nothing left to be a chain with. They are listed in ORPHANS
 * rather than chased with a cleverer rule: the PDF is a fixed archived file,
 * there are five of them, and an explicit list is honest where a heuristic
 * tuned until the count came out right would not be.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPdf } from './projection.mjs';
import { readShapes, pointInRing, applyMat, parseTransform } from './svg-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDF = path.join(root, 'campus-data/wayfind/external/campus-map.pdf');
const SVG = path.join(root, 'campus-data/wayfind/api/ActiveMap.svg');
const TARGET = path.join(root, 'src/labels.json');
// A committed artifact, like this script's own output — the dependency is on
// the file, not on build-buildings.mjs having just run.
const BUILDINGS = path.join(root, 'src/buildings.json');

/** Above this y is the title block; the sheet is 612 x 792 pt. */
const TITLE_Y = 70;
/** At or beyond this x is the legend column. Environmental Resources ends at 478. */
const LEGEND_X = 455;
/** No horizontal label is this tall; anything taller is set vertically. */
const MAX_H = 20;

// Curved-run detection — see the header.
const NEAR_PT = 12;
const BASELINE_PT = [1.5, 9];
const STACK_PT = 2.5;

// Fragments of curved labels whose neighbours were already dropped as rotated,
// leaving them with no chain to be detected by. In order, they are pieces of
// "Staff Hutchison Loop Parking", "Ranch House Staff Parking" and
// "NO VEHICLE ACCESS".
const ORPHANS = new Set(['n L', 'Park', 'Sta', 'Ho', 'use', 'NO', 'ES']);

// Real labels that are deliberately not drawn. The roads because this is a
// pedestrian map — Mapbox still names the streets outside the boundary — and
// the drop-offs because build-amenities already puts a symbol on both.
const SUPPRESS = new Set(['Myrtle Ave', 'Beaver Lane', 'Student Drop-Off']);

// --- read the text layer ----------------------------------------------------

const xml = execFileSync('pdftotext', ['-bbox-layout', PDF, '-'], { encoding: 'utf8' });

const LINE_RE = /<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/line>/gs;
const WORD_RE = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;

/**
 * A run of words is cut here when the space before the next one exceeds this
 * fraction of the line height.
 *
 * Two labels that share a baseline arrive as one line. "Oak / Cafe" is set
 * beside "Evangelisti / Culinary Arts / Center", so "Evangelisti" and "Cafe"
 * come back joined, and both labels are then wrong. Across all 81 word gaps in
 * the sheet the ordinary spaces reach 0.187 and that single seam is 0.394, so
 * the threshold sits in an empty band rather than on a value that had to be
 * tuned until the answer looked right.
 */
const SPLIT_GAP = 0.28;

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

const boxOf = (words) => {
  const x0 = Math.min(...words.map((w) => w.x0));
  const y0 = Math.min(...words.map((w) => w.y0));
  const x1 = Math.max(...words.map((w) => w.x1));
  const y1 = Math.max(...words.map((w) => w.y1));
  return {
    x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2,
    text: words.map((w) => w.text).join(' ').trim(),
  };
};

const lines = [];
for (const [, , ly0, , ly1, body] of xml.matchAll(LINE_RE)) {
  const height = +ly1 - +ly0;
  const words = [...body.matchAll(WORD_RE)].map(([, x0, y0, x1, y1, text]) => ({
    x0: +x0, y0: +y0, x1: +x1, y1: +y1, text: decode(text),
  }));
  if (!words.length) continue;

  let run = [words[0]];
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].x0 - words[i - 1].x1 > SPLIT_GAP * height) {
      lines.push(boxOf(run));
      run = [];
    }
    run.push(words[i]);
  }
  lines.push(boxOf(run));
}

const isChrome = (l) => (
  l.y0 < TITLE_Y                       // title block
  || l.x0 >= LEGEND_X                  // legend column
  || l.h > MAX_H || l.w < l.h          // set vertically
  || l.text.length < 2                 // stray glyph
  || l.text === 'P' || l.text === 'BUS'
  || /^[\d|\s]+$/.test(l.text)         // bus route chips
  || l.text.startsWith('Ver.')         // version stamp
);

const candidates = lines
  .filter((l) => !isChrome(l))
  .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

/**
 * A line set along a curve rather than stacked under the one above it.
 *
 * The centre-aligned guard comes first and is what keeps "Gym" — it sits 6.8 pt
 * from "hison", a piece of the curved "Hutchison Loop", which is close enough
 * and offset enough to look like a chain. But it is also centred exactly under
 * "Practice", and nothing set along a curve ever is.
 */
function isFragment(line, others) {
  const stacked = others.some((other) => {
    if (other === line || Math.abs(other.h - line.h) > 1.6) return false;
    const dy = Math.abs(other.y0 - line.y0);
    return dy > 0 && dy < 14 && Math.abs(other.cx - line.cx) <= STACK_PT;
  });
  if (stacked) return false;

  return others.some((other) => {
    if (other === line) return false;
    if (Math.abs(other.h - line.h) > 2) return false;
    if (Math.hypot(other.cx - line.cx, other.y0 - line.y0) > NEAR_PT) return false;
    const dy = Math.abs(other.y0 - line.y0);
    if (dy < BASELINE_PT[0] || dy > BASELINE_PT[1]) return false;
    return Math.abs(other.cx - line.cx) > STACK_PT;
  });
}

const clean = candidates.filter((l) => !isFragment(l, candidates) && !ORPHANS.has(l.text));

// --- assemble multi-line labels ---------------------------------------------

const blocks = [];
for (const line of clean) {
  const block = blocks.find((b) => {
    const last = b.at(-1);
    const gap = line.y0 - last.y1;
    return Math.abs(line.h - last.h) < 1.6
      && gap >= -6 && gap <= 5
      && Math.abs(line.cx - last.cx) <= Math.max(4.5, 0.45 * Math.max(line.w, last.w));
  });
  if (block) block.push(line);
  else blocks.push([line]);
}

/**
 * Join a block's lines.
 *
 * Normally a space, but the PDF also breaks single words across two lines with
 * no hyphen — "Book" over "store". Those are joined tight, recognised by both
 * lines being one token and the second starting lower-case, which no genuine
 * two-line phrase here does ("and Support" is three tokens, "Applied Arts"
 * starts upper-case).
 */
function joinBlock(block) {
  return block.reduce((text, line, i) => {
    if (i === 0) return line.text;
    const tight = block.length === 2
      && block[0].text.split(' ').length === 1
      && line.text.split(' ').length === 1
      && /^[a-z]/.test(line.text);
    return text + (tight ? '' : ' ') + line.text;
  }, '');
}

// --- classify ---------------------------------------------------------------

// my campus sets some building names in white on a dark plate. Those plates are the
// #4e4e4f shapes in the SVG, so the styling carries across from the other file
// rather than being guessed from the text.
const shapes = readShapes(readFileSync(SVG, 'utf8'));
const plates = shapes.filter((s) => s.attrs.fill === '#4e4e4f').map((s) => s.ring);

// Plate hit-testing happens in SVG units, so PDF points have to come back the
// other way. Derived from the two transforms rather than fitted again.
const svgFromPdf = ([x, y]) => {
  const [lon, lat] = projectPdf([x, y]);
  return [(lon + 121.351255212) / 0.000018957771, (38.653866848 - lat) / 0.000014855558];
};

const onPlate = (cx, cy) => {
  const p = svgFromPdf([cx, cy]);
  return plates.some((ring) => pointInRing(p, ring));
};

// Car park names — "Myrtle West", "Staff Parking" — are set in the same face as
// the building names and were being classified as buildings, which put them in
// competition with real ones during label collision. A label sitting inside one
// of the #a9afb7 car park surfaces is naming the lot, not a building. Read from
// the SVG rather than from src/basemap.json so this script keeps depending only
// on the archived source, not on another generator having run first.
const carParks = shapes.filter((s) => s.attrs.fill === '#a9afb7').map((s) => s.ring);
// One shape, and the only non-building facility whose label sits on a car park.
const poolShape = shapes.filter((s) => s.attrs.fill === '#37afcb').map((s) => s.ring);

const footprints = JSON.parse(readFileSync(BUILDINGS, 'utf8')).features;
const inFootprint = (coords) =>
  footprints.find((f) => pointInRing(coords, f.geometry.coordinates[0])) ?? null;

/**
 * True for a label that names a lot rather than a building.
 *
 * Being inside a car park is not enough on its own: Main Gym, Practice Gym and
 * Pool all sit on one, because the building is drawn over the surface. What
 * separates them is that those three are inside a footprint or inside the pool,
 * and the five real lot names — Myrtle, Myrtle East, Myrtle West, Stadium,
 * Staff Parking — are inside neither. No distance threshold is involved.
 */
const namesALot = (cx, cy, coords) => {
  const p = svgFromPdf([cx, cy]);
  if (!carParks.some((ring) => pointInRing(p, ring))) return false;
  if (poolShape.some((ring) => pointInRing(p, ring))) return false;
  return !inFootprint(coords);
};

const features = [];
const suppressed = [];
for (const block of blocks) {
  const text = joinBlock(block);
  if (SUPPRESS.has(text)) { suppressed.push(text); continue; }

  const cx = block.reduce((s, l) => s + l.cx, 0) / block.length;
  const cy = (block[0].y0 + block.at(-1).y1) / 2;
  // Upper-case is how the sheet marks an area rather than a building: STADIUM,
  // TENNIS COURTS, BASEBALL FIELD. They want letterspacing, not a halo.
  const area = text === text.toUpperCase() && /[A-Z]{3}/.test(text);

  features.push({
    type: 'Feature',
    properties: {
      text,
      kind: area ? 'area'
        : onPlate(cx, cy) ? 'plate'
        : namesALot(cx, cy, projectPdf([cx, cy])) ? 'parking'
        : 'building',
      // The PDF's own line height, so relative emphasis survives the transfer.
      pt: Number(block[0].h.toFixed(1)),
      lines: block.length,
    },
    geometry: { type: 'Point', coordinates: projectPdf([cx, cy]) },
  });
}

// --- name the buildings the printed sheet left bare ------------------------
//
// The PDF labels 25 buildings and 9 more on plates, and where it does, its
// placement is better than anything computed: "Fine and Applied Arts" is one
// 4,960 m2 footprint carrying three printed labels — Music, Theatre and the
// plate — each set inside the wing it names. Moving those to a computed centre
// would destroy that, so they are left exactly where the cartographer put them.
//
// What is added here is only the gap: footprints that carry a campus name and no
// printed label anywhere near them. The Bookstore, ITC and the Science
// Success Center are real buildings that the sheet simply does not name.

const M_PER_LAT = 111320;
const M_PER_LON = 111320 * Math.cos((38.6547 * Math.PI) / 180);
const toMetres = (ring) => ring.map(([lon, lat]) => [lon * M_PER_LON, lat * M_PER_LAT]);
const metresBetween = ([ax, ay], [bx, by]) =>
  Math.hypot((bx - ax) * M_PER_LON, (by - ay) * M_PER_LAT);

/** Distance from a point to a ring in metres, positive inside. */
function signedDistance([px, py], ring) {
  let nearest = Infinity;
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    nearest = Math.min(nearest, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return inside ? nearest : -nearest;
}

/**
 * The point inside a footprint furthest from any wall, and how far that is.
 *
 * A centroid is the obvious choice and the wrong one: my campus has L-shaped and
 * U-shaped buildings whose centroid falls outside the walls, which would set
 * the name on the lawn next to the building it names. This is the pole of
 * inaccessibility, and its radius is also the useful part — it measures how
 * much room the building actually has for type, which is what sizes the label.
 *
 * Coarse grid first, then hill-climb with a halving step. Deterministic.
 */
function poleOfInaccessibility(lonLatRing, { grid = 24, precision = 0.4 } = {}) {
  const ring = toMetres(lonLatRing);
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return null;

  let best = null;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const x = x0 + ((i + 0.5) * (x1 - x0)) / grid;
      const y = y0 + ((j + 0.5) * (y1 - y0)) / grid;
      const d = signedDistance([x, y], ring);
      if (!best || d > best.d) best = { x, y, d };
    }
  }
  let step = Math.max(x1 - x0, y1 - y0) / grid;
  while (step > precision) {
    let moved = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = best.x + dx * step;
      const y = best.y + dy * step;
      const d = signedDistance([x, y], ring);
      if (d > best.d) { best = { x, y, d }; moved = true; }
    }
    if (!moved) step /= 2;
  }
  return { coordinates: [best.x / M_PER_LON, best.y / M_PER_LAT], radius: best.d };
}

/**
 * my campus's database names, reduced to something a map can carry.
 *
 * Two mechanical rules cover most of it — strip a room reference, and turn an
 * "X - ABBR" pair into "X (ABBR)" — and the rest are one-off inconsistencies in
 * my campus's own strings, listed rather than parsed. Guessing a general rule from
 * four irregular examples would be worse than naming them.
 */
const RENAME = new Map([
  ['Bookstore - College Store', 'Bookstore'],
  ['Police - College', 'College Police'],
  ['STEM, Science Division - Science, Room 440', 'Science'],
  ['Printing Services Sign Shop', 'Printing Services'],
  ['Gym - MAIN and PRACT', 'Gym'],
]);

function tidyName(raw) {
  if (RENAME.has(raw)) return RENAME.get(raw);
  let name = raw
    .replace(/\s*\((?:Rm|Room)[^)]*\)/i, '')
    .replace(/,?\s*Room\s+\d+\w*/i, '')
    .replace(/\s+Division$/i, '')
    .trim();
  // "Learning Resource Center - LRC" -> "Learning Resource Center (LRC)", but
  // only when the tail really is an abbreviation of the head.
  const pair = /^(.*?)\s+-\s+([A-Z][A-Za-z0-9 -]{0,14})$/.exec(name);
  if (pair) {
    const [, head, tail] = pair;
    const initials = head.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join('');
    const short = tail.replace(/[^A-Za-z]/g, '');
    if (short.toUpperCase() === initials.toUpperCase()) name = `${head} (${tail})`;
    else if (tail.length < head.length) name = head;
    else name = tail;
  }
  return name;
}

/**
 * Loose duplicate check, in both directions: the printed "Gallery" covers my campus's
 * "Kaneko Art Gallery", and the printed "Environmental Resources (ER)" covers
 * my campus's shorter "Environmental Resources". Either being a subset of the other
 * means the map would say the same thing twice.
 */
const STOPWORDS = new Set(['and', 'the', 'of', 'at']);
const words = (text) =>
  new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !STOPWORDS.has(w)));
const subset = (a, b) => a.size > 0 && [...a].every((w) => b.has(w));
const alreadySaid = (name) => {
  const candidate = words(name);
  return features.some((f) => {
    const existing = words(f.properties.text);
    return subset(existing, candidate) || subset(candidate, existing);
  });
};

/**
 * Which footprints the printed sheet already names.
 *
 * Distance is the wrong test and was tried: at any radius wide enough to catch
 * a plate set beside its building, Howard Hall and Raef Hall — two separate
 * halls a few metres apart — each suppress the other. Containment is exact, so
 * that is the rule, with one allowance: a plate is deliberately set *outside*
 * its building with a leader line, and the nine on this sheet sit 8 to 26 m
 * away, so a plate claims its nearest footprint instead.
 */
const PLATE_REACH_M = 40;

const poles = new Map(footprints.map((f) => [f, poleOfInaccessibility(f.geometry.coordinates[0])]));

const claimed = new Set();
const plateLabels = [];
for (const f of features) {
  const { kind } = f.properties;
  if (kind === 'area' || kind === 'parking') continue;
  if (kind === 'plate') plateLabels.push(f);
  const host = inFootprint(f.geometry.coordinates);
  if (host) claimed.add(host);
}

/** A plate names the whole complex it points at, not one footprint of it. */
const plateCovers = (member) => {
  const pole = poles.get(member);
  return pole !== null && plateLabels.some((f) =>
    metresBetween(f.geometry.coordinates, pole.coordinates) < PLATE_REACH_M);
};

const groups = new Map();
for (const footprint of footprints) {
  if (!footprint.properties.name) continue;
  const name = tidyName(footprint.properties.name);
  if (!groups.has(name)) groups.set(name, []);
  groups.get(name).push(footprint);
}

const added = [];
const skipped = [];
for (const [name, members] of groups) {
  // One label per name, on the largest member. Health Education Complex is nine
  // separate footprints; printing the name on each is nine copies of it.
  const host = members.reduce((a, b) => (a.properties.area_m2 >= b.properties.area_m2 ? a : b));
  const pole = poleOfInaccessibility(host.geometry.coordinates[0]);
  if (!pole) { skipped.push(`${name} (no interior point)`); continue; }

  if (members.some((m) => claimed.has(m) || plateCovers(m))) {
    skipped.push(`${name} (printed)`);
    continue;
  }
  if (alreadySaid(name)) { skipped.push(`${name} (already said)`); continue; }

  // The radius is the building's room for type. The printed labels run 6.6 to
  // 13.1 pt over footprints of 300 to 8,600 m2, and this keeps the additions
  // inside that range rather than inventing a new scale.
  const pt = Math.min(11, Math.max(6, Math.round(pole.radius * 0.5 * 10) / 10));
  added.push({
    type: 'Feature',
    properties: {
      text: name,
      kind: 'building',
      pt,
      lines: 1,
      // Printed labels keep the sheet's own line breaks at the layer's default
      // width; these have none to reproduce, so they wrap to the building.
      maxWidth: Math.min(12, Math.max(5, Math.round(pole.radius / 2.2))),
      source: 'arc',
      area_m2: Math.round(host.properties.area_m2),
    },
    geometry: { type: 'Point', coordinates: pole.coordinates.map((n) => +n.toFixed(7)) },
  });
}
features.push(...added);

features.sort((a, b) => a.properties.text.localeCompare(b.properties.text));
writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const byKind = new Map();
for (const f of features) {
  byKind.set(f.properties.kind, (byKind.get(f.properties.kind) ?? 0) + 1);
}
console.log(`[build-labels] ${lines.length} text lines -> ${candidates.length} candidates -> ${clean.length} clean -> ${features.length} labels`);
for (const [kind, n] of [...byKind].sort()) console.log(`[build-labels]   ${kind.padEnd(9)} ${n}`);
console.log(`[build-labels] suppressed: ${suppressed.join(', ') || 'none'}`);
console.log(`[build-labels] added ${added.length} from my campus names, skipped ${skipped.length}`);
for (const a of added) console.log(`[build-labels]   + ${a.properties.pt}pt  ${a.properties.text} (${a.properties.area_m2} m2)`);
for (const sk of skipped) console.log(`[build-labels]   - ${sk}`);
console.log(`[build-labels] -> src/labels.json`);
for (const f of features) {
  console.log(`[build-labels]   ${f.properties.kind.padEnd(9)} ${String(f.properties.pt).padStart(4)}pt  ${f.properties.text}`);
}
