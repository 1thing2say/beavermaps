/**
 * Translate my campus's whole printed campus map into GeoJSON.
 *
 * This supersedes the piecemeal approach. build-buildings, build-landcover and
 * build-amenities each go to the same sheet and take one class of thing off it;
 * between them they keep 761 of the 3,220 drawable elements, or 24%. The other
 * 76% is not junk. It is the parking-bay striping, the driveway and walkway
 * linework, the tree strips, the crossings, the icons and the label plates —
 * that is to say, most of what makes the printed map look like a map.
 *
 * DRAW ORDER IS DATA. A flat vector map is a painter's algorithm — trees over
 * lawn, bay striping over tarmac, buildings over everything. Property `i` is the
 * element's index in the document and sorting by it reproduces the sheet
 * exactly. Lose it and the campus renders inside out.
 *
 * ---------------------------------------------------------------------------
 * Classification comes from the artwork, not from colour
 *
 * The file has 24 top-level <g> elements, and they are the cartographer's own
 * Illustrator layer panel: one holds all 1,004 parking-bay stripes, one holds
 * all 509 trees, one holds every label. Classifying by layer is both simpler
 * and far more reliable than the colour rules the earlier scripts use, because
 * three fills carry more than one kind of thing (#fff is buildings AND bay
 * striping AND white label text; #231f20 is icons AND black label text).
 *
 * Each layer was identified by rendering it on its own and looking at it. Where
 * a layer is an amenity pictogram its element count cross-checks against
 * src/amenities.json, which was built independently from my campus's own node lists:
 * 6 defibrillators, 6 all-gender restrooms, 10 permit machines, 14 emergency
 * phones (3 shapes each), 3 bus-stop signs. Two layers are named `marker`
 * because their counts did NOT cross-check and guessing would be worse than
 * admitting it — layer 12 mixes the P badges with permit machines, and layer 23
 * mixes bike racks with motorcycle bays at 30 shapes against 20 known nodes.
 *
 * ---------------------------------------------------------------------------
 * Letterforms
 *
 * The sheet has no <text> element anywhere: every label is text converted to
 * outlines, ~935 of them. As polygons they are unusable — they cannot be
 * restyled, cannot be searched, and would double-print over the real labels
 * src/labels.json already carries as strings from the PDF's own text layer.
 * They are dropped, and that is the only deliberate omission here.
 *
 * Finding them by size alone does not work: display capitals reach 9.8 m and a
 * letter with a counter, like O, is a compound path whose rings must be
 * subtracted rather than summed. An earlier pass summed them, put "O" at 83 m2,
 * and promoted a chunk of STADIUM and TENNIS COURTS into buildings.
 *
 * So the text mask is ground truth instead of a threshold: pdftotext -bbox
 * gives the position of all 282 words on the PDF, which is the same drawing
 * (see projection.mjs for the measurement), and a shape whose centre lands in a
 * word box is a letterform. That alone over-reaches — it also catches 8 bay
 * stripes, 3 trees and a defibrillator that happen to sit under a label — so it
 * is applied only within the layers that carry text, and only to the fills that
 * carry it there. Layer plus word box agree; neither is trusted alone.
 *
 * Needs `pdftotext` on PATH (poppler-utils), like build-labels.mjs.
 *
 * Source lives under campus-data/, which is gitignored — see
 * campus-data/MANIFEST.md. Output src/basemap.json is committed.
 *
 *   node scripts/build-basemap.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  project, projectPdf, LEFT_LON, TOP_LAT, SVG_TO_LON, SVG_TO_LAT,
  M_PER_UNIT_X, M_PER_UNIT_Y,
} from './projection.mjs';
import { readDrawing, shoelace, bbox, pointInRing } from './svg-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'campus-data/wayfind/api');
const PDF = path.join(root, 'campus-data/wayfind/external/campus-map.pdf');
const TARGET = path.join(root, 'src/basemap.json');

/**
 * The 24 layers, in document order, each identified by rendering it alone.
 *
 *   kind   what its elements become
 *   keep   false for layers the app must never draw
 *   by     per-fill overrides, for the layers that hold more than one thing
 *   text   fills that are letterforms here; true means the whole layer is text
 */
