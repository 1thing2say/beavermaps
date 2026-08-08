/**
 * The routing network IS the light-grey paths my campus's printed map draws.
 *
 * Not derived from them, not fitted to them — the same polylines, with the
 * smallest set of edits that turn a drawing into a graph. Everything here is
 * either lifted verbatim from the sheet or removes something the sheet drew
 * twice.
 *
 * ONE EXCEPTION, and it is quarantined: src/path-links.json holds connectors
 * added by hand where the sheet omits a link that plainly exists on the ground.
 * It is a separate file, applied as its own stage, and its count and metres are
 * printed on every build, so the share of this network that is not my campus's drawing
 * is never in doubt. Today it is 11 links and 191 m out of 13.6 km — 1.4%.
 *
 * WHERE THE DATA COMES FROM. On the sheet a walkway is a stroked path carrying
 * a real ground width, so the stroke IS the centreline: 103 walkways, 24
 * driveways, all in #e2e3e4, plus 30 crossings. src/basemap.json already holds
 * them element for element with their widths and the cartographer's own layer,
 * which is why this script needs nothing from campus-data/ and runs from a bare
 * clone.
 *
 * WHY DEDUPING IS THE WHOLE JOB. Ride a centreline down each drawn stroke and
 * the sheet turns out to contain 40 near-parallel overlapping pairs:
 *
 *   - 17 walkway-on-walkway, several of them 0.1 to 1.0 m apart on paths only
 *     3.3 m wide. That is one path drawn twice. On paper both strokes render as
 *     a single grey band and nobody can tell; on a routing graph it is two
 *     parallel routes down one corridor.
 *   - 22 driveway-alongside-walkway — a road and its footway. Real on the
 *     ground, but you want the footway, not both.
 *
 * That is what made three lines appear to merge into one on screen. It is a
 * property of the drawing, not of the extraction.
 *
 * WHAT THIS DOES, in order:
 *
 *   1. DEDUPE. A stroke whose length is mostly covered by another, running
 *      parallel, is dropped. Walkways are preferred over driveways and long
 *      over short, so the survivor is the pedestrian line down the corridor.
 *   2. NODE. Illustration linework crosses rather than joins — intersections
 *      happen mid-segment with no shared vertex. Every genuine crossing is cut
 *      into both lines, or a junction on screen is not one in the graph.
 *   3. WELD. Vertices within WELD_M become one node. This is not invention: it
 *      is recognising that a draughtsman's "touching" endpoints land a metre or
 *      two apart.
 *   4. TEE. A stroke that ENDS on another is a junction NODE cannot see — it
 *      does not cross, it stops — and WELD has no vertex there to join to.
 *      Dead ends within TEE_M of another stroke are teed onto it.
 *   5. JUNCTION. Two lines passing within a few metres and never joining is a
 *      junction on paper and nothing in the graph, and none of the four stages
 *      above sees it: it is not a crossing, shares no vertex, has no loose end
 *      and is not parallel. Welded only where the graph already makes you walk
 *      JUNCTION_RATIO times further around, so paths that legitimately pass
 *      close without meeting are left alone. Adds a node, never a metre.
 *   6. LINK. Apply src/path-links.json, the hand-added connectors above.
 *   7. SPLICE. The router only accepts vertices, so every positioned
 *      destination gets a node at its closest point on the network. Without it
 *      a path can run straight past a building while the nearest vertex is
 *      fifty metres up the way, and the destination quietly resolves elsewhere.
 *
 * There is still deliberately NO automatic bridging step. An earlier version
 * closed gaps between fragments with 42 generated connectors; they are gone,
 * because a connector the sheet does not draw is a guess, and that one was made
 * 42 times unsupervised. LINK is the opposite: each entry is written down by
 * hand with a reason, and the count is printed. It is also a last resort: an
 * earlier pass wrote 15 links and eleven of them ran PARALLEL to a path my campus
 * already draws, because the gap was never a missing path but a drawn path
 * failing to join. JUNCTION fixes that cause, and six of the fifteen were then
 * shown redundant by ablation. The cost of the rest is honest
 * too — whatever the drawing leaves disconnected stays disconnected, and only
 * the largest component ships.
 *
 *   node scripts/build-walk-network.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (name) => path.join(root, 'src', name);

const basemap = JSON.parse(readFileSync(src('basemap.json'), 'utf8')).features;
const places = JSON.parse(readFileSync(src('places.json'), 'utf8')).features;

/** The light grey every path on this sheet is drawn in. */
const PAVEMENT = '#e2e3e4';

