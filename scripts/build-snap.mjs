/**
 * Solve per-node corrections that pull the path network onto the linework the
 * basemap draws, and write them to src/path-corrections.json.
 *
 * WHY THIS EXISTS, given that scripts/projection.mjs is already fitted:
 *
 * No global transform can fix what is left. Measured against OpenStreetMap —
 * which is what Mapbox renders — the residual offsets cancel out: the mean
 * offset vector is 0.8 m while the typical magnitude is 3.5 m, a ratio of 0.24.
 * A single shift, scale or rotation would put that ratio near 1. There is
 * nothing coherent left for a transform to remove, and refitting one has been
 * tried repeatedly and correctly refuses to move.
 *
 * The errors are coherent *per path*, though. my campus drew a whole walkway 8 m to
 * one side, consistently along its length, and did it independently for each
 * path. That is a data correction, not a projection change.
 *
 * A WARNING ABOUT MEASURING THIS. Earlier passes matched each vertex to the
 * nearest reference within 8 m and reported the median. That silently discards
 * the vertices that are worst, so it measures only the parts already correct
 * and reports a reassuring 1.9 m. Widening the search alone does not work
 * either — at 25 m the nearest way is often an unrelated one crossing at right
 * angles. Matching on BEARING is what makes a wide search safe: a path and its
 * counterpart are close to parallel, which proximity alone never guarantees.
 * With that, the honest figure is 3.5 m median with a tail past 20 m.
 *
 * WHAT IS SOLVED. Over per-node displacements D:
 *
 *     sum over matches  ( n · D  −  d )²         pull each node onto its match
 *   + lambda · sum over edges  | D_u − D_v |²    hold the network's shape
 *
 * Only the perpendicular component `n · D` is constrained. Sliding a node along
 * its own path is meaningless and penalising it would fight the fit for nothing.
 *
 * Unmatched nodes — most of the campus interior, which OSM does not map — are
 * carried entirely by the smoothness term. That is what stops a corrected
 * stretch from kinking where it meets an uncorrected one, and it is why the
 * smoothing runs over the network's OWN topology rather than over distance. An
 * earlier inverse-distance version pulled on everything nearby in space,
 * including the building footprints, and made them 55% worse. Diffusing along
 * the graph cannot reach anything that is not on the graph.
 *
 * Only node positions change. Edges, junctions and the routing topology are
 * untouched, so nothing that routes today stops routing.
 *
 * PARAMETERS, chosen by held-out cross-validation over 100 m spatial blocks
 * (holding out whole blocks, because neighbouring nodes on one path share a
 * reference way and holding out single nodes leaks the answer):
 *
 *     cutoff  angle  lambda   held-out median      nodes inside a building
 *      12 m    15°    1.0     1.941 -> 1.528 m     112 -> 112
 *      15 m    20°    0.1     2.041 -> 1.538 m     112 -> 110
 *      15 m    20°    0.3     2.041 -> 1.527 m     112 -> 108
 *      15 m    20°    0.5     2.041 -> 1.603 m     112 -> 105   <- shipped
 *      15 m    20°    1.0     2.041 -> 1.706 m     112 -> 108
 *      15 m    20°    3.0     2.041 -> 1.872 m     112 -> 110
 *      20 m    20°    1.0     2.191 -> 2.465 m     112 -> 110   <- fails CV
 *
 * lambda has a real optimum at 0.3 rather than running to an edge. 0.5 ships
 * instead: its cross-validated median is 8 cm behind, which the metric cannot
 * resolve, and it is the more rigid solve — smaller displacements and the best
 * count of nodes left buried inside a building, which is the one check that is
 * independent of the reference being fitted to.
 *
 * A 20 m cutoff makes cross-validation WORSE. That is the false-match boundary
 * showing itself; do not raise it.
 *
 *   node scripts/build-snap.mjs [cutoff] [angle] [lambda]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from './projection.mjs';
import { overpass } from './overpass.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'campus-data/wayfind/api/Batch.json');
const TARGET = path.join(root, 'src/path-corrections.json');

const CUTOFF = Number(process.argv[2] ?? 15);
const ANGLE = Number(process.argv[3] ?? 20);
const LAMBDA = Number(process.argv[4] ?? 0.5);
const COS_LIMIT = Math.cos((ANGLE * Math.PI) / 180);

// Reference classes. Service ways are the campus drives and parking aisles;
// they are dense and well surveyed here, and the bearing test keeps our
// footpaths from being dragged onto one running past at an angle.
const CLASSES = 'footway|path|steps|pedestrian|service|residential|tertiary|secondary|cycleway';

// ---------------------------------------------------------------------------
// The raw network, built exactly as build-paths.mjs builds it. Reading
// src/paths.json instead would be circular once corrections are applied to it.
// ---------------------------------------------------------------------------
const { value } = JSON.parse(readFileSync(SOURCE, 'utf8'));

const ids = [];
const lonlat = [];
const indexOfId = new Map();
for (const node of value.Nodes) {
  if (!node.Is_Active) continue;
  indexOfId.set(node.ID, ids.length);
  ids.push(node.ID);
  lonlat.push(project([node.Pos_X, node.Pos_Y]));
}

const edgeKeys = new Set();
const edges = [];
for (const edge of value.Adjacencies) {
  if (!edge.Is_Active) continue;
  const a = indexOfId.get(edge.From_Node);
  const b = indexOfId.get(edge.To_Node);
  if (a === undefined || b === undefined || a === b) continue;
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (edgeKeys.has(key)) continue;
  edgeKeys.add(key);
  edges.push([a, b]);
}

const adjacency = ids.map(() => []);
for (const [a, b] of edges) {
  adjacency[a].push(b);
  adjacency[b].push(a);
}

// Local east/north metres about the network's centre. Degrees are useless for
// a least-squares fit because a degree of longitude is shorter than a degree of
// latitude, which would quietly make the problem anisotropic.
const CX = lonlat.reduce((s, c) => s + c[0], 0) / lonlat.length;
const CY = lonlat.reduce((s, c) => s + c[1], 0) / lonlat.length;
const rad = (d) => (d * Math.PI) / 180;
const M_PER_DEG_LAT = 111132.92 - 559.82 * Math.cos(2 * rad(CY));
const M_PER_DEG_LON = 111412.84 * Math.cos(rad(CY)) - 93.5 * Math.cos(3 * rad(CY));
const enu = ([lon, lat]) => [(lon - CX) * M_PER_DEG_LON, (lat - CY) * M_PER_DEG_LAT];

const P = lonlat.map(enu);
console.log(`[snap] network ${P.length} nodes, ${edges.length} edges`);

// ---------------------------------------------------------------------------
// Reference geometry
// ---------------------------------------------------------------------------
const lons = lonlat.map((c) => c[0]);
const lats = lonlat.map((c) => c[1]);
const pad = 0.002;
const bbox = [
  (Math.min(...lats) - pad).toFixed(4), (Math.min(...lons) - pad).toFixed(4),
  (Math.max(...lats) + pad).toFixed(4), (Math.max(...lons) + pad).toFixed(4),
];

const { elements } = await overpass(
  `[out:json][timeout:90];way["highway"~"^(${CLASSES})$"](${bbox.join(',')});out geom;`
);

const ref = [];
for (const way of elements) {
  const g = way.geometry.map((p) => enu([p.lon, p.lat]));
  for (let i = 0; i + 1 < g.length; i += 1) {
    const dx = g[i + 1][0] - g[i][0];
    const dy = g[i + 1][1] - g[i][1];
    const len = Math.hypot(dx, dy);
    if (len >= 1) ref.push({ x: g[i][0], y: g[i][1], ux: dx / len, uy: dy / len, len });
  }
}
console.log(`[snap] reference ${elements.length} ways, ${ref.length} segments`);

// ---------------------------------------------------------------------------
// Constraints: one perpendicular pull per edge that has a confident match,
// applied to both of its endpoints.
// ---------------------------------------------------------------------------
const constraints = ids.map(() => []);
let matched = 0;
for (const [a, b] of edges) {
  const dx = P[b][0] - P[a][0];
  const dy = P[b][1] - P[a][1];
  const len = Math.hypot(dx, dy);
  if (len < 2) continue;              // too short for a trustworthy bearing
  const ux = dx / len;
  const uy = dy / len;
  const mx = (P[a][0] + P[b][0]) / 2;
  const my = (P[a][1] + P[b][1]) / 2;

  let best = null;
  for (const r of ref) {
    // abs() because a path and its match may be digitised in either direction.
    if (Math.abs(ux * r.ux + uy * r.uy) < COS_LIMIT) continue;
    const t = Math.max(0, Math.min(r.len, (mx - r.x) * r.ux + (my - r.y) * r.uy));
    const qx = r.x + t * r.ux;
    const qy = r.y + t * r.uy;
    const d = Math.hypot(mx - qx, my - qy);
    if (!best || d < best.d) best = { d, nx: -r.uy, ny: r.ux, qx, qy };
  }
  if (!best || best.d > CUTOFF) continue;

  matched += 1;
  const signed = best.nx * (best.qx - mx) + best.ny * (best.qy - my);
  constraints[a].push({ nx: best.nx, ny: best.ny, d: signed });
  constraints[b].push({ nx: best.nx, ny: best.ny, d: signed });
}
console.log(`[snap] ${matched} of ${edges.length} edges matched ` +
  `(cutoff ${CUTOFF} m, bearing ${ANGLE}°, lambda ${LAMBDA})`);

// ---------------------------------------------------------------------------
// Gauss-Seidel over the 2x2 normal equations at each node. The system is
// diagonally dominant thanks to the smoothness term, so this converges without
// needing a matrix library.
// ---------------------------------------------------------------------------
const D = ids.map(() => [0, 0]);
for (let iteration = 0; iteration < 400; iteration += 1) {
  for (let v = 0; v < P.length; v += 1) {
    let a11 = 0; let a12 = 0; let a22 = 0; let b1 = 0; let b2 = 0;
    for (const c of constraints[v]) {
      a11 += c.nx * c.nx;
      a12 += c.nx * c.ny;
      a22 += c.ny * c.ny;
      b1 += c.d * c.nx;
      b2 += c.d * c.ny;
    }
    const k = LAMBDA * adjacency[v].length;
    a11 += k;
    a22 += k;
    for (const u of adjacency[v]) {
      b1 += LAMBDA * D[u][0];
      b2 += LAMBDA * D[u][1];
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) continue;
    D[v] = [(b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det];
  }
}

// ---------------------------------------------------------------------------
// Emit. Degrees, keyed by my campus's node ID so the file survives a rebuild of the
// network. Sub-5 cm corrections are dropped as noise not worth committing.
// ---------------------------------------------------------------------------
const corrections = {};
let kept = 0;
const sizes = [];
for (let v = 0; v < P.length; v += 1) {
  const magnitude = Math.hypot(D[v][0], D[v][1]);
  sizes.push(magnitude);
  if (magnitude <= 0.05) continue;
  kept += 1;
  corrections[ids[v]] = [
    Number((D[v][0] / M_PER_DEG_LON).toFixed(7)),
    Number((D[v][1] / M_PER_DEG_LAT).toFixed(7)),
  ];
}

writeFileSync(TARGET, `${JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  params: { cutoff: CUTOFF, angle: ANGLE, lambda: LAMBDA },
  matchedEdges: matched,
  corrections,
}, null, 1)}\n`);

sizes.sort((x, y) => x - y);
console.log(
  `[snap] ${kept} nodes corrected -> src/path-corrections.json\n` +
  `[snap] displacement median ${sizes[sizes.length >> 1].toFixed(2)} m  ` +
  `p90 ${sizes[Math.floor(sizes.length * 0.9)].toFixed(2)} m  ` +
  `max ${sizes[sizes.length - 1].toFixed(2)} m`
);
