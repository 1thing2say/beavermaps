/**
 * The streets you arrive by, so a route can start off campus.
 *
 * my campus's printed sheet stops at the fence, and so does src/paths.json. That is
 * correct — inside the boundary their drawing is the best data there is — but it
 * makes the router's world end at the fence too: click a start point on the
 * pavement outside and the nearest graph vertex is somewhere inside the campus,
 * so the walk you get begins in the wrong place.
 *
 * WHY NOT GOOGLE'S PATHS. The obvious reading of "route along the paths on the
 * basemap" does not work: the Map Tiles API serves pictures of roads, not roads.
 * There is no graph in a raster tile, and nothing in the tile response says
 * where a footway goes. Google's Routes API does know, but it is a per-request
 * billed server call that answers in its own geometry — a second network that
 * has to be stitched to ours at every entrance, with its own snapping rules and
 * its own idea of where the kerb is. That seam is the thing this file exists to
 * remove.
 *
 * So the off-campus network comes from OpenStreetMap, which is where Google's
 * competitor data and our own campus boundary already come from. One graph, one
 * router, one route line, turn-by-turn that works across the fence, and no
 * per-request cost. It is also the same corpus Mapbox draws from, so on the
 * Mapbox ground the invisible graph agrees with the visible roads by
 * construction.
 *
 * WHAT IS DRAWN. Nothing. This network is never sent to the browser and never
 * rendered: whichever provider is painting the ground is already drawing these
 * streets, and drawing ours on top of theirs is precisely the doubled-linework
 * seam at the campus edge. The only thing you ever see from this file is the
 * route ribbon lying along it.
 *
 * WHAT THIS DOES, in order:
 *
 *   1. FETCH every OSM way in a ~800 m apron around the campus that a person on
 *      foot may legally use.
 *   2. CLIP each one at the campus boundary and keep only the part outside.
 *      Inside is my campus's drawing, and OSM's version of the campus is a dozen
 *      generalised paths where the sheet has 141 walkways.
 *   3. WELD coincident vertices. Connected OSM ways share a node, so this is
 *      guarding against rounding rather than inventing junctions — and ways
 *      that merely cross are left crossing, because in OSM that means a bridge.
 *   4. GATE. Join the two networks where my campus's own linework already reaches the
 *      street. Each join is a connector, each is printed with its length, and
 *      one is only accepted where the merged graph does not already connect its
 *      two ends — so a road running parallel to a campus path does not get
 *      stitched to it every twenty metres.
 *   5. PRUNE to the component the campus is in, so nothing ships that a walker
 *      standing on my campus cannot actually reach.
 *
 * Attribution: OpenStreetMap contributors, ODbL — the same credit the boundary
 * already carries, and the one both basemaps render in the corner.
 *
 *   node scripts/build-approach-network.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overpass } from './overpass.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (name) => path.join(root, 'src', name);

/**
 * How far out to go. Far enough to reach the bus stops on Auburn Blvd and the
 * neighbourhoods either side, close enough that the graph stays a campus
 * approach rather than a city.
 */
const APRON_M = 800;

/** Coincident OSM vertices. Connected ways share a node exactly; this is slack. */
const WELD_M = 0.5;

/**
 * At or under this, my campus's linework and OSM's are the same ground drawn twice.
 *
 * The value is build-walk-network.mjs's own WELD_M, for its own reason: a path
 * on this campus is 3.3 m wide, so two centrelines within two metres are inside
 * one path's width and the strokes visibly overlap. A connector that short adds
 * no route and can cross nothing, so it needs no further argument — which is
 * what separates it from the ones below.
 */
const TOUCH_M = 2.0;

/**
 * How far a connector may reach to join the two networks.
 *
 * Not a tuning knob so much as a statement about the data: my campus's driveways and
 * footways are drawn out to the public road, so where a real entrance exists the
 * gap is already small — 13 of their vertices land within 2 m of an OSM
 * centreline and 27 within 5. Past ~12 m a connector stops being the last few
 * metres of an entrance and starts being a path across somebody's verge.
 */
const GATE_M = 12;

/**
 * A connector longer than TOUCH_M is only accepted where the merged graph does
 * not already put its two ends within this far of each other on foot.
 *
 * The guard matters more here than anywhere else in the pipeline, because my campus
 * draws its own perimeter driveways and OSM draws the same streets about three
 * metres away — so for hundreds of metres the two networks run side by side and
 * every campus vertex along them looks like a door. The first attempt used
 * build-walk-network's local test, "already joined within six times the gap",
 * and accepted 80 connectors: the second one twenty metres along the same kerb
 * sees a 43 m walk round through the first, which is outside a 19 m cap, so it
 * is admitted, and so is the next. Sewing a seam, not finding a door.
 *
 * An absolute threshold is the right shape because the question is absolute: is
 * this a NEW way in, or another stitch beside one we already have? At 250 m a
 * redundant gate saves a walker at most 250 m and costs a fabricated path
 * through whatever lies between two centrelines — usually a fence.
 */