/** Two vertices this close were meant to be the same point. */
const WELD_M = 2.0;
/** Parallel strokes closer than this are the same corridor drawn twice. */
const DUPE_M = 3.0;
/**
 * A dead end this close to another stroke was meant to meet it.
 *
 * Deliberately the same value as DUPE_M, for the same physical reason: a path
 * on this sheet is 3.3 m wide, so two centrelines closer than that are inside
 * one path's width and the drawn strokes visibly touch. Measured, too — see the
 * tee step for what happens either side of it.
 */
const TEE_M = DUPE_M;
/**
 * Ceiling on the width-derived corridor tolerance.
 *
 * Half the sum of two widths is the right idea and unbounded is not: my campus draws
 * plaza-width "walkways" up to 13.2 m, and paired with a 6.6 m driveway that
 * puts the tolerance at 9.9 m. Two centrelines 9.9 m apart are not one path,
 * they are two, and merging them drags the survivor clear off the drawn
 * pavement — visible in imagery at two places before this cap existed. A plaza's
 * centreline is not a corridor in the first place.
 */
const TOL_CAP = 5.0;
/**
 * A vertex this close to a line it is not joined to, where the graph makes you
 * walk JUNCTION_RATIO times further to get across, is a junction the drawing
 * makes and the extraction missed. See the junction stage.
 *
 * Swept against imagery rather than picked. At 4 m the repair is real but
 * partial; 6 m adds four more welds and every one of them lands on continuous
 * pavement. Past that it breaks down fast: at 8-10 m the extra welds cut across
 * a lawn, clip the planted island inside the roundabout, and wander over the
 * Portable Village roofs. The detour guard below is necessary but not
 * sufficient — two paths either side of a lawn genuinely are far apart through
 * the graph, so the ratio test happily approves a shortcut across the grass.
 * That is what bounds this at 6.
 */
const JUNCTION_M = 6.0;
const JUNCTION_RATIO = 6;
/** ...if they also agree in bearing to within this. */
const DUPE_ANGLE = 20;
/** ...over at least this share of the shorter one's length. */
const DUPE_COVER = 0.7;
/**
 * A destination further than this from the network gets no node of its own.
 * A guard against a garbage coordinate, not a quality threshold — the nearest
 * point on the graph is the right snap target however far away the thing is.
 */
const SPLICE_M = 150;
/** ~1 cm. Shared endpoints must stay bit-identical or the router splits them. */
const DECIMALS = 7;

// Local equirectangular metres; the campus is 1 km across, so this is exact to
// far below the precision anything here cares about.
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
const bearingGap = (p, q) => {
  let d = Math.abs(p - q) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return (d * 180) / Math.PI;
};

// --- the drawn paths, verbatim ----------------------------------------------

const KIND_RANK = { walkway: 0, crossing: 1, driveway: 2 };

const strokes = [];
for (const f of basemap) {
  const { kind, stroke, width } = f.properties;
  if (f.geometry.type !== 'LineString') continue;
  if (!(kind in KIND_RANK)) continue;
  // Crossings are drawn darker than the rest and are kept regardless: they are
  // short, and they are how a footway gets to the other side of a road.
  if (kind !== 'crossing' && stroke !== PAVEMENT) continue;
  const pts = f.geometry.coordinates.map(flat);
  if (pts.length < 2) continue;
  const len = pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);
  if (len <= 0) continue;
  strokes.push({ pts, len, kind, width: width ?? 1, rank: KIND_RANK[kind] });
}

// --- 1. dedupe ---------------------------------------------------------------

/** Nearest distance from p to any segment of a polyline, and the local bearing. */
function nearestOn(pts, p) {
  let best = Infinity, ang = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const d = segDist(p, pts[i - 1], pts[i]);
    if (d < best) {
      best = d;
      ang = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    }
  }
  return [best, ang];
}

/** Share of `a` that runs parallel to and within DUPE_M of `b`. */
function coveredBy(a, b) {
  const STEP = 2;
  let inside = 0, total = 0;
  for (let i = 1; i < a.pts.length; i += 1) {
    const p0 = a.pts[i - 1], p1 = a.pts[i];
    const segLen = dist(p0, p1);
    const own = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    const n = Math.max(1, Math.round(segLen / STEP));
    for (let k = 0; k < n; k += 1) {
      const t = (k + 0.5) / n;
      const p = [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])];
      const [d, ang] = nearestOn(b.pts, p);
      total += 1;
      if (d <= DUPE_M && bearingGap(own, ang) <= DUPE_ANGLE) inside += 1;
    }
  }
  return total ? inside / total : 0;
}

