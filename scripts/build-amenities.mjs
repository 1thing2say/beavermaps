/**
 * Extract campus amenity points — defibrillators, emergency phones, restrooms,
 * bike racks, motorcycle bays, permit machines, vending, drop-offs.
 *
 * Two sources, because neither alone is complete.
 *
 * ActiveMap.svg draws the icons but has no legend and no <text> at all, so on
 * its own it is a page of unlabelled coloured shapes. campus-data/wayfind/
 * external/campus-map.pdf is the same drawing *with* its key, and that is the only
 * thing it is used for here: it says which fill means what. Nothing is read out
 * of the PDF at build time and poppler is not a dependency of this script.
 *
 * That the two are the same drawing is measured, not assumed. Fitting the PDF's
 * page space to src/buildings.json by iterated mutual-nearest over 49 building
 * centroids lands at a median residual of 0.07 m under plain least squares —
 * 90% of them inside 3 cm. A per-axis scale+offset therefore maps one onto the
 * other exactly, which is what licenses reading the legend off one file and
 * applying it to the other.
 *
 * The classification it yields, each count confirmed independently in both
 * files:
 *
 *   #ea6555  4.67 x 4.67   defibrillator            6
 *   #0093bd  2.17 x 6.77   emergency telephone     14   (SOS star's upright)
 *   #f5e7d7  5.34 x 6.91   daily permit machine    10
 *   #231f20  5.39 x 5.78   bike rack               14
 *   #231f20  4.01 x 2.60   motorcycle parking       6
 *   <circle> #231f20 r2.57 all-gender restroom      6
 *
 * The restrooms are <circle> elements, which is why svg-geometry exports a
 * separate reader for them — readShapes covers rect/polygon/path only.
 *
 * locations.json supplies what the artwork does not draw: vending machines, and
 * the extra restrooms and phones my campus knows about but did not put a symbol on
 * (9 restrooms listed against 6 drawn, 15 phones against 14). Those are emitted
 * only where no icon of the same class is already within MERGE_M, so nothing is
 * marked twice. Every feature records which source it came from.
 *
 * One deliberate inconsistency: icon positions are NOT shifted by
 * src/path-corrections.json and node positions ARE. The corrections are a
 * per-node fix for my campus having drawn individual *paths* off; the artwork was
 * already right and build-buildings leaves it alone too. Each source is
 * therefore used in the frame it is correct in. The two agree to 0.9–6.7 m
 * where they overlap, measured against all six defibrillators.
 *
 * Source lives under campus-data/, which is gitignored — see
 * campus-data/MANIFEST.md. Output src/amenities.json is committed.
 *
 *   node scripts/build-amenities.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, M_PER_UNIT_X, M_PER_UNIT_Y } from './projection.mjs';
import { readShapes, readCircles, bbox, bboxCentre } from './svg-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'campus-data/wayfind/api');
const TARGET = path.join(root, 'src/amenities.json');
const CORRECTIONS = path.join(root, 'src/path-corrections.json');

/** Bbox tolerance when matching an icon, in SVG units (~1.65 m each). */
const SIZE_TOL = 0.25;
/**
 * A listed node this close to a drawn icon of the same class is that icon.
 *
 * Nothing sits near this threshold, so the value is not doing delicate work:
 * every one of the 30 listed nodes across the three overlapping classes lands
 * 0.8–13.2 m from its icon, and the next candidate is hundreds of metres away.
 * Anything from about 15 to 40 gives the same answer. The listed sets are
 * larger than the drawn ones (9 restrooms to 6 icons, 15 phones to 14) because
 * one symbol can stand for several routing destinations, e.g. the same block of
 * restrooms reachable from two floors.
 */
const MERGE_M = 25;

// Icons identified by fill and bounding-box size. Sizes are measured off the
// file rather than authored, so they carry the flattener's own rounding; the
// tolerance above is what absorbs it. Every one of these is an exact-count
// match against the PDF, which is the check that they are not coincidences.
const ICONS = [
  { kind: 'defibrillator', label: 'Defibrillator', fill: '#ea6555', w: 4.67, h: 4.67, listed: 'Defibrillator' },
  { kind: 'emergency_phone', label: 'Emergency telephone', fill: '#0093bd', w: 2.17, h: 6.77, listed: 'Emergency telephones' },
  { kind: 'parking_permit', label: 'Daily parking permit machine', fill: '#f5e7d7', w: 5.34, h: 6.91 },
  { kind: 'bike_rack', label: 'Bike rack', fill: '#231f20', w: 5.39, h: 5.78 },
  { kind: 'motorcycle_parking', label: 'Motorcycle parking', fill: '#231f20', w: 4.01, h: 2.60 },
];

const CIRCLE_ICONS = [
  { kind: 'restroom', label: 'All-gender restroom', fill: '#231f20', r: 2.57, listed: 'All Gender Restroom' },
];

