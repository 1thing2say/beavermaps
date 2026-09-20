/**
 * Extract campus building footprints from the archived my campus basemap SVG.
 *
 * The SVG carries no semantic layer names — every group id is a UUID and there
 * are no <text> elements, because the labels are outlined paths. Buildings are
 * therefore identified by how they are drawn. Three facts about the file, each
 * checked by rendering the classification back over the map and looking at it:
 *
 *   1. Buildings are the #fff shapes. The ground is #c7c8ca, landscaping is
 *      #577f3d / #bcd37e, parking lots are #a9afb7, label plates are #4e4e4f,
 *      the pool is #37afcb. Verified by testing which fill sits under each of
 *      the 83 hand-authored Touchable regions: 53 landed on #fff, more than
 *      every other fill combined.
 *   2. Most #fff shapes are not buildings — 1957 of them exist, with a median
 *      area of 7.8 m², because outlined label glyphs, parking stall stripes and
 *      UI chips are also white. Area does most of the separating.
 *   3. Between 60 and 400 m² the two mix. Real structures there (the portables
 *      by Technical Education West, the ERI outbuildings, stadium bleachers,
 *      dugouts) are rects and simple polygons; decoration is curved paths with
 *      many vertices — outlined letters, and the four "P" parking pins, which
 *      are nested rounded squares of exactly 15.0x15.0 m and 17.3x17.3 m.
 *      Hence GLYPH_VERTS. The rule has to be gated by area because Arts &
 *      Sciences, the Welcome and Support Center and the ITC are genuinely
 *      curvy buildings; they sit at 630 m² and up, against 284 m² for the
 *      largest chip, so KEEP_ALWAYS_M2 is placed inside that gap.
 *
 * Names come from the Touchable table, whose regions are bound to LocationIDs;
 * a footprint is named when a touchable's centroid falls inside it.
 *
 * Source lives under campus-data/, which is gitignored — see
 * campus-data/MANIFEST.md. Output src/buildings.json is committed.
 *
 *   node scripts/build-buildings.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, M2_PER_UNIT2 } from './projection.mjs';
import {
  nums,
  parsePath,
  parseTransform,
  applyMat,
  shoelace,
  ringArea,
  centroid,
  pointInRing,
  minSpanMetres,
  readShapes as readAllShapes,
} from './svg-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'campus-data/wayfind/api');
const TARGET = path.join(root, 'src/buildings.json');

const BUILDING_FILL = '#fff';
// The pool, which is the one structure on this sheet the cartographer did not
// draw in white — it is drawn as water, because it is. It is a structure all
// the same: my campus hand-authored a Touchable region over it, bound to their own
// "Pool" location, and the printed sheet sets "Pool" on it in the same type it
// uses for the Gym next door. Excluding it on fill alone left a labelled
// building on this campus that could not be tapped, carded or flown over.
// Exactly one shape in the file carries this fill.
const POOL_FILL = '#37afcb';
// Not filtered on — recorded because it is the other half of the convention
// DECOR_STROKE is read against, and the next person to touch this needs both.
const _BUILDING_STROKE = '#231f20'; // every real footprint is outlined in this
const DECOR_STROKE = '#a6a6a6';    // the three street-label plates down the west edge
const KEEP_ALWAYS_M2 = 400; // above this, every #fff shape was a building
const KEEP_MAYBE_M2 = 60;   // below this, everything was a glyph or a stall stripe
const MIN_SPAN_M = 3.5;     // kills parking stall stripes, which are ~0.5 m wide
const GLYPH_VERTS = 40;     // outlined letters flatten to far more points than a footprint

// No height data exists anywhere in their system, so these are placeholders
// chosen to look right under a pitched camera — not measurements.
const HEIGHT_SMALL_M = 4;
const HEIGHT_DEFAULT_M = 9;
const SMALL_BUILDING_M2 = 200;

// --- read the SVG -----------------------------------------------------------

/**
 * The shapes that are candidate footprints: the white ones, and the pool.
 *
 * <polyline> never reaches here: readShapes excludes it by type, because it is
 * an open figure used only for stroked line work, and the file's one white
 * polyline is a zigzag path marking that SVG would still fill.
 */
function readCandidates(svg) {
  return readAllShapes(svg).filter(({ attrs }) => {
    if (attrs.fill !== BUILDING_FILL && attrs.fill !== POOL_FILL) return false;
    // Rounded corners mean a UI chip, not a footprint: the "P" parking pins and
    // the BUS/SOS edge markers are white rects with rx/ry, and the markers are
    // large enough (381 m²) to clear the area test on their own. No building on
    // this sheet is drawn with a corner radius.
    if (attrs.rx !== undefined || attrs.ry !== undefined) return false;
    return attrs.stroke !== DECOR_STROKE;
  });
}

