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
 * Both sources are in one frame. The drawn icons and the listed nodes come out
 * of the same SVG coordinate space through scripts/projection.mjs and nothing
 * is nudged afterwards, so they are directly comparable — which is what lets
 * MERGE_M mean anything. They agree to 0.9–6.7 m where they overlap, measured
 * against all six defibrillators; the residual is not error but the difference
 * between where a device is drawn and where you can walk to it.
 *
 * This used to be a deliberate inconsistency — node positions were shifted by
 * src/path-corrections.json and icons were not. That file is gone, and so is
 * the graph it corrected; see scripts/build-walk-network.mjs.
 *
 * Source lives under campus-data/, which is gitignored — see
 * campus-data/MANIFEST.md. Output src/amenities.json is committed.
 *
 *   node scripts/build-amenities.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, M_PER_UNIT_X, M_PER_UNIT_Y } from './projection.mjs';
import { readShapes, readCircles, readDrawing, bbox, bboxCentre } from './svg-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'campus-data/wayfind/api');
const TARGET = path.join(root, 'src/amenities.json');

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
  // The same bicycle-and-P sign set about 10% smaller, once, by the Learning
  // Resource Center. It is a second entry rather than a wider tolerance on the
  // one above because 0.55 units of slack is twice what any other icon here
  // needs, and widening it would start matching shapes that are not icons.
  { kind: 'bike_rack', label: 'Bike rack', fill: '#231f20', w: 4.85, h: 5.27 },
  { kind: 'motorcycle_parking', label: 'Motorcycle parking', fill: '#231f20', w: 4.01, h: 2.60 },
];

const CIRCLE_ICONS = [
  { kind: 'restroom', label: 'All-gender restroom', fill: '#231f20', r: 2.57, listed: 'All Gender Restroom' },
];

/**
 * Symbols the sheet draws as a cluster of parts rather than as one shape.
 *
 * The fill-and-size matching above cannot reach these: no single element *is*
 * the symbol. A bus stop here is a sign plate plus its route numerals, 19
 * elements for 3 stops. What identifies them is the artwork's own layer — the
 * same classifier build-basemap.mjs uses, where layer 14 is commented "3 sign
 * plates and their numerals" — so the only work left is collapsing each cluster
 * to a point.
 *
 * `expect` is not decoration. This is the one spec whose count is not checked
 * by a fill signature, so an SVG revision that regroups the layers would
 * otherwise quietly emit some other number of stops.
 *
 * my campus's directory names three bus stops and binds none of them to a node, so
 * they arrive here geometryless and the names have to be attached by position.
 * `pick` does that from the direction word each name already carries, and the
 * assignment is total: the northernmost, westernmost and southernmost clusters
 * are three different clusters, which the build asserts.
 */
const CLUSTERED = [
  {
    kind: 'bus_stop',
    label: 'Bus stop',
    layer: 14,
    gap: 30,
    expect: 3,
    pick: {
      'Bus 1 Heading North': (pts) => pts.reduce((a, b) => (b[1] > a[1] ? b : a)),
      'Bus 1 and 82 Heading West': (pts) => pts.reduce((a, b) => (b[0] < a[0] ? b : a)),
      'Bus 82 Heading South': (pts) => pts.reduce((a, b) => (b[1] < a[1] ? b : a)),
    },
  },
];

/**
 * The P badge painted in each car park.
 *
 * The ICONS table above cannot reach these: the sheet draws the badge at four
 * different sizes (10.47, 6.28, 5.33 and 5.26 units) and rotates one of them
 * 90°, so there is no size to match on. What every one of them *is* is a plate
 * that is exactly square, which nothing else in the layer is — the ten permit
 * machine bodies beside them are 5.34 x 6.91, and the Student Drop-Off car is
 * 7.66 x 5.03.
 *
 * `tol` is 2% rather than the 10% the rest of this file uses because three
 * shapes near the Myrtle lots are 5.95 x 5.39, which squeaks inside 10% and is
 * not a badge. The real plates are square to the last decimal the flattener
 * emits, so tightening costs nothing and excludes those cleanly.
 */