// Real things that the drawing carries no symbol for, taken from my campus's own
// destination table and positioned by the routing nodes bound to them.
const LISTED_ONLY = [
  { kind: 'drink_vending', label: 'Drink vending machine', listed: 'Drink Vending Machine' },
  { kind: 'food_vending', label: 'Food vending machine', listed: 'Food Vending Machine' },
  { kind: 'health_centre', label: 'Health & Wellness Center', listed: 'Health and Wellness Center' },
  { kind: 'drop_off', label: 'Student drop-off', listed: 'Student Drop-off and Pick-up North' },
  { kind: 'drop_off', label: 'Student drop-off', listed: 'Student Drop-off and Pick-up South' },
];

// --- sources ----------------------------------------------------------------

const svg = readFileSync(path.join(DATA, 'ActiveMap.svg'), 'utf8');
const { value } = JSON.parse(readFileSync(path.join(DATA, 'Batch.json'), 'utf8'));
const corrections = existsSync(CORRECTIONS)
  ? JSON.parse(readFileSync(CORRECTIONS, 'utf8')).corrections
  : {};

const nodes = new Map();
for (const node of value.Nodes) {
  if (!node.Is_Active) continue;
  const [lon, lat] = project([node.Pos_X, node.Pos_Y]);
  const delta = corrections[node.ID];
  nodes.set(node.ID, delta ? [lon + delta[0], lat + delta[1]] : [lon, lat]);
}
const listedByName = new Map(value.Locations.map((l) => [l.Name, l]));

const metres = ([aLon, aLat], [bLon, bLat]) => Math.hypot(
  (aLon - bLon) * 111320 * Math.cos((aLat * Math.PI) / 180),
  (aLat - bLat) * 111320,
);

const round = ([lon, lat]) => [Number(lon.toFixed(7)), Number(lat.toFixed(7))];

// --- collect ----------------------------------------------------------------

const shapes = readShapes(svg);
const circles = readCircles(svg);
const features = [];
const counts = new Map();

function emit(kind, label, coords, source) {
  counts.set(`${kind}:${source}`, (counts.get(`${kind}:${source}`) ?? 0) + 1);
  features.push({
    type: 'Feature',
    properties: { kind, label, source },
    geometry: { type: 'Point', coordinates: round(coords) },
  });
}

/** Icon centres for one class, in SVG units. */
function iconCentres({ fill, w, h }) {
  const out = [];
  for (const s of shapes) {
    if (s.attrs.fill !== fill) continue;
    const [x0, y0, x1, y1] = bbox(s.ring);
    if (Math.abs(x1 - x0 - w) > SIZE_TOL || Math.abs(y1 - y0 - h) > SIZE_TOL) continue;
    out.push(bboxCentre(s.ring));
  }
  return out;
}

const drawn = new Map(); // kind -> [lon, lat][]

for (const spec of ICONS) {
  const pts = iconCentres(spec).map(project);
  drawn.set(spec.kind, pts);
  for (const p of pts) emit(spec.kind, spec.label, p, 'artwork');
}

for (const spec of CIRCLE_ICONS) {
  const pts = circles
    .filter((c) => c.attrs.fill === spec.fill
      && Math.abs(c.rx - spec.r) < 0.2 && Math.abs(c.ry - spec.r) < 0.2)
    .map((c) => project(c.centre));
  drawn.set(spec.kind, pts);
  for (const p of pts) emit(spec.kind, spec.label, p, 'artwork');
}

// Listed nodes that no drawn icon of the same class already covers.
for (const spec of [...ICONS, ...CIRCLE_ICONS]) {
  if (!spec.listed) continue;
  const near = drawn.get(spec.kind) ?? [];
  for (const id of listedByName.get(spec.listed)?.Node_IDs ?? []) {
    const p = nodes.get(id);
    if (!p || near.some((q) => metres(p, q) <= MERGE_M)) continue;
    emit(spec.kind, spec.label, p, 'locations');
  }
}

for (const spec of LISTED_ONLY) {
  for (const id of listedByName.get(spec.listed)?.Node_IDs ?? []) {
    const p = nodes.get(id);
    if (p) emit(spec.kind, spec.label, p, 'locations');
  }
}

writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const byKind = new Map();
for (const f of features) {
  byKind.set(f.properties.kind, (byKind.get(f.properties.kind) ?? 0) + 1);
}
console.log(`[build-amenities] ${features.length} points -> src/amenities.json`);
for (const [kind, n] of [...byKind].sort()) {
  const art = counts.get(`${kind}:artwork`) ?? 0;
  const loc = counts.get(`${kind}:locations`) ?? 0;
  console.log(`[build-amenities]   ${kind.padEnd(19)} ${String(n).padStart(3)}  (artwork ${art}, listed ${loc})`);
}
console.log(`[build-amenities] scale ${M_PER_UNIT_X.toFixed(4)} x ${M_PER_UNIT_Y.toFixed(4)} m per SVG unit`);
