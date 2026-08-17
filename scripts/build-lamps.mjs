// Where the lamp posts are, inferred from where people walk.
//
// my campus does not publish its lighting, and a campus map does not need it to: a
// path that is used after dark is a path that is lit, and the walk network in
// src/paths.json is the best statement anyone has of which paths those are. So
// the lamps are placed along it — every LAMP_GAP_M of walkway, which is the
// spacing real campus lighting is designed to, since the standard is overlapping
// pools rather than isolated ones.
//
// THE OUTPUT IS NOT A CLAIM ABOUT REAL LAMP POSTS. Nothing here knows where my campus
// actually put its poles, and the map does not draw poles — it draws warm pools
// of light on the ground. What is being asserted is only "this walkway is lit",
// which is true of essentially every walkway on a community college campus, and
// the placement inside it is a plausible fiction rather than a survey. That is
// worth writing down because the file it produces sits next to roofs.json, which
// IS measured, and the two should not be read the same way.
//
// TWO RULES BEYOND THE SPACING, and both are about how the result reads rather
// than about lighting engineering:
//
//   JUNCTIONS FIRST. A crossing of two paths is the one place a real campus
//   always puts a lamp, and it is also where a naive walk drops three of them a
//   metre apart. So junctions are seeded first and everything else has to keep
//   its distance from what is already placed.
//
//   NOTHING INSIDE A BUILDING. The network runs through breezeways and under
//   overhangs, and a glow blooming out of the middle of a roof reads as a fire
//   rather than as a lamp. Anything inside a directory footprint is dropped.
//
// Usage: node scripts/build-lamps.mjs > src/lamps.json

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(path.join(root, 'src', name), 'utf8'));

/** Along a walkway. Campus lighting is designed for overlapping pools. */
const LAMP_GAP_M = 32;
/** No two lamps closer than this, whatever produced them. */
const MERGE_M = 18;

// Local metres per degree at my campus. Constant over a campus to well under a metre.
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 87_000;
const metres = (a, b) => Math.hypot(
  (a[0] - b[0]) * M_PER_DEG_LON,
  (a[1] - b[1]) * M_PER_DEG_LAT,
);

const paths = load('paths.json');
const directory = load('directory.json');

/** Rings of every building, for the "not indoors" test. */
const rings = [];
for (const feature of directory.features) {
  const g = feature.geometry;
  const polygons = g.type === 'MultiPolygon' ? g.coordinates
    : g.type === 'Polygon' ? [g.coordinates] : [];
  for (const polygon of polygons) rings.push(polygon[0]);
}

/** Even-odd ray cast. The rings are small and there are thirty of them. */
function inside(point, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1])
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const indoors = (p) => rings.some((ring) => inside(p, ring));

// ---- junctions: every vertex more than two edges meet at -----------------
const seen = new Map();
const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
for (const feature of paths.features) {
  const line = feature.geometry.coordinates;
  for (const end of [line[0], line.at(-1)]) {
    const k = key(end);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
}

const lamps = [];
const far = (p) => lamps.every((q) => metres(p, q) >= MERGE_M);
const place = (p) => {
  if (indoors(p) || !far(p)) return;
  lamps.push([+p[0].toFixed(6), +p[1].toFixed(6)]);
};

for (const [k, count] of seen) {
  if (count < 3) continue;
  place(k.split(',').map(Number));
}
const junctions = lamps.length;

// ---- then along every edge, at the design spacing ------------------------
// Sorted longest first so the long spines get their spacing set before the
// stubs off them start claiming positions — otherwise a short link at a
// junction pushes the whole run out of step with itself.
const edges = paths.features
  .map((f) => f.geometry.coordinates)
  .sort((a, b) => metres(b[0], b.at(-1)) - metres(a[0], a.at(-1)));

for (const line of edges) {
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const run = metres(a, b);
    if (run < 1) continue;
    // Offset by half a gap so a lamp does not land on top of the junction that
    // was already given one.
    for (let d = LAMP_GAP_M / 2; d < run; d += LAMP_GAP_M) {
      const f = d / run;
      place([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
  }
}

const out = {
  type: 'FeatureCollection',
  note: 'Inferred lamp positions along the walk network — see scripts/build-lamps.mjs. '
    + 'Not a survey of my campus\'s actual lighting: the claim is that these walkways are lit, '
    + `not that a pole stands at each point. Spacing ${LAMP_GAP_M} m, merged under ${MERGE_M} m.`,
  features: lamps.map((coordinates) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates },
  })),
};

process.stdout.write(`${JSON.stringify(out)}\n`);
process.stderr.write(`${lamps.length} lamps (${junctions} at junctions, `
  + `${lamps.length - junctions} along runs)\n`);
