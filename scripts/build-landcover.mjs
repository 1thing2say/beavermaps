/**
 * Extract ground cover — lawn, paving, parking, trees, the track and the pool —
 * from the archived my campus basemap SVG.
 *
 * build-buildings.mjs takes the white shapes off this same sheet. Everything
 * here is what those buildings sit *on*, and without it the campus renders as
 * footprints floating on a flat mask, which is what the basemap clip leaves
 * behind once Mapbox's own data inside the boundary is removed.
 *
 * Classification is by fill, established the same way build-buildings
 * established its own palette and confirmed against the legend in
 * campus-data/wayfind/external/campus-map.pdf, which is the same drawing with a
 * key attached (see build-amenities.mjs for the measurement that shows they
 * are the same drawing):
 *
 *   #bcd37e     4   lawn and open landscaped ground, 519,169 m2
 *   #577f3d   554   trees and planted strips, median 76 m2 — a canopy
 *   #e2e3e4    11   paved plaza and hardscape between buildings
 *   #a9afb7    20   parking lots
 *   #f4ead7     1   the stadium running track
 *   #37afcb     1   the swimming pool
 *   #8c8c8c     1   the fenced-off "Closed" area west of the STEM centre
 *
 * Deliberately excluded, each checked by rendering it and looking at it:
 *
 *   #c7c8ca   the single full-sheet background rect. It is the paper, not a
 *             feature, and covers the entire viewBox.
 *   #cd1f40   the HOME BASE callout badges over the LRC and the CTE building,
 *   #0f2b4d   drawn as a rounded speech bubble full of discipline pictograms.
 *             Map annotation, not ground — and at 2,384 m2 it is big enough to
 *             pass any area test, so it has to be excluded by fill.
 *   #4e4e4f   the dark plates behind label text.
 *   #4d4d4f
 *
 * The track is why this reads whole elements rather than individual rings. It
 * is one <path> holding an outer and an inner oval; taken as two shapes it
 * fills in and stops being a track. Any element whose rings nest becomes a
 * polygon with holes here.
 *
 * Source lives under campus-data/, which is gitignored — see
 * campus-data/MANIFEST.md. Output src/landcover.json is committed.
 *
 *   node scripts/build-landcover.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, M2_PER_UNIT2 } from './projection.mjs';
import {
  readShapeGroups,
  readCircles,
  ringArea,
  shoelace,
  pointInRing,
} from './svg-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'campus-data/wayfind/api');
const TARGET = path.join(root, 'src/landcover.json');

/**
 * Draw order, bottom first. This is the order features are written in, so a
 * single Mapbox fill layer reproduces the sheet's own stacking: trees last
 * because they overhang everything, the pool and track above the ground they
 * are cut into.
 */
const CLASSES = [
  { kind: 'lawn', fill: '#bcd37e' },
  { kind: 'paving', fill: '#e2e3e4' },
  { kind: 'parking', fill: '#a9afb7' },
  { kind: 'closed', fill: '#8c8c8c' },
  { kind: 'track', fill: '#f4ead7' },
  { kind: 'pool', fill: '#37afcb' },
  { kind: 'tree', fill: '#577f3d' },
];

/** Below this a shape is a join artefact or a speck, not ground. */
const MIN_M2 = 5;
/** Segments used when a <circle> is turned into a ring. */
const CIRCLE_SEGMENTS = 32;

// --- geometry ---------------------------------------------------------------

/**
 * Split an element's rings into exteriors and their holes.
 *
 * Containment is tested with a vertex rather than a centroid: these rings nest
 * concentrically, so any interior point works, and a vertex needs no area
 * computation that could degenerate on a thin ring.
 */
function toPolygons(rings) {
  const sorted = [...rings].sort((a, b) => ringArea(b) - ringArea(a));
  const polys = [];
  for (const ring of sorted) {
    const parent = polys.find((p) => pointInRing(ring[0], p[0]));
    if (parent) parent.push(ring);
    else polys.push([ring]);
  }
  return polys;
}

/**
 * GeoJSON's right-hand rule: exterior counter-clockwise, holes clockwise.
 * Projecting flips the sign, because SVG y grows downward and latitude grows up.
 */
// Must run on lon/lat: SVG y grows downward and the projection flips it, so
// winding in SVG units gives every ring the wrong hand.
function wind(ring, exterior) {
  const ccw = shoelace(ring) >= 0;
  return ccw === exterior ? ring : [...ring].reverse();
}

function circleRing({ centre: [cx, cy], rx, ry }) {
  const ring = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i += 1) {
    const t = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    ring.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return ring;
}

// --- build ------------------------------------------------------------------

const svg = readFileSync(path.join(DATA, 'ActiveMap.svg'), 'utf8');
const groups = readShapeGroups(svg);
const circles = readCircles(svg);

const features = [];
const stats = [];

for (const { kind, fill } of CLASSES) {
  const elements = [
    ...groups.filter((g) => g.attrs.fill === fill).map((g) => g.rings),
    ...circles.filter((c) => c.attrs.fill === fill).map((c) => [circleRing(c)]),
  ];

  let kept = 0;
  let area = 0;
  let holes = 0;
  for (const rings of elements) {
    for (const poly of toPolygons(rings)) {
      // Holes are subtracted, so the net area is what the shape actually covers.
      const m2 = poly.reduce(
        (sum, ring, i) => sum + (i === 0 ? ringArea(ring) : -ringArea(ring)),
        0,
      ) * M2_PER_UNIT2;
      if (m2 < MIN_M2) continue;
      kept += 1;
      area += m2;
      holes += poly.length - 1;
      features.push({
        type: 'Feature',
        properties: { kind, area_m2: Math.round(m2) },
        geometry: {
          type: 'Polygon',
          coordinates: poly.map((ring, i) => wind(ring.map(project), i === 0)),
        },
      });
    }
  }
  stats.push({ kind, kept, area, holes });
}

writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const bytes = readFileSync(TARGET).length;
console.log(`[build-landcover] ${features.length} polygons -> src/landcover.json (${Math.round(bytes / 1024)} kB)`);
for (const { kind, kept, area, holes } of stats) {
  const h = holes ? `, ${holes} hole${holes > 1 ? 's' : ''}` : '';
  console.log(`[build-landcover]   ${kind.padEnd(8)} ${String(kept).padStart(4)}  ${Math.round(area).toLocaleString().padStart(9)} m2${h}`);
}