const GATE_DETOUR_M = 250;

/** ~1 cm. Shared endpoints must stay bit-identical or the router splits them. */
const DECIMALS = 7;

// Local equirectangular metres, as everywhere else in this pipeline.
const R = 6371008.8, rad = Math.PI / 180, LAT = 38.6493;
const MX = R * rad * Math.cos(LAT * rad), MY = R * rad;
const flat = ([lon, lat]) => [lon * MX, lat * MY];
const unflat = ([x, y]) => [
  Number((x / MX).toFixed(DECIMALS)),
  Number((y / MY).toFixed(DECIMALS)),
];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const segDist = (p, a, b) => {
  const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1];
  const L = vx * vx + vy * vy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / L));
  return Math.hypot(wx - t * vx, wy - t * vy);
};

// --- the campus, and the box around it --------------------------------------

const ring = JSON.parse(readFileSync(src('campus-boundary.json'), 'utf8'))
  .geometry.coordinates[0];

/** Ray casting against the campus ring. */
function insideCampus([lon, lat]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }
  return hit;
}

const lons = ring.map((c) => c[0]);
const lats = ring.map((c) => c[1]);
const dLat = APRON_M / MY;
const dLon = APRON_M / MX;

/**
 * The apron, as [south, west, north, east].
 *
 * Enforced twice, and it has to be. Overpass takes a bounding box as a filter
 * over WAYS, and `out geom` then returns each matching way in full — so one way
 * clipping the corner of the box arrives complete, and Auburn Blvd came back
 * running two kilometres past it. Selecting on the box is not clipping to it.
 */
const APRON = [
  Number((Math.min(...lats) - dLat).toFixed(4)),
  Number((Math.min(...lons) - dLon).toFixed(4)),
  Number((Math.max(...lats) + dLat).toFixed(4)),
  Number((Math.max(...lons) + dLon).toFixed(4)),
];

/** Liang-Barsky: the part of segment a-b inside the apron, or null. */
function inApron(a, b) {
  const [south, west, north, east] = APRON;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a[0] - west], [dx, east - a[0]], [-dy, a[1] - south], [dy, north - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;                          // parallel and outside
      continue;
    }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  if (t1 - t0 < 1e-12) return null;
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

// --- 1. fetch ----------------------------------------------------------------
//
// Everything a pedestrian may use, by exclusion rather than by listing: the
// classes below are the ones it is illegal or impossible to walk on, plus the
// two tag families that say so explicitly. Listing what to KEEP would silently
// drop a footway tagged with anything unexpected, and around a campus the
// unexpected tags are exactly the paths people take.
//
// Sidewalks mapped as their own ways are used where they exist; where they do
// not, the road centreline stands in, which is what every pedestrian router
// does and is why the residential and service classes are kept.

const EXCLUDED = 'motorway|motorway_link|trunk|trunk_link|construction|proposed'
  + '|raceway|bus_guideway|escape';

const QUERY = `[out:json][timeout:180];
way[highway][highway!~"^(${EXCLUDED})$"][foot!=no][access!~"^(private|no)$"]`
  + `(${APRON.join(',')});
out geom;`;

const { elements } = await overpass(QUERY);
const ways = elements.filter((w) => Array.isArray(w.geometry) && w.geometry.length > 1);

// --- 2. clip at the campus boundary ------------------------------------------
//
// Not "drop the ways that are mostly outside" — cut them. A road that runs past
// the campus and turns in at the gate has to keep the part on the street and
// lose the part on the grounds, and a whole-way test gets that wrong in both
// directions.

/** Where segment a-b crosses ring edge p-q, as a parameter along a-b. */
function crossParam(a, b, p, q) {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = q[0] - p[0], sy = q[1] - p[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-15) return null;
  const t = ((p[0] - a[0]) * sy - (p[1] - a[1]) * sx) / den;
  const u = ((p[0] - a[0]) * ry - (p[1] - a[1]) * rx) / den;
  if (t <= 0 || t >= 1 || u < 0 || u > 1) return null;
  return t;
}