/** Rebuild a Touchable row's ring in SVG space. */
function touchableRing({ Type, Attribute: a }) {
  let ring;
  if (Type === 'rect') {
    ring = [[a.X, a.Y], [a.X + a.Width, a.Y], [a.X + a.Width, a.Y + a.Height], [a.X, a.Y + a.Height], [a.X, a.Y]];
  } else if (Type === 'polygon' || Type === 'polyline') {
    const v = nums(a.Points);
    ring = [];
    for (let i = 0; i + 1 < v.length; i += 2) ring.push([v[i], v[i + 1]]);
    if (ring.length) ring.push(ring[0]);
  } else if (Type === 'path') {
    const rs = parsePath(a.D ?? '');
    ring = rs.length ? rs.reduce((b, r) => (ringArea(r) > ringArea(b) ? r : b)) : null;
  } else return null;
  if (!ring || ring.length < 4) return null;
  return applyMat(parseTransform(a.Transform), ring);
}

// --- build ------------------------------------------------------------------

const svg = readFileSync(path.join(DATA, 'ActiveMap.svg'), 'utf8');
const touchables = JSON.parse(readFileSync(path.join(DATA, 'Touchable.json'), 'utf8'));
const locations = new Map(
  JSON.parse(readFileSync(path.join(DATA, 'locations.json'), 'utf8')).map((l) => [l.ID, l]),
);

const shapes = readCandidates(svg);
const buildings = [];
for (const s of shapes) {
  const m2 = ringArea(s.ring) * M2_PER_UNIT2;
  let keep;
  if (m2 >= KEEP_ALWAYS_M2) keep = true;
  else if (m2 >= KEEP_MAYBE_M2) {
    keep = minSpanMetres(s.ring) >= MIN_SPAN_M
      && !(s.curvy && s.ring.length > GLYPH_VERTS);
  } else keep = false;
  if (keep) buildings.push({ ...s, m2, c: centroid(s.ring) });
}

// Name a footprint when a hand-authored touchable region sits inside it. Where
// footprints nest, the smallest container wins: taking the first match in
// document order instead makes the assignment depend on paint order, so it
// silently moves to a different polygon whenever the kept set changes.
const regions = touchables
  .map((t) => ({ ring: touchableRing(t), name: locations.get(t.LocationID)?.Name }))
  .filter((r) => r.ring && r.name)
  .map((r) => ({ ...r, c: centroid(r.ring), m2: ringArea(r.ring) * M2_PER_UNIT2 }));

const named = new Map();
for (const region of regions) {
  let hit = -1;
  let best = Infinity;
  buildings.forEach((b, i) => {
    if (b.m2 < best && pointInRing(region.c, b.ring)) {
      best = b.m2;
      hit = i;
    }
  });
  if (hit >= 0 && !named.has(hit)) named.set(hit, region.name);
}

// ...and the other way round, for a touchable drawn around a CLUSTER.
//
// The rule above assumes a region is a patch on one building, and for 32 of
// my campus's 44 named regions it is. Of the twelve whose centroid lands in nothing,
// eleven are car parks, the stadium, the tennis courts and a hall that is not
// on this sheet any more — nothing a footprint rule should be finding. The
// twelfth is Technical Education West, which is twelve portables with a single
// polygon thrown around all of them: the centroid falls in the alley between
// two, so the whole building came out unnamed — no directory row, no card, no
// flyover, for a plate that is printed on my campus's own sheet.
//
// So a footprint whose own centroid falls inside a region takes that region's
// name. Smallest containing region wins, for the same reason as above.
//
// This is the WEAKER question and only ever runs on what is still unnamed,
// because a region drawn around several buildings would otherwise rename ones
// the forward pass had already got right. Measured over the whole file it
// changes nothing else: it agrees with the forward pass on all 59 footprints
// they both reach, contradicts it on none, and adds exactly the twelve
// portables of TEW.
buildings.forEach((b, i) => {
  if (named.has(i)) return;
  let hit = null;
  for (const region of regions) {
    if (!pointInRing(b.c, region.ring)) continue;
    if (!hit || region.m2 < hit.m2) hit = region;
  }
  if (hit) named.set(i, hit.name);
});

const features = buildings.map((b, i) => {
  let ring = b.ring.map(project);
  // GeoJSON wants exterior rings counter-clockwise. Projecting flips the sign,
  // because SVG y grows downward and latitude grows upward.
  if (shoelace(ring) < 0) ring = ring.reverse();
  return {
    type: 'Feature',
    properties: {
      name: named.get(i) ?? null,
      // Placeholder, not survey data — see HEIGHT_* above. Except for the
      // pool, where zero is the measurement rather than a way of hiding it:
      // src/landcover.json already draws the water, and standing a slab of
      // building colour up over it would cover the thing this footprint is
      // for. src/main.js filters the extrusion to what has a height, so the
      // pool stays a footprint — tappable, cardable, flyable — with no mass.
      height: b.attrs.fill === POOL_FILL ? 0
        : b.m2 < SMALL_BUILDING_M2 ? HEIGHT_SMALL_M
        : HEIGHT_DEFAULT_M,
      area_m2: Math.round(b.m2),
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
});

writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const total = features.reduce((s, f) => s + f.properties.area_m2, 0);
console.log(`[build-buildings] ${shapes.length} candidate shapes -> ${features.length} footprints`);
console.log(`[build-buildings] named ${named.size}, total footprint area ${total.toLocaleString()} m2`);
console.log(`[build-buildings] -> src/buildings.json`);