const LAYERS = [
  /*  0 */ { kind: 'paper', keep: false },          // the sheet background rect
  /*  1 */ { kind: 'offsite_road' },                // public roads and signals off campus
  /*  2 */ { kind: 'lawn' },                        // 4 shapes, 519,000 m2 of open ground
  /*  3 */ { kind: 'parking' },                     // the car park surfaces
  /*  4 */ { kind: 'parking_stripe' },              // 1,004 bay dividers, 0.99 x 7.90 m each
  /*  5 */ { kind: 'sport' },                       // running track, courts, field markings
  /*  6 */ { kind: 'driveway' },                    // the vehicle roads through campus
  /*  7 */ { kind: 'label', keep: false, text: true }, // public street names, nothing else
  /*  8 */ { kind: 'walkway', text: ['#4d4d4f', '#fff'] }, // footpath network + path names
  /*  9 */ { kind: 'tree' },                        // 509 canopies
  // The stroke-only entries here are 27 evenly spaced 13.9 m rules, 24 of them
  // at STADIUM and 3 at Main Gym: the seating rows on the grandstands.
  /* 10 */ { kind: 'building', by: { '#37afcb': 'pool', '#8c8c8c': 'closed', none: 'bleachers' } },
  /* 11 */ { kind: 'shrub' },                       // small planting, median 6 m2
  /* 12 */ { kind: 'marker', text: ['#fff'] },      // P badges and permit machines, mixed
  /* 13 */ { kind: 'crossing' },                    // crossing and stair hatching
  /* 14 */ { kind: 'bus_stop' },                    // 3 sign plates and their numerals
  /* 15 */ { kind: 'emergency_phone' },             // 14 phones, 3 shapes each
  /* 16 */ { kind: 'defibrillator' },               // 6, matching amenities.json exactly
  /* 17 */ { kind: 'north_arrow' },                 // the compass rose
  /* 18 */ { kind: 'label_plate', keep: false, text: ['#fff', '#231f20'] },
  /* 19 */ { kind: 'restroom' },                    // 6 all-gender restrooms
  /* 20 */ { kind: 'driveway' },                    // one stray road stroke
  /* 21 */ { kind: 'permit_machine' },              // 10 daily permit machines
  /* 22 */ { kind: 'badge', keep: false },          // the two HOME BASE callouts
  /* 23 */ { kind: 'marker' },                      // bike racks and motorcycle bays, mixed
];

/** Word boxes overhang their glyphs slightly; ~1.6 m of slack absorbs it. */
const WORD_PAD = 1.0;
/** No letterform on this sheet is wider than this, and it stops a curved run's
 *  bounding box — which spans the whole curve — from swallowing real geometry. */
const GLYPH_MAX_SPAN_M = 20;

// --- the text mask ----------------------------------------------------------

const toSvgUnits = ([x, y]) => {
  const [lon, lat] = projectPdf([x, y]);
  return [(lon - LEFT_LON) / SVG_TO_LON, (TOP_LAT - lat) / SVG_TO_LAT];
};

function wordBoxes() {
  const xml = execFileSync('pdftotext', ['-bbox', PDF, '-'], { encoding: 'utf8' });
  const out = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">/g;
  for (const [, a, b, c, d] of xml.matchAll(re)) {
    const p0 = toSvgUnits([+a, +b]);
    const p1 = toSvgUnits([+c, +d]);
    out.push([
      Math.min(p0[0], p1[0]) - WORD_PAD, Math.min(p0[1], p1[1]) - WORD_PAD,
      Math.max(p0[0], p1[0]) + WORD_PAD, Math.max(p0[1], p1[1]) + WORD_PAD,
    ]);
  }
  return out;
}

const WORDS = wordBoxes();

const norm = (c) => {
  const v = (c ?? '').trim().toLowerCase();
  return v === '#ffffff' ? '#fff' : v;   // Illustrator writes both spellings
};

function isLetterform(el, layer) {
  if (!layer.text) return false;
  const fill = norm(el.attrs.fill);
  if (Array.isArray(layer.text) && !layer.text.includes(fill)) return false;
  if (!fill || fill === 'none') return false;

  const pts = el.subpaths.flatMap((s) => s.pts);
  const [x0, y0, x1, y1] = bbox(pts);
  if (Math.max((x1 - x0) * M_PER_UNIT_X, (y1 - y0) * M_PER_UNIT_Y) > GLYPH_MAX_SPAN_M) return false;

  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return WORDS.some(([a, b, c, d]) => cx >= a && cx <= c && cy >= b && cy <= d);
}

// --- geometry ---------------------------------------------------------------

/**
 * Closed rings to GeoJSON polygons: the largest ring is an exterior, any ring
 * inside it is a hole. The stadium track is the case that matters — one path
 * holding an outer and an inner oval, which becomes a filled lozenge if the
 * rings are taken separately.
 */