/** The parts of segment a-b that lie outside the campus, in lon/lat. */
function outsideParts(a, b) {
  const ts = [0, 1];
  for (let i = 1; i < ring.length; i += 1) {
    const t = crossParam(a, b, ring[i - 1], ring[i]);
    if (t !== null) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out = [];
  for (let i = 1; i < ts.length; i += 1) {
    const [t0, t1] = [ts[i - 1], ts[i]];
    if (t1 - t0 < 1e-12) continue;
    const mid = t0 + (t1 - t0) / 2;
    if (insideCampus([a[0] + mid * (b[0] - a[0]), a[1] + mid * (b[1] - a[1])])) continue;
    out.push([
      [a[0] + t0 * (b[0] - a[0]), a[1] + t0 * (b[1] - a[1])],
      [a[0] + t1 * (b[0] - a[0]), a[1] + t1 * (b[1] - a[1])],
    ]);
  }
  return out;
}

// --- 3. weld ------------------------------------------------------------------

const coord = [];        // node -> [x, y] in metres
const fixed = [];        // node -> lon/lat to emit verbatim, when it has one
const buckets = new Map();

/**
 * The node at p, creating it if new.
 *
 * `keep` pins the emitted lon/lat. my campus's vertices come in already rounded to
 * seven decimals and have to go back out at exactly those digits: the router
 * welds on coordinate equality, so a metre round trip that moves the last digit
 * would leave a gate connector ending one centimetre off the campus network and
 * joined to nothing.
 */
function nodeAt(p, keep = null) {
  const gx = Math.round(p[0] / WELD_M), gy = Math.round(p[1] / WELD_M);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const id of buckets.get(`${gx + dx},${gy + dy}`) ?? []) {
        if (dist(coord[id], p) <= WELD_M) {
          if (keep && !fixed[id]) fixed[id] = keep;
          return id;
        }
      }
    }
  }
  const id = coord.length;
  coord.push(p);
  fixed.push(keep);
  const key = `${gx},${gy}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(id);
  return id;
}

const edges = new Map();          // "u-v" -> [u, v]
const origin = new Map();         // "u-v" -> 'arc' | 'osm' | 'gate'
const EK = (u, v) => (u < v ? `${u}-${v}` : `${v}-${u}`);
function addEdge(u, v, from) {
  if (u === v) return;
  const key = EK(u, v);
  if (!edges.has(key)) {
    edges.set(key, [u, v]);
    origin.set(key, from);
  }
}

let clipped = 0;
let beyond = 0;
const kinds = new Map();
for (const way of ways) {
  const pts = way.geometry.map((p) => [p.lon, p.lat]);
  let drew = false;
  for (let i = 1; i < pts.length; i += 1) {
    const held = inApron(pts[i - 1], pts[i]);
    if (!held) { beyond += 1; continue; }
    const parts = outsideParts(held[0], held[1]);
    if (!parts.length) clipped += 1;
    for (const [a, b] of parts) {
      addEdge(nodeAt(flat(a)), nodeAt(flat(b)), 'osm');
      drew = true;
    }
  }
  if (drew) kinds.set(way.tags.highway, (kinds.get(way.tags.highway) ?? 0) + 1);
}

// --- 4. gate ------------------------------------------------------------------
//
// my campus's own network goes in next, verbatim and under its own coordinates, so
// the connectors below can be measured against the real thing rather than
// against a re-projection of it.

const campus = JSON.parse(readFileSync(src('paths.json'), 'utf8')).features;
for (const f of campus) {
  const cs = f.geometry.coordinates;
  for (let i = 1; i < cs.length; i += 1) {
    addEdge(nodeAt(flat(cs[i - 1]), cs[i - 1]), nodeAt(flat(cs[i]), cs[i]), 'arc');
  }
}
const campusNodes = new Set();
for (const [key, [u, v]] of edges) {
  if (origin.get(key) === 'arc') { campusNodes.add(u); campusNodes.add(v); }
}

function adjacency() {
  const adj = new Map();
  for (const [u, v] of edges.values()) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  }
  return adj;
}

/** Shortest walk from `from` to every node within `cap` metres. */
function reach(from, cap) {
  const adj = adjacency();
  const best = new Map([[from, 0]]);
  const heap = [[0, from]];
  while (heap.length) {
    heap.sort((a, b) => a[0] - b[0]);
    const [dv, u] = heap.shift();
    if (dv > (best.get(u) ?? Infinity) || dv > cap) continue;
    for (const m of adj.get(u) ?? []) {
      const nd = dv + dist(coord[u], coord[m]);
      if (nd < (best.get(m) ?? Infinity)) { best.set(m, nd); heap.push([nd, m]); }
    }
  }
  return best;
}

// Every campus node that comes close to an off-campus way, closest first, so
// the most certain entrances claim their connection before the marginal ones
// are considered at all.
const candidates = [];
for (const n of campusNodes) {
  const p = coord[n];
  let best = null;
  for (const [key, [u, v]] of edges) {
    if (origin.get(key) !== 'osm') continue;
    const d = segDist(p, coord[u], coord[v]);
    if (d > GATE_M || (best && d >= best.d)) continue;
    const a = coord[u], b = coord[v];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L = vx * vx + vy * vy;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
    best = { d, key, u, v, t, foot: [a[0] + t * vx, a[1] + t * vy] };
  }
  if (best) candidates.push({ n, ...best });
}
candidates.sort((a, b) => a.d - b.d);

const gates = [];
let redundant = 0;
for (const c of candidates) {
  if (!edges.has(c.key)) continue;                     // that way was since split
  // A touch is the same ground drawn twice and is taken as read. Anything
  // longer has to earn it: if the merged graph already connects the two ends
  // nearby, this is a second stitch down one seam rather than another entrance.
  if (c.d > TOUCH_M) {
    const around = reach(c.n, GATE_DETOUR_M);
    const near = Math.min(around.get(c.u) ?? Infinity, around.get(c.v) ?? Infinity);
    if (near <= GATE_DETOUR_M) { redundant += 1; continue; }
  }

  // Land on the way's own vertex where there is one within a weld, and split it
  // where there is not — a connector that ends in the middle of an OSM segment
  // with no node there joins nothing.
  const span = dist(coord[c.u], coord[c.v]);
  let target;
  if (c.t * span < WELD_M) target = c.u;
  else if ((1 - c.t) * span < WELD_M) target = c.v;
  else {
    target = nodeAt(c.foot);
    edges.delete(c.key);
    origin.delete(c.key);
    addEdge(c.u, target, 'osm');
    addEdge(target, c.v, 'osm');
  }
  addEdge(c.n, target, 'gate');
  gates.push({ metres: c.d, at: unflat(coord[c.n]) });
}

// --- 5. prune -----------------------------------------------------------------

function componentOf(start) {
  const adj = adjacency();
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); stack.push(m); }
  }
  return seen;
}

// Seeded from the campus rather than from the biggest piece: what has to ship is
// what a walker standing on my campus can reach, and on a bad day those are not the
// same set.
const reachable = componentOf([...campusNodes][0]);
const stranded = [...new Set(
  [...edges.values()].flat().filter((n) => !reachable.has(n)),
)];

// --- ship ---------------------------------------------------------------------
//
// Only the off-campus half is written. src/paths.json stays exactly as
// build-walk-network.mjs left it, and the server unions the two — so my campus's
// network remains one file that one script owns, and nothing here can quietly
// edit it.

const at = (n) => fixed[n] ?? unflat(coord[n]);
const features = [];
for (const [key, [u, v]] of edges) {
  const from = origin.get(key);
  if (from === 'arc') continue;
  if (!reachable.has(u) || !reachable.has(v)) continue;
  const a = at(u);
  const b = at(v);
  if (a[0] === b[0] && a[1] === b[1]) continue;        // collapsed by rounding
  features.push({
    type: 'Feature',
    properties: { source: from },
    geometry: { type: 'LineString', coordinates: [a, b] },
  });
}
features.sort((x, y) => (
  x.geometry.coordinates[0][0] - y.geometry.coordinates[0][0]
  || x.geometry.coordinates[0][1] - y.geometry.coordinates[0][1]
  || x.geometry.coordinates[1][0] - y.geometry.coordinates[1][0]
  || x.geometry.coordinates[1][1] - y.geometry.coordinates[1][1]
));

writeFileSync(
  src('approach-paths.json'),
  `${JSON.stringify({ type: 'FeatureCollection', features })}\n`,
);

const metres = features.reduce((s, f) => {
  const [a, b] = f.geometry.coordinates.map(flat);
  return s + dist(a, b);
}, 0);
const byKind = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');

console.log(`[approach] ${ways.length} OSM ways in a ${APRON_M} m apron (${byKind})`);
console.log(`[approach] ${beyond} segments trimmed off beyond the apron, `
  + `${clipped} dropped as wholly inside the campus`);
const touches = gates.filter((g) => g.metres <= TOUCH_M);
const reaches = gates.filter((g) => g.metres > TOUCH_M);
console.log(`[approach] ${candidates.length} campus vertices within ${GATE_M} m of a street; `
  + `${redundant} skipped as already reachable within ${GATE_DETOUR_M} m`);
console.log(`[approach] ${gates.length} connectors join my campus's network to the street, `
  + `${(gates.reduce((s, g) => s + g.metres, 0)).toFixed(0)} m in total`);
console.log(`[approach]    ${touches.length} touch it within ${TOUCH_M} m — the same ground drawn twice`);
console.log(`[approach]    ${reaches.length} reach further, and each is the only way in within ${GATE_DETOUR_M} m:`);
for (const g of reaches.sort((a, b) => a.metres - b.metres)) {
  console.log(`[approach]       ${g.metres.toFixed(1)} m at ${g.at[0]}, ${g.at[1]}`);
}
console.log(`[approach] ${stranded.length} node(s) unreachable from campus, dropped`);
console.log(`[approach] ${features.length} segments, ${(metres / 1000).toFixed(2)} km -> src/approach-paths.json`);