// Keep in preference order — walkway before crossing before driveway, then
// longest first — so whatever survives a corridor is the pedestrian line.
//
// This only catches a stroke duplicated along essentially its whole length.
// Most duplication on this sheet is PARTIAL — a walkway shadows a driveway for
// eighty metres of its four hundred — and dropping the whole stroke for that
// would delete real path. The collapse stage further down handles the rest.
const ordered = [...strokes].sort((a, b) => a.rank - b.rank || b.len - a.len);
const kept = [];
const dropped = [];
// A stroke is dropped whole, so a stroke that is 70% shadowed loses its other
// 30% with it. Today that costs 6 m across the whole sheet — every real
// duplicate here is covered at 75-100% — but nothing in the pipeline was
// stopping it from costing a hundred, and a silent loss is the kind that only
// shows up as a routing detour months later. So the remainder is measured, and
// a stroke with a real tail left over is kept instead: the collapse stage
// merges the shadowed part anyway, which is where that job belongs.
const DUPE_TAIL_M = 4.0;
let tailKept = 0;
for (const s of ordered) {
  let covering = null, cover = 0;
  for (const k of kept) {
    const c = coveredBy(s, k);
    if (c >= DUPE_COVER && c > cover) { covering = k; cover = c; }
  }
  if (covering && s.len * (1 - cover) >= DUPE_TAIL_M) {
    tailKept += 1;
    kept.push(s);
    continue;
  }
  if (covering) dropped.push({ s, by: covering });
  else kept.push(s);
}

// --- 2. node ----------------------------------------------------------------