function toPolygons(rings) {
  const sorted = [...rings].sort((a, b) => Math.abs(shoelace(b)) - Math.abs(shoelace(a)));
  const polys = [];
  for (const ring of sorted) {
    const host = polys.find((p) => pointInRing(ring[0], p[0]));
    if (host) host.push(ring);
    else polys.push([ring]);
  }
  return polys;
}

/**
 * RFC 7946 winding: exteriors counter-clockwise, holes clockwise.
 *
 * This must run on lon/lat, never on SVG units. SVG y grows downward and the
 * projection flips it, so the shoelace sign inverts — winding before projecting
 * gives every ring exactly the wrong hand. build-landcover.mjs did that and its
 * 593 exteriors are all backwards; build-buildings.mjs projects first and is
 * right. Mapbox tolerates either, so nothing renders wrong and it only surfaces
 * when the file reaches something that follows the spec.
 */
const wind = (ring, exterior) => ((shoelace(ring) >= 0) === exterior ? ring : [...ring].reverse());
const toWgs = (pts) => pts.map((p) => {
  const [lon, lat] = project(p);
  return [+lon.toFixed(6), +lat.toFixed(6)];
});

// --- build ------------------------------------------------------------------

const elements = readDrawing(readFileSync(path.join(DATA, 'ActiveMap.svg'), 'utf8'));
const features = [];
const tally = new Map();
const bump = (k, n = 1) => tally.set(k, (tally.get(k) ?? 0) + n);
let glyphs = 0;
let hidden = 0;

for (const el of elements) {
  const layer = LAYERS[el.layer];
  if (!layer) throw new Error(`element ${el.i} has no layer — the SVG structure changed`);

  if (isLetterform(el, layer)) { glyphs += 1; continue; }
  if (layer.keep === false && layer.kind === 'paper') continue;

  const fill = norm(el.attrs.fill);
  const stroke = norm(el.attrs.stroke);
  const painted = (f) => f && f !== 'none';
  // One element in layer 10 is fill:none with no stroke. It draws nothing, and
  // carrying it forward would put a feature in the file that cannot be seen.
  if (!painted(fill) && !painted(stroke)) { bump('invisible_skipped'); continue; }

  const kind = layer.by?.[fill] ?? layer.kind;
  bump(kind);
  if (layer.keep === false) hidden += 1;

  const closed = el.subpaths.filter((s) => s.closed).map((s) => s.pts);
  const open = el.subpaths.filter((s) => !s.closed).map((s) => s.pts);

  const props = {
    i: el.i,
    kind,
    layer: el.layer,
    ...(layer.keep === false ? { hidden: true } : {}),
    ...(fill && fill !== 'none' ? { fill } : {}),
    ...(stroke && stroke !== 'none' ? { stroke } : {}),
    // Ground metres, not SVG units: a stroke-width of 16 is a 26 m entry road
    // and one of 2 is a 3.3 m footpath, so the renderer can hold true width.
    ...(el.attrs['stroke-width']
      ? { width: +(+el.attrs['stroke-width'] * ((M_PER_UNIT_X + M_PER_UNIT_Y) / 2)).toFixed(2) }
      : {}),
    ...(el.opacity < 1 ? { opacity: +el.opacity.toFixed(3) } : {}),
  };
  const emit = (geometry) => features.push({ type: 'Feature', properties: props, geometry });

  if (closed.length) {
    const polys = toPolygons(closed).map((rings) =>
      rings.map((ring, n) => wind(toWgs(ring), n === 0)));
    if (polys.length === 1) emit({ type: 'Polygon', coordinates: polys[0] });
    else emit({ type: 'MultiPolygon', coordinates: polys });
    // A few elements mix a closed ring with a stray open one; the open part is
    // a stroke detail on a filled shape and has nowhere to go in one feature.
    if (open.length) bump('open_subpath_dropped', open.length);
  } else if (open.length) {
    const lines = open.map(toWgs);
    if (lines.length === 1) emit({ type: 'LineString', coordinates: lines[0] });
    else emit({ type: 'MultiLineString', coordinates: lines });
  }
}

// readDrawing already yields document order; sorting makes the guarantee
// explicit for anything downstream that reorders features.
features.sort((a, b) => a.properties.i - b.properties.i);

writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

console.log(`read ${elements.length} drawable elements from ${LAYERS.length} layers`);
console.log(`text mask: ${WORDS.length} word boxes from the PDF\n`);
console.log('kind                 count');
for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(21)}${String(n).padStart(5)}`);
}
console.log(`\nwrote ${features.length} features to ${path.relative(root, TARGET)}`);
console.log(`  ${hidden} carry hidden:true (the app draws its own labels and icons)`);
console.log(`dropped ${glyphs} letterform outlines — the text is in src/labels.json as strings`);