const SQUARE_PLATES = [
  { kind: 'parking_badge', label: 'Parking', layer: 12, minSide: 5, tol: 0.02, expect: 8 },
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

const nodes = new Map();
for (const node of value.Nodes) {
  if (!node.Is_Active) continue;
  nodes.set(node.ID, project([node.Pos_X, node.Pos_Y]));
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

/** Append rather than replace: one kind may be matched by more than one spec. */
const remember = (kind, pts) => drawn.set(kind, [...(drawn.get(kind) ?? []), ...pts]);

for (const spec of ICONS) {
  const pts = iconCentres(spec).map(project);
  remember(spec.kind, pts);
  for (const p of pts) emit(spec.kind, spec.label, p, 'artwork');
}

for (const spec of CIRCLE_ICONS) {
  const pts = circles
    .filter((c) => c.attrs.fill === spec.fill
      && Math.abs(c.rx - spec.r) < 0.2 && Math.abs(c.ry - spec.r) < 0.2)
    .map((c) => project(c.centre));
  remember(spec.kind, pts);
  for (const p of pts) emit(spec.kind, spec.label, p, 'artwork');
}

/** One drawable element's bounding box, in SVG units. */
function size(el) {
  const [x0, y0, x1, y1] = bbox(el.subpaths.flatMap((s) => s.pts));
  return [x1 - x0, y1 - y0];
}

/** One point per symbol: cluster a layer's parts, then average each cluster. */
function clusterCentres(elements, { layer, gap }) {
  const pts = elements
    .filter((el) => el.layer === layer)
    .map((el) => project(bboxCentre(el.subpaths.flatMap((s) => s.pts))));

  const groups = [];
  for (const p of pts) {
    const group = groups.find((g) => g.some((q) => metres(p, q) <= gap));
    if (group) group.push(p); else groups.push([p]);
  }
  return groups.map((g) => [
    g.reduce((sum, q) => sum + q[0], 0) / g.length,
    g.reduce((sum, q) => sum + q[1], 0) / g.length,
  ]);
}

const drawing = readDrawing(svg);

for (const spec of SQUARE_PLATES) {
  const pts = [];
  for (const el of drawing) {
    if (el.layer !== spec.layer) continue;
    const [w, h] = size(el);
    if (Math.min(w, h) < spec.minSide) continue;
    if (Math.abs(w - h) > spec.tol * Math.max(w, h)) continue;
    pts.push(project(bboxCentre(el.subpaths.flatMap((s) => s.pts))));
  }
  if (pts.length !== spec.expect) {
    throw new Error(
      `[build-amenities] ${spec.kind}: layer ${spec.layer} has ${pts.length} square plates, `
      + `expected ${spec.expect} — the SVG's artwork has changed`,
    );
  }
  remember(spec.kind, pts);
  for (const p of pts) emit(spec.kind, spec.label, p, 'artwork');
}

for (const spec of CLUSTERED) {
  const pts = clusterCentres(drawing, spec);
  if (pts.length !== spec.expect) {
    throw new Error(
      `[build-amenities] ${spec.kind}: layer ${spec.layer} gave ${pts.length} clusters, `
      + `expected ${spec.expect} — the SVG's layer grouping has changed`,
    );
  }
  remember(spec.kind, pts);

  const named = new Map();
  for (const [name, pick] of Object.entries(spec.pick ?? {})) named.set(pick(pts), name);
  if (spec.pick && named.size !== pts.length) {
    throw new Error(
      `[build-amenities] ${spec.kind}: ${named.size} of ${pts.length} named — two directions `
      + 'picked the same cluster, so the names cannot be assigned by position',
    );
  }
  for (const p of pts) emit(spec.kind, named.get(p) ?? spec.label, p, 'artwork');
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