/** Where two segments cross, as a parameter along each. Null if they do not. */
function crossing(p1, p2, q1, q2) {
  const rx = p2[0] - p1[0], ry = p2[1] - p1[1];
  const sx = q2[0] - q1[0], sy = q2[1] - q1[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;            // parallel: nothing to cut
  const t = ((q1[0] - p1[0]) * sy - (q1[1] - p1[1]) * sx) / den;
  const u = ((q1[0] - p1[0]) * ry - (q1[1] - p1[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

const cuts = kept.map((s) => s.pts.map(() => []));
let intersections = 0;
for (let a = 0; a < kept.length; a += 1) {
  for (let b = a + 1; b < kept.length; b += 1) {
    const A = kept[a].pts, B = kept[b].pts;
    for (let i = 1; i < A.length; i += 1) {
      for (let j = 1; j < B.length; j += 1) {
        const hit = crossing(A[i - 1], A[i], B[j - 1], B[j]);
        if (!hit) continue;
        cuts[a][i].push(hit[0]);
        cuts[b][j].push(hit[1]);
        intersections += 1;
      }
    }
  }
}

const noded = kept.map((s, k) => {
  const out = [s.pts[0]];
  for (let i = 1; i < s.pts.length; i += 1) {
    const a = s.pts[i - 1], b = s.pts[i];
    const ts = [...new Set(cuts[k][i])].filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((x, y) => x - y);
    for (const t of ts) out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    out.push(b);
  }
  return out;
});

// --- 3. weld ----------------------------------------------------------------

const coord = [];
const buckets = new Map();
function nodeAt(p) {
  const gx = Math.round(p[0] / WELD_M), gy = Math.round(p[1] / WELD_M);
  // Neighbouring buckets too, or two points either side of a cell boundary
  // stay separate however close they are.
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const id of buckets.get(`${gx + dx},${gy + dy}`) ?? []) {
        if (dist(coord[id], p) <= WELD_M) return id;
      }
    }
  }
  const id = coord.length;
  coord.push(p);
  const key = `${gx},${gy}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(id);
  return id;
}

const edges = new Map();
const EK = (u, v) => (u < v ? `${u}-${v}` : `${v}-${u}`);

/**
 * Drawn width, carried per edge.
 *
 * The sheet gives every stroke a real ground width and this script has always
 * read it — and, until now, thrown it away. It is the difference between "two
 * lines 3.2 m apart" and "a 3.3 m footway inside a 6.6 m carriageway", which is
 * the whole question the collapse stage is trying to answer.
 */
const edgeW = new Map();
const addEdge = (u, v, w = 1) => {
  if (u === v) return;
  const key = EK(u, v);
  edges.set(key, [u, v]);
  edgeW.set(key, Math.max(edgeW.get(key) ?? 0, w));
};

/**
 * How close two centrelines have to be to be one corridor: close enough that
 * the strokes drawn on them overlap, which is half the sum of their widths.
 *
 * A flat 3 m was the old rule, justified by paths being 3.3 m wide — true of a
 * walkway, wrong for a 6.6 m driveway, whose own edge is 3.3 m from its centre.
 * The footway alongside the Portable Village runs 3.23 m from that driveway's
 * centreline: inside the carriageway it is drawn beside, dead parallel for 60 m,
 * and missing the old cutoff by 23 cm. It routed as two separate ways, so an
 * 11 m walk went 404 ft up one and back down the other.
 *
 * Never tighter than DUPE_M, so nothing that used to merge stops merging.
 */
const corridorTol = (w1, w2) => Math.min(TOL_CAP, Math.max(DUPE_M, (w1 + w2) / 2));

/** The widest stroke meeting at a node. */
const widthAt = (n, adj) => {
  let w = 1;
  for (const m of adj.get(n) ?? []) w = Math.max(w, edgeW.get(EK(n, m)) ?? 1);
  return w;
};

noded.forEach((pts, k) => {
  for (let i = 1; i < pts.length; i += 1) {
    addEdge(nodeAt(pts[i - 1]), nodeAt(pts[i]), kept[k].width);
  }
});

// --- 3b. collapse duplicate corridors ---------------------------------------
//
// The sheet draws ~857 m of corridor twice: a footway shadowing a driveway, a
// walkway drawn over itself, and — the loudest of the three — every bar of a
// zebra crossing as its own stroke, so one crossing becomes five parallel
// routes. Riding a centreline down each of those is what put three lines
// down one path on screen.
//
// Every one of these pairs sits closer than 3.3 m, and the paths themselves are
// 3.3 m wide, so nothing that close is a separate way — two lines inside one
// path's width are one path. That is what makes collapsing safe rather than a
// guess, and it is why the merged node goes at the MIDPOINT of the pair: the
// true centreline runs between the two strokes, not along either.
//
// Nodes are merged, never deleted, so no connection the drawing makes is lost.

const alias = coord.map((_, i) => i);
const find = (x) => { while (alias[x] !== x) { alias[x] = alias[alias[x]]; x = alias[x]; } return x; };

function merge(a, b, wa = 1, wb = 1) {
  const [x, y] = [find(a), find(b)];
  if (x === y) return;
  // Where the survivor lands. The midpoint is right for a walkway drawn over
  // itself — same width, and the true centreline does run between the two
  // strokes. It is wrong for a 3.3 m footway beside a 6.6 m carriageway: the
  // pedestrian line IS the footway, and averaging puts it in the road. So equal
  // widths keep the midpoint and unequal widths keep the narrower stroke, which
  // is the preference the dedupe stage already applies by kind.
  const t = Math.abs(wa - wb) <= 0.1 * Math.max(wa, wb) ? 0.5 : (wa < wb ? 0 : 1);
  coord[x] = [
    coord[x][0] + t * (coord[y][0] - coord[x][0]),
    coord[x][1] + t * (coord[y][1] - coord[x][1]),
  ];
  alias[y] = x;
}

/** Rewrite the edge set through the current aliases, dropping self-loops. */
function rebuild() {
  const next = new Map(), nextW = new Map();
  for (const [key, [u, v]] of edges) {
    const [a, b] = [find(u), find(v)];
    if (a === b) continue;
    const k = EK(a, b);
    next.set(k, [a, b]);
    // Widest wins when two edges collapse into one: a corridor is as wide as
    // the widest thing drawn down it.
    nextW.set(k, Math.max(nextW.get(k) ?? 0, edgeW.get(key) ?? 1));
  }
  edges.clear();
  edgeW.clear();
  for (const [k, e] of next) {
    edges.set(k, e);
    edgeW.set(k, nextW.get(k));
  }
}

let collapsed = 0;

/**
 * One run of the collapse to fixpoint.
 *
 * A function rather than a block because it is run twice: once here, and again
 * after the tee and junction stages. Those stages create junctions, and a
 * junction can expose a duplicate corridor that was invisible the first time —
 * two strokes down one path that did not touch until something joined them at
 * one end now visibly run together, and only the second run can see it.
 */
function collapsePasses() {
for (let pass = 0; pass < 8; pass += 1) {
  rebuild();
  const adj = new Map();
  for (const [u, v] of edges.values()) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  }

  const actions = [];
  for (const n of adj.keys()) {
    const p = coord[n];
    const mine = adj.get(n).map((m) => Math.atan2(coord[m][1] - p[1], coord[m][0] - p[0]));
    let best = null;
    for (const [key, [u, v]] of edges) {
      if (u === n || v === n) continue;
      const a = coord[u], b = coord[v];
      const theirs = Math.atan2(b[1] - a[1], b[0] - a[0]);
      // Only collapse onto something running the same way as this node's own
      // path. Without it a node welds onto a path merely passing nearby, which
      // is a junction the drawing does not make.
      if (!mine.some((o) => bearingGap(o, theirs) <= DUPE_ANGLE)) continue;
      const d = segDist(p, a, b);
      if (d > corridorTol(widthAt(n, adj), edgeW.get(key) ?? 1) || (best && d >= best.d)) continue;
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const L = vx * vx + vy * vy;
      const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
      best = { d, key, u, v, t, foot: [a[0] + t * vx, a[1] + t * vy] };
    }
    if (best) actions.push({ n, nw: widthAt(n, adj), ...best });
  }
  if (!actions.length) break;

  // Closest first: the most certain duplicates decide the shared line.
  actions.sort((x, y) => x.d - y.d);
  let applied = 0;
  for (const act of actions) {
    if (!edges.has(act.key)) continue;                 // already restructured
    const n = find(act.n), u = find(act.u), v = find(act.v);
    if (n === u || n === v) continue;
    const span = dist(coord[u], coord[v]);
    const nw = act.nw ?? 1, ew = edgeW.get(act.key) ?? 1;
    if (act.t * span < WELD_M) { merge(n, u, nw, ew); applied += 1; continue; }
    if ((1 - act.t) * span < WELD_M) { merge(n, v, nw, ew); applied += 1; continue; }
    const w = coord.length;
    coord.push(act.foot);
    alias.push(w);
    edges.delete(act.key);
    // The two halves inherit the width of the edge they were cut from.
    addEdge(u, w, ew);
    addEdge(w, v, ew);
    merge(n, w, nw, ew);
    applied += 1;
  }
  collapsed += applied;
  if (!applied) break;
}
rebuild();
}

collapsePasses();

// --- 3c. tee dead ends onto the stroke they stop short of --------------------
//
// The gap the other three steps leave. NODE cuts where two segments properly
// CROSS, so a stroke that *ends* on another never produces a cut — it does not
// cross it. WELD joins vertex to vertex, and there is no vertex to join to
// halfway along a line. COLLAPSE does project a node onto a segment, but only
// one running the same way (bearingGap <= DUPE_ANGLE), because it exists to
// merge duplicate corridors — which excludes the perpendicular T-junction
// exactly.
//
// So a footway drawn up to a walkway and stopping half a metre short of it was
// a junction on paper and nothing at all in the graph. That is what left 31
// fragments and 143 nodes stranded, and it is why the map showed paths ending
// in the middle of a car park with a round cap.
//
// This is not the bridging step the header rules out. It invents no path: it
// splits an edge that already exists at the point the dead end is already
// touching, and moves that dead end up to TEE_M onto it. Measured over the
// whole sheet, total drawn length across every component moves 13,932 -> 13,949
// m (+0.12%), while the length reachable in the largest component goes
// 11,687 -> 12,591 m. 904 m of already-drawn path stops being thrown away, for
// 17 m of displacement.
//
// TEE_M is where that trade turns. Below it fewer fragments come back; above
// it, at 5 and 8 m, the largest component starts LOSING nodes and by 8 m total
// drawn length falls, because dead ends begin merging onto paths they only pass
// near. 3 m recovers the most and destroys nothing.
//
// Degree-1 nodes only. Projecting an interior vertex would manufacture
// junctions mid-path rather than repair one the drawing makes.

let teed = 0;
for (let pass = 0; pass < 12; pass += 1) {
  rebuild();
  const adj = new Map();
  for (const [u, v] of edges.values()) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  }

  const actions = [];
  for (const [n, neighbours] of adj) {
    if (neighbours.length !== 1) continue;
    const p = coord[n];
    let best = null;
    for (const [key, [u, v]] of edges) {
      if (u === n || v === n) continue;
      const a = coord[u], b = coord[v];
      const d = segDist(p, a, b);
      if (d > TEE_M || (best && d >= best.d)) continue;
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const L = vx * vx + vy * vy;
      const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
      best = { d, key, u, v, t, foot: [a[0] + t * vx, a[1] + t * vy] };
    }
    if (best) actions.push({ n, ...best });
  }
  if (!actions.length) break;

  // Closest first, as in the collapse pass: the least ambiguous joins get to
  // decide the shape of the junction before the marginal ones see it.
  actions.sort((x, y) => x.d - y.d);
  let applied = 0;
  for (const act of actions) {
    if (!edges.has(act.key)) continue;                 // already restructured
    const n = find(act.n), u = find(act.u), v = find(act.v);
    if (n === u || n === v) continue;
    const span = dist(coord[u], coord[v]);
    // Landing near either end is a weld, not a tee — splitting there would
    // leave a sub-centimetre edge the router has to carry forever.
    if (act.t * span < WELD_M) { merge(n, u); applied += 1; continue; }
    if ((1 - act.t) * span < WELD_M) { merge(n, v); applied += 1; continue; }
    const w = coord.length;
    const ew = edgeW.get(act.key) ?? 1;
    coord.push(act.foot);
    alias.push(w);
    edges.delete(act.key);
    addEdge(u, w, ew);
    addEdge(w, v, ew);
    // Midpoint on purpose: a tee is a junction being repaired, not a duplicate
    // corridor being chosen between, so neither stroke should win outright.
    merge(n, w);
    applied += 1;
  }
  teed += applied;
  if (!applied) break;
}
rebuild();

// --- 3d. weld near-miss junctions --------------------------------------------
//
// The last case the extraction misses, and the one that produced the worst
// detours on the map: two lines that pass within a metre or three of each other
// and never join. Not a crossing, so NODE cuts nothing. No shared vertex, so
// WELD has nothing to join. Neither end is loose, so TEE — which only fires on
// degree-1 nodes — skips it. Not parallel, so COLLAPSE, which is gated on
// bearing because it exists to merge duplicate corridors, excludes it.
//
// It looks like a junction on paper and is not one in the graph. A footway
// reaching a walkway and stopping 3 m short left an 11 m walk routing 140 ft,
// and the same shape appears wherever the draughtsman drew two ways meeting
// without snapping them.
//
// The detour test is what keeps this honest, and it is not optional. Two paths
// CAN legitimately pass close without meeting — a ramp beside the stair it
// serves, a path over a culvert. So a junction is only welded where the graph
// already makes you walk JUNCTION_RATIO times further to get across than the
// ground distance. Where the two are already effectively joined, nothing is
// done. This adds a node; it never adds a metre of path.
//
// Written down before it was believed: the first version of this repair was a
// set of hand-added straight connectors, and 11 of the 15 turned out to run
// PARALLEL to a path my campus already draws. The gap was never a missing path — it
// was a drawn path that failed to join the graph. Those links are gone.

function junctionDistances(from, cap) {
  const adj = new Map();
  for (const [u, v] of edges.values()) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  }
  const dist = new Map([[from, 0]]);
  const heap = [[0, from]];
  while (heap.length) {
    heap.sort((a, b) => a[0] - b[0]);
    const [dv, u] = heap.shift();
    if (dv > (dist.get(u) ?? Infinity) || dv > cap) continue;
    for (const m of adj.get(u) ?? []) {
      const nd = dv + dist2(coord[u], coord[m]);
      if (nd < (dist.get(m) ?? Infinity)) { dist.set(m, nd); heap.push([nd, m]); }
    }
  }
  return dist;
}
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

let welded = 0;
for (let pass = 0; pass < 8; pass += 1) {
  rebuild();
  const nodes = new Set();
  for (const [u, v] of edges.values()) { nodes.add(u); nodes.add(v); }

  const actions = [];
  for (const n of nodes) {
    const p = coord[n];
    let best = null;
    for (const [key, [u, v]] of edges) {
      if (u === n || v === n) continue;
      const d = segDist(p, coord[u], coord[v]);
      if (d > JUNCTION_M || (best && d >= best.d)) continue;
      const a = coord[u], b = coord[v];
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const L = vx * vx + vy * vy;
      const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
      best = { d, key, u, v, t, foot: [a[0] + t * vx, a[1] + t * vy] };
    }
    if (!best) continue;
    // The guard: only weld where the graph really does send you the long way.
    const reach = junctionDistances(n, JUNCTION_RATIO * Math.max(best.d, 1) + 1);
    const around = Math.min(reach.get(best.u) ?? Infinity, reach.get(best.v) ?? Infinity);
    if (around <= JUNCTION_RATIO * Math.max(best.d, 1)) continue;
    actions.push({ n, around, ...best });
  }
  if (!actions.length) break;

  actions.sort((x, y) => x.d - y.d);
  let applied = 0;
  for (const act of actions) {
    if (!edges.has(act.key)) continue;
    const n = find(act.n), u = find(act.u), v = find(act.v);
    if (n === u || n === v) continue;
    const span = dist(coord[u], coord[v]);
    const ew = edgeW.get(act.key) ?? 1;
    // Equal widths on purpose: this is a junction being repaired, not a choice
    // between two corridors, so the node lands midway rather than snapping onto
    // whichever stroke happens to be wider.
    if (act.t * span < WELD_M) { merge(n, u); applied += 1; continue; }
    if ((1 - act.t) * span < WELD_M) { merge(n, v); applied += 1; continue; }
    const w = coord.length;
    coord.push(act.foot);
    alias.push(w);
    edges.delete(act.key);
    addEdge(u, w, ew);
    addEdge(w, v, ew);
    merge(n, w);
    applied += 1;
  }
  welded += applied;
  if (!applied) break;
}
rebuild();

// Junctions just made can reveal corridors drawn twice that were invisible
// while the two strokes were unconnected. Cheap, and it converges immediately.
collapsePasses();

// --- 3e. hand-added links ----------------------------------------------------
//
// The one stage that is not the drawing. Everything above is my campus's linework
// taken verbatim; src/path-links.json is where a connection the sheet omits
// gets added by hand, and it is a separate file precisely so the invented share
// stays countable — the log line below prints it every build.
//
// This is not the bridging step the header rules out. That version generated 42
// connectors automatically wherever two fragments happened to be near each
// other, which is a guess made 42 times. These are individually written down,
// each with a `why` naming what is on the ground and what the sheet drew
// instead, and each one is a connection visible in aerial imagery.
//
// Endpoints attach to what is already there rather than creating new nodes: a
// link whose end lands 30 cm from an existing junction has to BE that junction,
// or it adds a parallel node the router can reach only through the link itself.

function attach(p) {
  let node = null, best = WELD_M;
  for (let id = 0; id < coord.length; id += 1) {
    const d = dist(coord[find(id)], p);
    if (d <= best) { best = d; node = find(id); }
  }
  if (node !== null) return node;

  // Nothing to weld to, so tee onto the nearest edge instead — the same repair
  // step 3c makes, for the same reason.
  let edge = null;
  for (const [key, [u, v]] of edges) {
    const d = segDist(p, coord[u], coord[v]);
    if (d <= TEE_M && (!edge || d < edge.d)) {
      const a = coord[u], b = coord[v];
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const L = vx * vx + vy * vy;
      const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
      edge = { d, key, u, v, foot: [a[0] + t * vx, a[1] + t * vy] };
    }
  }
  if (edge) {
    const w = coord.length;
    const ew = edgeW.get(edge.key) ?? 1;
    coord.push(edge.foot);
    alias.push(w);
    edges.delete(edge.key);
    addEdge(edge.u, w, ew);
    addEdge(w, edge.v, ew);
    return w;
  }

  // Free end. Legitimate for the far side of a link, but worth saying out loud:
  // a link with both ends free is its own island and will be pruned.
  const id = coord.length;
  coord.push(p);
  alias.push(id);
  return id;
}

let linkCount = 0, linkMetres = 0;
{
  const file = src('path-links.json');
  const links = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')).features ?? []
    : [];
  for (const link of links) {
    if (link.geometry?.type !== 'LineString') continue;
    const pts = link.geometry.coordinates.map(flat);
    if (pts.length < 2) continue;
    let prev = attach(pts[0]);
    for (let i = 1; i < pts.length; i += 1) {
      const next = attach(pts[i]);
      addEdge(find(prev), find(next));
      linkMetres += dist(coord[find(prev)], coord[find(next)]);
      prev = next;
    }
    linkCount += 1;
  }
  rebuild();
}

function components() {
  const adj = new Map();
  for (const [u, v] of edges.values()) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  }
  const seen = new Set();
  const out = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    const c = [];
    while (stack.length) {
      const n = stack.pop();
      c.push(n);
      for (const m of adj.get(n)) if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
    out.push(c);
  }
  return out.sort((a, b) => b.length - a.length);
}

// Fragments go before anything is spliced onto them: splicing first strands a
// destination whose nearest edge is in a piece that is then dropped.
const fragments = components().slice(1);
{
  const main = new Set(components()[0]);
  for (const [key, [u, v]] of [...edges]) {
    if (!main.has(u) || !main.has(v)) edges.delete(key);
  }
}

// --- 4. splice destinations -------------------------------------------------

function spliceOnto(p) {
  let best = null;
  for (const [key, [u, v]] of edges) {
    const a = coord[u], b = coord[v];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L = vx * vx + vy * vy;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
    const foot = [a[0] + t * vx, a[1] + t * vy];
    const d = dist(p, foot);
    if (!best || d < best.d) best = { d, key, u, v, t, foot };
  }
  if (!best || best.d > SPLICE_M) return null;
  const span = dist(coord[best.u], coord[best.v]);
  // Already effectively a node: reuse rather than leaving a zero-length stub.
  if (best.t * span < WELD_M) return best.u;
  if ((1 - best.t) * span < WELD_M) return best.v;
  const id = coord.length;
  const ew = edgeW.get(best.key) ?? 1;
  coord.push(best.foot);
  edges.delete(best.key);
  addEdge(best.u, id, ew);
  addEdge(id, best.v, ew);
  return id;
}

let spliced = 0;
for (const place of places) {
  if (place.geometry?.type !== 'Point') continue;
  if (spliceOnto(flat(place.geometry.coordinates)) !== null) spliced += 1;
}

// --- ship -------------------------------------------------------------------

const keep = new Set(components()[0]);
const renumber = new Map();
[...keep].sort((a, b) => a - b).forEach((id) => renumber.set(id, renumber.size + 1));

const features = [];
for (const [u, v] of edges.values()) {
  if (!keep.has(u) || !keep.has(v)) continue;
  const a = unflat(coord[u]);
  const b = unflat(coord[v]);
  if (a[0] === b[0] && a[1] === b[1]) continue;      // collapsed by rounding
  features.push({
    type: 'Feature',
    properties: { from: renumber.get(u), to: renumber.get(v) },
    geometry: { type: 'LineString', coordinates: [a, b] },
  });
}
features.sort((x, y) => x.properties.from - y.properties.from || x.properties.to - y.properties.to);

writeFileSync(src('paths.json'), `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const metres = features.reduce((s, f) => {
  const [a, b] = f.geometry.coordinates.map(flat);
  return s + dist(a, b);
}, 0);
const byKind = (list) => Object.entries(list.reduce((acc, s) => {
  acc[s.kind] = (acc[s.kind] ?? 0) + 1;
  return acc;
}, {})).map(([k, n]) => `${k} ${n}`).join(', ');

console.log(`[walk-network] ${strokes.length} drawn strokes taken verbatim (${byKind(strokes)})`);
console.log(`[walk-network] ${dropped.length} dropped as duplicates (${byKind(dropped.map((d) => d.s))})`);
console.log(`[walk-network] ${tailKept} kept despite being mostly shadowed — an uncovered tail over ${DUPE_TAIL_M} m`);
for (const { s, by } of dropped.slice(0, 6)) {
  console.log(`[walk-network]    ${s.kind} ${Math.round(s.len)} m covered by ${by.kind} ${Math.round(by.len)} m`);
}
if (dropped.length > 6) console.log(`[walk-network]    ...and ${dropped.length - 6} more`);
console.log(`[walk-network] ${kept.length} kept, ${intersections} crossings noded, welded at ${WELD_M} m`);
console.log(`[walk-network] ${collapsed} nodes collapsed onto a duplicate corridor `
  + `(tolerance = half the sum of the two drawn widths, min ${DUPE_M} m)`);
console.log(`[walk-network] ${teed} dead ends teed onto the stroke they stopped short of within ${TEE_M} m`);
console.log(`[walk-network] ${welded} near-miss junctions welded within ${JUNCTION_M} m (only where the graph made you walk ${JUNCTION_RATIO}x further around)`);
console.log(`[walk-network] ${linkCount} hand-added link(s) from path-links.json, ${Math.round(linkMetres)} m — the only path here the sheet does not draw`);
console.log(`[walk-network] no bridges invented; ${fragments.length} fragments left disconnected `
  + `(${fragments.reduce((n, c) => n + c.length, 0)} nodes)`);
console.log(`[walk-network] ${spliced} destinations spliced in`);
console.log(`[walk-network] ${renumber.size} nodes, ${features.length} segments, ${Math.round(metres)} m -> src/paths.json`);

// CAMPUS_BOUNDS in src/main.js is this box. A network that grows past the old
// one leaves part of itself outside the initial view.
const all = features.flatMap((f) => f.geometry.coordinates);
const box = [
  Math.min(...all.map((c) => c[0])), Math.min(...all.map((c) => c[1])),
  Math.max(...all.map((c) => c[0])), Math.max(...all.map((c) => c[1])),
];
console.log(`[walk-network] CAMPUS_BOUNDS [[${box[0]}, ${box[1]}], [${box[2]}, ${box[3]}]]`);
