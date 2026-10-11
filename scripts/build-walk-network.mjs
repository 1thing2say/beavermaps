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
 * is never in doubt. Today it is 9 links and 151 m out of 13.6 km — 1.1%. The
 * junction stage below adds the only other undrawn metres, a handful of
 * connectors a few metres long, and so do the walls with two more where a
 * building is drawn over a junction; their counts and metres print too.
 *
 * WHERE THE DATA COMES FROM. On the sheet a walkway is a stroked path carrying
 * a real ground width, so the stroke IS the centreline: 103 walkways, 25
 * driveways, all in #e2e3e4, plus 30 crossings. One of the driveways is the
 * turning circle by Printing Services, drawn as a stroked ring rather than a line
 * and read as one (see strokeLines()). src/basemap.json already holds them
 * element for element with their widths and the cartographer's own layer,
 * which is why this script needs nothing from campus-data/ and runs from a bare
 * clone. It reads four more committed files beside it: places.json, for the
 * destinations SPLICE gives a node; path-links.json, for LINK; and
 * buildings.json and labels.json, which together name the buildings SPLICE
 * puts a node beside where their walls come nearest — grouped and named as
 * build-directory.mjs groups them, so the two agree on what a building is. So
 * after a change to the footprints or the labels, run build-buildings.mjs and
 * build-labels.mjs first; and after this, build-directory.mjs, build-lamps.mjs
 * and build-approach-network.mjs, which read what it writes.
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
 *   3. WELD. Vertices within WELD_M become one node — the nearest one, not the
 *      first found. This is not invention: it is recognising that a
 *      draughtsman's "touching" endpoints land a metre or two apart.
 *   3b. COLLAPSE. A node lying inside another stroke's corridor, running the
 *      same way, is merged onto it: the second drawing of a corridor the
 *      dedupe step could not drop whole. Never onto the node's own stroke —
 *      the next stretch of one's own line is not a duplicate of it, and
 *      treating it as one is what used to fold every drawn curve into chords.
 *      Run again after JUNCTION, which can expose duplicates.
 *   3c. WALLS. Every building is painted over the walkways and driveways
 *      under it, and the sheet leans on it: approach strokes run past the wall
 *      for the fill to cover.
 *      What lies under a roof is cut at the wall — all of it where it only
 *      leads inside, and a passage right through only where the way round is
 *      short. A loose end under a roof that was drawn to meet a path beyond
 *      the far wall is joined to it first, by the junction stage's own test,
 *      rather than peeled. Run again after JUNCTION, against the whole graph.
 *   4. TEE. A stroke that ENDS on another is a junction NODE cannot see — it
 *      does not cross, it stops — and WELD has no vertex there to join to.
 *      Dead ends within TEE_M of another stroke are teed onto it. The dead
 *      end moves; the line it meets stays exactly where it is drawn.
 *   5. JUNCTION. Two lines passing within a few metres and never joining is a
 *      junction on paper and nothing in the graph, and none of the four
 *      joining stages above sees it: it is not a crossing, shares no vertex,
 *      has no loose end and is not parallel. Joined only where the graph
 *      already makes you walk JUNCTION_RATIO times further around, so paths
 *      that legitimately pass close without meeting are left alone. Neither
 *      line is moved more than a weld: a wider gap gets a short connector,
 *      at most JUNCTION_M long, and those are counted and printed alongside
 *      the links.
 *   6. LINK. Apply src/path-links.json, the hand-added connectors above.
 *   7. SPLICE. The router only accepts vertices, so every positioned
 *      destination gets a node at its closest point on the network. Without it
 *      a path can run straight past a building while the nearest vertex is
 *      fifty metres up the way, and the destination quietly resolves elsewhere.
 *      A room closer to an approach path WALLS peeled off under its roof than
 *      to anything left is the exception: it resolves to the door that path
 *      left, recorded in src/doors.json for the router to do the same. Every
 *      building also gets a node wherever its walls come nearest the
 *      network, which build-directory.mjs lists among its ways in.
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
import { adoptPrintedNames, groupByName, loadFootprints, wallNearest } from './building-names.mjs';

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

/**
 * The centrelines a feature draws, or none.
 *
 * Almost every path on the sheet is a stroked LineString. One is not: the
 * turning circle by Printing Services is a driveway drawn as a stroked,
 * UNFILLED Polygon — a closed ring of 24 chords, 13.8 m radius,
 * carrying the same pavement grey and the same 6.6 m width as the driveways
 * that meet it. On paper it is one more stroke; this loop used to take
 * LineStrings only, so the circle never entered the graph at all, and two hand
 * links in path-links.json stood in for it as straight chords across the
 * planted island while the south arm dead-ended on the ring.
 *
 * A polygon is linework here only when it is drawn exactly like the
 * LineStrings are: a walkway or driveway, stroked in PAVEMENT, with no fill.
 * Every one of those conditions is doing work. A FILL makes it an area — the
 * plazas and aprons the sheet paints in pavement grey or white are surfaces,
 * not centrelines, and riding their outline would invent a path round the edge
 * of every plaza. Buildings, car parks, courts and the rest are other kinds
 * and never get this far, whatever their stroke. Crossing polygons are the
 * zebra bars themselves, filled and unstroked. On today's sheet the rule
 * admits exactly one feature, the circle.
 *
 * Each ring of a qualifying polygon is its own stroke, because a stroked
 * polygon draws every ring. No densifying: the sheet draws the circle as those
 * 24 chords, a vertex every 3.6 m, and the shipped edges are the same chords —
 * 12 cm inside the true circle at their middles and on the drawing exactly,
 * except the one vertex the south arm's end welds to, which sits 1.4 m out on
 * that arm, inside the ring's 6.6 m band. Read this way, all four arms meet the
 * ring through the ordinary stages below (north and south by weld, west
 * and north-east through junction connectors of 5.0 and 3.3 m), the south arm
 * stops being a dead end, and both hand-drawn chords are deleted. Within 25 m
 * of the circle, network more than 1 m off a drawn centreline goes 15.5 ->
 * 4.4 m, and the drawn ring with network within a metre of it 19 -> 86 m of 87.
 */
function strokeLines(f) {
  const { kind, stroke, fill } = f.properties;
  if (f.geometry.type === 'LineString') return [f.geometry.coordinates];
  if (f.geometry.type !== 'Polygon') return [];
  if (kind === 'crossing' || stroke !== PAVEMENT || fill !== undefined) return [];
  return f.geometry.coordinates;
}

const strokes = [];
for (const f of basemap) {
  const { kind, stroke, width } = f.properties;
  if (!(kind in KIND_RANK)) continue;
  // Crossings are drawn darker than the rest and are kept regardless: they are
  // short, and they are how a footway gets to the other side of a road.
  if (kind !== 'crossing' && stroke !== PAVEMENT) continue;
  for (const line of strokeLines(f)) {
    // A ring repeats its first vertex last; the weld stage turns that into a
    // loop, which is what the drawing is.
    const pts = line.map(flat);
    if (pts.length < 2) continue;
    const len = pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);
    if (len <= 0) continue;
    // `i` is the stroke's place in the sheet's painter's order — what decides,
    // further down, which buildings are painted over it.
    strokes.push({ pts, len, kind, width: width ?? 1, rank: KIND_RANK[kind], i: f.properties.i });
  }
}

// --- the buildings the print paints over them --------------------------------
//
// Every building and closed-off area on the sheet is a filled polygon, and in
// the print all of them are painted after every walkway and all but one
// driveway (sheet order 1950-2080 against 1078-1440): where a stroke runs under
// one, the building hides it. The cartographer leans on that. Approach paths are drawn
// a few metres past the wall and left for the building fill to cover; a walkway
// that predates a building still runs straight through it under the roof. None
// of that is path anyone can see on the sheet, and the walls stage below keeps
// it out of the graph. Crossings are the exception that proves the rule: they
// are painted last of all (2324 and up), over everything, so they are never
// hidden — the comparison is on painter's order, not on kind. The one driveway
// that breaks the "all but" is the same story: a 70 m stretch in the north-east
// of campus, i=3116 in layer 20, painted long after every building. No
// footprint lies anywhere along it today, so nothing hides it; if one ever
// did, the painter's-order test would rightly leave it on top, as the print does.

const FOOTPRINTS = basemap
  .filter((f) => f.properties.kind === 'building' || f.properties.kind === 'closed')
  .flatMap((f) => {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.map((rings) => {
      const flatRings = rings.map((r) => r.map(flat));
      const xs = flatRings[0].map((p) => p[0]), ys = flatRings[0].map((p) => p[1]);
      return {
        i: f.properties.i,
        // As drawn, for src/doors.json: the server and build-directory test a
        // destination against the very shape the door was recorded on.
        lonLat: rings,
        rings: flatRings,
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      };
    });
  });

const inRing = (p, ring) => {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a, a += 1) {
    const [xa, ya] = ring[a], [xb, yb] = ring[b];
    if ((ya > p[1]) !== (yb > p[1]) && p[0] < ((xb - xa) * (p[1] - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
};
/** Inside the footprint's outer ring and outside any courtyard in it. */
const inFootprint = (p, F) => p[0] >= F.box[0] && p[0] <= F.box[2] && p[1] >= F.box[1] && p[1] <= F.box[3]
  && inRing(p, F.rings[0]) && !F.rings.slice(1).some((r) => inRing(p, r));
const boxMeets = (F, a, b) => Math.max(a[0], b[0]) >= F.box[0] && Math.min(a[0], b[0]) <= F.box[2]
  && Math.max(a[1], b[1]) >= F.box[1] && Math.min(a[1], b[1]) <= F.box[3];
const inAnyFootprint = (p) => FOOTPRINTS.some((F) => inFootprint(p, F));

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
  // The NEAREST node within WELD_M, not the first one found. Where a dense
  // curve puts two existing nodes inside the radius, "first" is whichever the
  // bucket scan happened to reach, and a vertex 0.2 m from one node could be
  // welded to another 1.9 m away — dragging every edge on it most of a weld
  // sideways for no reason but iteration order.
  //
  // Neighbouring buckets too, or two points either side of a cell boundary
  // stay separate however close they are.
  let near = -1, nearD = Infinity;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const id of buckets.get(`${gx + dx},${gy + dy}`) ?? []) {
        const d = dist(coord[id], p);
        if (d > WELD_M) continue;
        // Ties go to the lower id, so the result never depends on bucket order.
        if (d < nearD || (d === nearD && id < near)) { near = id; nearD = d; }
      }
    }
  }
  if (near >= 0) return near;
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

/**
 * Which drawn strokes each edge and each node came from, as indices into
 * `kept`.
 *
 * The collapse stage asks "is this node sitting on a SECOND drawing of its own
 * corridor?", and without provenance it cannot tell a second drawing from the
 * next stretch of the node's own line. On a curve drawn with vertices 2-3 m
 * apart, the segment two vertices further along IS within a corridor width and
 * DOES run the same way, so every bend on the sheet looked like a duplicate of
 * itself. See the guard in collapsePasses() for what that did.
 *
 * Edges carry the strokes drawn down them; nodes carry every stroke any vertex
 * merged into them came from, so a node that has joined a second corridor knows
 * it is now on both. Split halves inherit their parent edge's set. A hand-added
 * link carries none, because no stroke draws it.
 */
const edgeS = new Map();
const nodeS = [];
const strokesAt = (n) => (nodeS[n] ??= new Set());
const addEdge = (u, v, w = 1, strokes = []) => {
  if (u === v) return;
  const key = EK(u, v);
  edges.set(key, [u, v]);
  edgeW.set(key, Math.max(edgeW.get(key) ?? 0, w));
  if (!edgeS.has(key)) edgeS.set(key, new Set());
  for (const s of strokes) {
    edgeS.get(key).add(s);
    strokesAt(u).add(s);
    strokesAt(v).add(s);
  }
};
const shareStroke = (a, b) => {
  for (const s of a) if (b.has(s)) return true;
  return false;
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
    addEdge(nodeAt(pts[i - 1]), nodeAt(pts[i]), kept[k].width, [k]);
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
//
// "Pairs" is the operative word, and for a long time the code did not enforce
// it. It tested every node against every edge not touching it, and on a curve
// drawn with vertices 2-3 m apart the segment two vertices along the node's OWN
// stroke is inside a corridor width and runs the same way — so 391 of the 455
// merges this stage made were a stroke collapsing onto itself. Each one moved a
// vertex to the midpoint of a chord; chains of them walked nodes round bends;
// curves shipped as straight lines up to 23 m from where the sheet draws them,
// and 2.8 km of the 13.6 km network ran more than a metre off any drawn stroke.
// Two rules now hold it to what it is for: a node never collapses onto a stroke
// it is already on (edgeS/nodeS above), and every queued merge is re-measured
// against live coordinates before it is applied. Measured on the same sheet:
// under a hundred merges instead of 455; network more than 1 m off the drawing
// 2,792 -> 1,003 m, more than 5 m off 272 -> 36 m (all of that hand links),
// before the tee and junction stages stopped moving lines too (see anchor());
// and the parallel duplicates this stage exists to remove do not come back —
// side-by-side, parallel edges within 2 m of each other total 16.5 m against
// 17.1 m under the old rule, and none of them overlaps another for more than
// 5 m.

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
  let t = Math.abs(wa - wb) <= 0.1 * Math.max(wa, wb) ? 0.5 : (wa < wb ? 0 : 1);
  const at = (s) => [
    coord[x][0] + s * (coord[y][0] - coord[x][0]),
    coord[x][1] + s * (coord[y][1] - coord[x][1]),
  ];
  // Never INTO a building. Two strokes hugging a wall from either side of a
  // corner can have their midpoint under the roof, and a node put there drags
  // every edge on it through the wall — the build itself manufacturing the
  // in-building path the walls stage below exists to remove. If either drawn
  // position is outside, the survivor takes the one nearer where it was going.
  // It does not fire on today's sheet — the merges that used to land under
  // roofs went with the collapse fixes above — and is here so a data change
  // cannot quietly bring one back.
  if (inAnyFootprint(at(t))) {
    const outside = [0, 1].filter((s) => !inAnyFootprint(at(s)));
    if (outside.length) t = outside.reduce((best, s) => (Math.abs(s - t) < Math.abs(best - t) ? s : best));
  }
  coord[x] = at(t);
  alias[y] = x;
  for (const s of strokesAt(y)) strokesAt(x).add(s);
}

/** Rewrite the edge set through the current aliases, dropping self-loops. */
function rebuild() {
  const next = new Map(), nextW = new Map(), nextS = new Map();
  for (const [key, [u, v]] of edges) {
    const [a, b] = [find(u), find(v)];
    if (a === b) continue;
    const k = EK(a, b);
    next.set(k, [a, b]);
    // Widest wins when two edges collapse into one: a corridor is as wide as
    // the widest thing drawn down it.
    nextW.set(k, Math.max(nextW.get(k) ?? 0, edgeW.get(key) ?? 1));
    // ...and it is every stroke drawn down it.
    if (!nextS.has(k)) nextS.set(k, new Set());
    for (const s of edgeS.get(key) ?? []) nextS.get(k).add(s);
  }
  edges.clear();
  edgeW.clear();
  edgeS.clear();
  for (const [k, e] of next) {
    edges.set(k, e);
    edgeW.set(k, nextW.get(k));
    edgeS.set(k, nextS.get(k));
  }
}

/** Where p falls on segment a-b: distance, clamped parameter and foot point. */
function project(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
  const foot = [a[0] + t * vx, a[1] + t * vy];
  return { d: dist(p, foot), t, foot };
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
      // Never onto the node's OWN line. The test below — near, and running the
      // same way — is meant to find a second drawing of this corridor, but the
      // next-but-one segment of this node's own stroke passes it too wherever
      // the stroke bends: vertices 2-3 m apart round a curve are inside a
      // corridor width of each other and run the same way by construction.
      // Without this guard 391 of the 455 "duplicate corridor" merges were a
      // stroke merging with itself. Each one dragged a vertex to the midpoint
      // of a chord, a chain of them walked a node round the bend, and curves
      // came out as straight lines cutting across lawn, up to 23 m from where
      // the sheet draws them. A second drawing of a corridor is by definition
      // a different stroke — a zebra bar, a walkway drawn twice, a footway
      // beside its driveway — so excluding the node's own strokes loses none
      // of the duplicates this stage exists for.
      if (shareStroke(edgeS.get(key) ?? [], strokesAt(n))) continue;
      const a = coord[u], b = coord[v];
      const theirs = Math.atan2(b[1] - a[1], b[0] - a[0]);
      // Only collapse onto something running the same way as this node's own
      // path. Without it a node welds onto a path merely passing nearby, which
      // is a junction the drawing does not make.
      if (!mine.some((o) => bearingGap(o, theirs) <= DUPE_ANGLE)) continue;
      const d = segDist(p, a, b);
      if (d > corridorTol(widthAt(n, adj), edgeW.get(key) ?? 1) || (best && d >= best.d)) continue;
      best = { d, key, u, v };
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
    if (n === u || n === v || u === v) continue;
    // Everything below is measured NOW, not when the action was queued. Every
    // merge earlier in this loop moves a node — to a midpoint, or onto another
    // line — and re-aliases others, so by the time an action comes up its
    // node may have drifted metres from the edge it was queued against, or
    // been merged into a node that already lies on that edge's stroke. The old
    // loop trusted the queued numbers and so merged nodes up to 19.4 m apart,
    // against a tolerance that never exceeds 5; the drift compounded over
    // eight passes. A stale action is not wrong, only out of date, so it is
    // dropped and the next pass re-derives it from where things actually are.
    const ew = edgeW.get(act.key) ?? 1, es = edgeS.get(act.key) ?? new Set();
    if (shareStroke(es, strokesAt(n))) continue;
    const live = project(coord[n], coord[u], coord[v]);
    const nw = act.nw ?? 1;
    if (live.d > corridorTol(nw, ew)) continue;
    const span = dist(coord[u], coord[v]);
    if (live.t * span < WELD_M) { merge(n, u, nw, ew); applied += 1; continue; }
    if ((1 - live.t) * span < WELD_M) { merge(n, v, nw, ew); applied += 1; continue; }
    const w = coord.length;
    coord.push(live.foot);
    alias.push(w);
    edges.delete(act.key);
    // The two halves inherit the width and strokes of the edge they were cut from.
    addEdge(u, w, ew, es);
    addEdge(w, v, ew, es);
    merge(n, w, nw, ew);
    applied += 1;
  }
  collapsed += applied;
  if (!applied) break;
}
rebuild();
}

collapsePasses();

/**
 * Merge `loose` into `fixed` without moving `fixed` at all.
 *
 * merge() is for two drawings of ONE corridor, where the truth lies between
 * them. Tee and junction are a different question — two DIFFERENT paths that
 * meet — and there the line being met is drawn exactly where it is. Averaging
 * the two dragged a straight through-path sideways toward every side path that
 * stopped short of it: half the gap, up to 3 m at a junction, and each kink
 * pulled the edges either side of it off the stroke too. Measured on this sheet
 * that was most of the non-link network still more than 2 m off the drawing —
 * the whole stadium-side cluster of strokes 1270/1311/1313 sat about 2 m
 * beside its own grey band for 290 m.
 */
function anchor(fixed, loose) {
  const [x, y] = [find(fixed), find(loose)];
  if (x === y) return;
  alias[y] = x;
  for (const s of strokesAt(y)) strokesAt(x).add(s);
}

/**
 * The node on a queued action's edge that `n` should join: an end of the edge
 * when the closest point is within a weld of it, otherwise a new node cut into
 * the edge at the closest point. Null when the action has gone stale.
 *
 * Measured from live coordinates, as in the collapse stage, and for the same
 * reason: earlier joins in the same pass move nodes and re-alias others. The
 * cut sits ON the drawn segment, so cutting it moves nothing.
 */
function landOnLine(act, tol) {
  if (!edges.has(act.key)) return null;               // already restructured
  const n = find(act.n), u = find(act.u), v = find(act.v);
  if (n === u || n === v || u === v) return null;
  const live = project(coord[n], coord[u], coord[v]);
  if (live.d > tol) return null;
  const span = dist(coord[u], coord[v]);
  // Landing near either end is a weld, not a cut — splitting there would leave
  // a sub-centimetre edge the router has to carry forever.
  if (live.t * span < WELD_M) return { n, at: u, d: live.d };
  if ((1 - live.t) * span < WELD_M) return { n, at: v, d: live.d };
  const w = coord.length;
  const ew = edgeW.get(act.key) ?? 1, es = edgeS.get(act.key);
  coord.push(live.foot);
  alias.push(w);
  edges.delete(act.key);
  addEdge(u, w, ew, es);
  addEdge(w, v, ew, es);
  return { n, at: w, d: live.d };
}

// --- 3c. cut at the walls ------------------------------------------------------
//
// The sheet draws a good deal of path nobody can see. Every building on it is
// painted after every walkway and every driveway it stands on (see FOOTPRINTS
// for the one driveway painted later, which no building touches), and the
// cartographer leans on that:
// approach paths run a few metres past the wall for the fill to cover, two
// strokes meet somewhere under a roof, a walkway runs straight through a
// corner. Read verbatim, all of it became network — 314 m inside 26
// footprints, 35 of the 60 dead ends somewhere inside a building, the deepest
// 13 m into the Parking Garage — and on screen, a path ribbon walking through
// walls. The print never shows a metre of it.
//
// So every edge is cut where it crosses the wall of a footprint painted over
// it — later in the sheet than every stroke drawn down the edge, which is why
// the zebra crossings, painted last of all, are never touched — and what lies
// under the roof is one of two things:
//
//   - A STUB, leading nowhere but into the building. It is peeled back a loose
//     end at a time, so a stub drawn as several segments, or two stubs meeting
//     under the roof, go together and stop exactly on the wall. That is where
//     the door is, so the wall node stays, and it is written down as the
//     building's door (see DOORS): a room the stub used to reach goes there,
//     in SPLICE and in the router, and build-directory makes it the entrance.
//   - A PASSAGE, joining the outside at two or more points. Whether it stays is
//     a question of whether anyone needs it, and it is answered with the
//     junction stage's own test: kept where the way round is more than
//     PASS_RATIO times the way through, or where there is no way round at all
//     and cutting it would strand drawn, visible path on the far side.
//
// A loose end under a roof is not always one of those. A building is sometimes
// drawn over a junction itself, so before anything is peeled each loose end is
// asked whether it was drawn to meet a path beyond the far wall, and if so it
// is joined there and becomes a passage — see joinHiddenEnds() for the test.
//
// Twice. Once here, before TEE and JUNCTION, so they never build on a stub:
// TEE has no detour test and no roof to stop at, and moves any loose end it
// can reach onto the line. And again after them, when the graph is whole and a
// passage can be judged against every other way round. Today the two orders
// come out within one tee of each other — 143 m under roofs either way —
// because the two stub ends the junction stage used to join through a wall,
// in a Health Education portable and in the Science Success Center, are now
// joined here first, by the same test, and nothing else under a roof is in
// reach of anything but its own stroke.
//
// Measured on this sheet: network under a roof 314 -> 143 m, segments more
// than a metre deep 38 -> 14, the deepest 13.1 -> 3.6 m, and no dead end
// further than 0.25 m inside a wall where there were 35; 283 m cut away in 41
// pieces. Every destination still splices or resolves to a door, and the
// router still reaches all of them; a room that used to snap to a stub now
// goes to the door at its end, and twelve directory entrances are such a door.
//
// Two loose ends are joined rather than peeled, and the call is not close for
// either: every other loose end under a roof has nothing within JUNCTION_M that
// is not already a few steps from its own door — a way round at most 0.6 times
// the way through — while these two are at 20 times and no way round at all.
// Any ratio from 1 to 20 joins the same two.
//
//   - Walkway 1287 at the east end of portable 2003 (sheet 2003, 25 x 6 m):
//     its end lies 4.3 m from walkway 1284 under the portable's south wall.
//     Peeled, the 9 m walk from the portable's north wall to the path south of
//     it was 166 m round the complex; joined, by a 4.3 m connector, it is 13 m,
//     against 161 m round.
//   - Walkways 1295 and 1296 meeting under the Science Success Center, 3.8 m
//     apart: peeled, the 12 m of 1295 that is visible between the Center and
//     the STEM building reached the network only through the two of them and
//     was stranded. Joined, by a 3.8 m connector, it is back.
//
// Those 8 m of connector are path the sheet does not draw, and they are counted
// and printed beside the junction stage's. The price is 16 m more under roofs
// than peeling both, all of it on the two strokes above.
//
// What is still under a roof is all passage, and the decision is not close.
// The one passage cut, 39 m of walkway through the corner of the Evangelisti
// Culinary Arts Center, with a second walkway drawn just outside the wall
// beside it, has a way round 1.9 times as long; the least-needed passage kept,
// 8 times. Any ratio from 2 to 8 draws the same line. What stays:
//
//   - 64 m: the 9.9 m driveway alongside the Gym, its centreline 0.86 m inside
//     the wall — most of its drawn width is outside it and plainly visible.
//   - 44 m: walkway 1287 threading five Health Education portables. Joined at
//     its south end as above, it now has a way round, 152-164 m against 5-17 m
//     through each roof — 9 to 32 times — bar a 1.3 m corner at its west end
//     with none.
//   - 10 m: the joint of 1295 and 1296 under the Science Success Center, with
//     no way round; it is the only way to the visible 1295.
//   - 9 m: a corner of the stadium-side walkway under a small unnamed building.
//   - 5 m: a corner tucked into the Student Center's notch.
//   - 11 m in six places, none deeper than 0.9 m: wide paths whose edge a wall
//     outline clips.

/** The footprints painted over an edge: later in the sheet than every stroke drawn down it. */
function hidersOf(key) {
  let top = -Infinity;
  for (const s of edgeS.get(key) ?? []) top = Math.max(top, kept[s].i);
  return FOOTPRINTS.filter((F) => F.i > top);
}

/**
 * Segment a-b as pieces wholly inside or wholly outside the given footprints,
 * as [t0, t1, hidden] runs along it. Breaks closer than a centimetre to each
 * other or to an end are dropped: the shipped coordinates round to about that,
 * and a piece shorter would collapse to nothing on the way out.
 */
function piecesUnder(a, b, over) {
  const L = dist(a, b);
  const ts = [];
  for (const F of over) {
    for (const ring of F.rings) {
      for (let k = 1; k < ring.length; k += 1) {
        const hit = crossing(a, b, ring[k - 1], ring[k]);
        if (hit) ts.push(hit[0]);
      }
    }
  }
  const breaks = [0];
  for (const t of ts.sort((x, y) => x - y)) {
    if ((t - breaks[breaks.length - 1]) * L >= 0.01 && (1 - t) * L >= 0.01) breaks.push(t);
  }
  breaks.push(1);
  const runs = [];
  for (let k = 1; k < breaks.length; k += 1) {
    const tm = (breaks[k - 1] + breaks[k]) / 2;
    const m = [a[0] + tm * (b[0] - a[0]), a[1] + tm * (b[1] - a[1])];
    const hidden = over.some((F) => inFootprint(m, F));
    const last = runs[runs.length - 1];
    if (last && last[2] === hidden) last[1] = breaks[k];
    else runs.push([breaks[k - 1], breaks[k], hidden]);
  }
  return runs;
}

/** Whether a straight line from a to b would run more than a few centimetres under any footprint. */
function underRoof(a, b) {
  const over = FOOTPRINTS.filter((F) => boxMeets(F, a, b));
  const L = dist(a, b);
  return over.length > 0 && piecesUnder(a, b, over).some(([t0, t1, hidden]) => hidden && (t1 - t0) * L > 0.05);
}

/** Cut every edge where it crosses the wall of a footprint painted over it. */
function cutAtWalls() {
  for (const [key, [u, v]] of [...edges]) {
    const a = coord[u], b = coord[v];
    if (dist(a, b) === 0) continue;
    const over = hidersOf(key).filter((F) => boxMeets(F, a, b));
    if (!over.length) continue;
    const runs = piecesUnder(a, b, over);
    if (runs.length < 2) continue;
    const ew = edgeW.get(key) ?? 1, es = edgeS.get(key);
    edges.delete(key);
    let prev = u;
    for (let k = 1; k < runs.length; k += 1) {
      const t = runs[k][0];
      const w = coord.length;
      coord.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      alias.push(w);
      addEdge(prev, w, ew, es);
      prev = w;
    }
    addEdge(prev, v, ew, es);
  }
}

/** Under a footprint painted over it — after cutAtWalls(), all of an edge is or none. */
function edgeHidden(key) {
  const [u, v] = edges.get(key);
  const m = [(coord[u][0] + coord[v][0]) / 2, (coord[u][1] + coord[v][1]) / 2];
  return hidersOf(key).some((F) => inFootprint(m, F));
}

/** Shortest walk from `from` to every node over the given edges, no further than cap. */
function walkOver(edgeList, from, cap = Infinity) {
  const adj = new Map();
  for (const [u, v] of edgeList) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  }
  const best = new Map([[from, 0]]);
  const heap = [[0, from]];
  while (heap.length) {
    heap.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const [dv, n] = heap.shift();
    if (dv > (best.get(n) ?? Infinity) || dv > cap) continue;
    for (const m of adj.get(n) ?? []) {
      const nd = dv + dist(coord[n], coord[m]);
      if (nd < (best.get(m) ?? Infinity)) { best.set(m, nd); heap.push([nd, m]); }
    }
  }
  return best;
}

/**
 * A passage under a roof stays only where the way round is more than this many
 * times the way through. The junction stage's ratio, because it is the same
 * question asked the other way: there, whether a gap is worth an undrawn
 * connector; here, whether a hidden stretch is worth keeping.
 */
const PASS_RATIO = JUNCTION_RATIO;
let wallMetres = 0, wallPieces = 0;
const passages = [];
/**
 * DOORS. Footprint -> what the walls stage took off the graph under it, piece
 * by piece, and the node each piece left the graph at.
 *
 * Peeling a stub takes away more than path nobody can see. A room inside the
 * building used to snap onto it, because the stub was the nearest network to
 * anything behind that wall, and so a walk to the room ended where the drawn
 * approach path goes in. With the stub gone the room snaps to whatever is
 * nearest now. Mostly that is the wall node the peel left, the same door by a
 * shorter way: of the 21 destinations closer to a peeled stub than to anything
 * left, 20 were already snapping to its door. The one that was not is the
 * Library's defibrillator, 17 m from the 8.5 m of the Library's one drawn
 * approach path under the roof: its nearest vertex became a walkway past
 * another side of the building, 22.5 m off with no way in from it, against
 * the door 25 m away.
 *
 * So the pieces are kept, as drawn, with their doors, and written beside the
 * network as src/doors.json. A destination inside a footprint that is closer
 * to one of them than to any edge left is not spliced — it resolves to that
 * piece's door, the nearest where a cut passage left two — and server/graph.js
 * applies the same test to every coordinate it is asked to route, so a dropped
 * pin in a room goes where the room's destinations go; the router then offers
 * the footprint's other doors after that one, and the walk leaves by whichever
 * suits it. build-directory.mjs puts a building's entrance at the door of the
 * footprint its card stands on, and lists the rest.
 *
 * What it does not do is choose one door for a whole building. The Fine and
 * Applied Arts room 560 and the defibrillator down the corridor from it are 10
 * m apart inside one footprint with four doors; each is nearest a different
 * one, as each is nearest a different peeled stub, and the walk between them
 * goes out of one door and round to the other. The network has no indoors to
 * offer instead, and pinning every room to one door would put some of them on
 * the far side of their building from where they are.
 */
const stubsOf = new Map();
let roofJoins = 0, roofConnectors = 0, roofConnectorMetres = 0;
const roofJoined = [];

/**
 * Stub ends under a roof that the drawing meant to join to a path beyond it.
 *
 * A loose end under a roof is not always a stroke drawn past the wall for the
 * fill to hide. Sometimes a building was drawn over the junction itself: the
 * walkway ran on to meet another path, and the footprint painted on top of it
 * hides the meeting. Peeled as a stub, that walkway loses its junction, and
 * the stages after this one cannot give it back — TEE and JUNCTION work from
 * the wall node the peel leaves, which is now further from the other path than
 * either of them reaches, and JUNCTION refuses a connector under a roof anyway.
 * That is what this pass used to do to walkway 1287 at the east end of a Health
 * Education portable: its end lay 4.3 m from walkway 1284 and the junction stage
 * had joined them, the early peel took the end away first, and a 9 m walk from
 * the portable's wall to the path south of it became 166 m round the complex.
 *
 * So before anything is peeled, each loose end under a roof is asked the
 * passage question, against the junction stage's reach: is there another path
 * within JUNCTION_M of it, and is the way round from the stub's door to that
 * path more than PASS_RATIO times the way through — the hidden stub, plus the
 * gap? If so, the two are joined, exactly as the junction stage would join
 * them (a weld within WELD_M, a counted connector beyond it, the line met never
 * moved), and the stub is a passage from then on, judged with the others when
 * the graph is whole. A stroke drawn past its wall to nowhere has its own
 * approach path a few metres back, so the way round is no longer than the way
 * through and it is peeled as before; the ratio is what tells the two apart.
 */
function joinHiddenEnds() {
  for (;;) {
    const deg = new Map();
    for (const [u, v] of edges.values()) {
      deg.set(u, (deg.get(u) ?? 0) + 1);
      deg.set(v, (deg.get(v) ?? 0) + 1);
    }
    const hiddenAdj = new Map();
    for (const key of edges.keys()) {
      if (!edgeHidden(key)) continue;
      for (const n of edges.get(key)) {
        if (!hiddenAdj.has(n)) hiddenAdj.set(n, []);
        hiddenAdj.get(n).push(key);
      }
    }
    let best = null;
    const loose = [...hiddenAdj.keys()].filter((n) => deg.get(n) === 1).sort((x, y) => x - y);
    for (const n of loose) {
      // The stub this end belongs to: everything under a roof joined to it.
      const keys = new Set(), nodes = [n], seen = new Set([n]);
      for (let k = 0; k < nodes.length; k += 1) {
        for (const key of hiddenAdj.get(nodes[k])) {
          keys.add(key);
          for (const m of edges.get(key)) if (!seen.has(m)) { seen.add(m); nodes.push(m); }
        }
      }
      const by = walkOver([...keys].map((key) => edges.get(key)), n);
      const door = nodes
        .filter((m) => deg.get(m) > hiddenAdj.get(m).length)
        .sort((x, y) => by.get(x) - by.get(y) || x - y)[0];
      if (door === undefined) continue;              // an island wholly under a roof
      // Every path in reach, not just the nearest. The nearest is nearly always
      // the stub's own stroke outside the wall it came in by, a metre or three
      // back, and the ratio rightly turns that down; the path the stub was
      // drawn to meet is the next one out.
      const near = [];
      for (const [key, [u, v]] of edges) {
        if (keys.has(key) || u === n || v === n) continue;
        const d = segDist(coord[n], coord[u], coord[v]);
        if (d <= JUNCTION_M) near.push({ n, key, u, v, d });
      }
      if (!near.length) continue;
      near.sort((x, y) => x.d - y.d || (x.key < y.key ? -1 : 1));
      const outside = [...edges].filter(([key]) => !keys.has(key)).map(([, e]) => e);
      const round = walkOver(outside, door, PASS_RATIO * (by.get(door) + JUNCTION_M) + 1);
      for (const cand of near) {
        const through = by.get(door) + cand.d;
        const foot = project(coord[n], coord[cand.u], coord[cand.v]).foot;
        const around = Math.min(
          (round.get(cand.u) ?? Infinity) + dist(coord[cand.u], foot),
          (round.get(cand.v) ?? Infinity) + dist(coord[cand.v], foot),
        );
        if (around <= PASS_RATIO * through) continue;
        if (!best || cand.d < best.d) best = { ...cand, through, door, outside, foot };
        break;
      }
    }
    if (!best) return;

    // The way round in full, for the log; the search above stopped once it
    // knew the answer.
    const round = walkOver(best.outside, best.door);
    const around = Math.min(
      (round.get(best.u) ?? Infinity) + dist(coord[best.u], best.foot),
      (round.get(best.v) ?? Infinity) + dist(coord[best.v], best.foot),
    );
    const hit = landOnLine(best, JUNCTION_M);
    if (!hit) return;                                // measured just now, so never stale
    if (hit.d <= WELD_M) {
      anchor(hit.at, hit.n);
    } else {
      roofConnectors += 1;
      roofConnectorMetres += dist(coord[hit.n], coord[hit.at]);
      addEdge(hit.n, hit.at, 1, [...strokesAt(hit.n), ...strokesAt(hit.at)]);
    }
    roofJoins += 1;
    roofJoined.push({ at: unflat(coord[hit.n]), gap: best.d, through: best.through, around });
    // The new joint can cross a wall of its own; cut it there like any edge.
    rebuild();
    cutAtWalls();
  }
}

/**
 * Remove what the print hides under buildings; with `judge`, also decide the
 * passages that run right through one.
 */
function clipAtWalls(judge) {
  rebuild();
  cutAtWalls();
  joinHiddenEnds();
  const deg = new Map();
  for (const [u, v] of edges.values()) {
    deg.set(u, (deg.get(u) ?? 0) + 1);
    deg.set(v, (deg.get(v) ?? 0) + 1);
  }
  const hidden = new Set([...edges.keys()].filter(edgeHidden));
  const removed = [];
  const drop = (key) => {
    const [u, v] = edges.get(key);
    // The footprints it lay under, asked before the edge and its strokes go.
    const m = [(coord[u][0] + coord[v][0]) / 2, (coord[u][1] + coord[v][1]) / 2];
    const under = hidersOf(key).filter((F) => inFootprint(m, F));
    edges.delete(key);
    hidden.delete(key);
    deg.set(u, deg.get(u) - 1);
    deg.set(v, deg.get(v) - 1);
    removed.push([u, v, under]);
  };

  // Stubs: a hidden edge with a loose end leads nowhere but into the building.
  // Peeled back a leaf at a time, so a stub drawn as several segments, or two
  // stubs meeting under the roof, go together and stop at the wall.
  for (let again = true; again;) {
    again = false;
    for (const key of [...hidden]) {
      const [u, v] = edges.get(key);
      if (deg.get(u) === 1 || deg.get(v) === 1) { drop(key); again = true; }
    }
  }

  // What is left under a roof joins the outside at two or more points, or it
  // would have peeled away above — except a loop with one way in, which goes
  // the same way.
  const hiddenAdj = new Map();
  for (const key of hidden) {
    const [u, v] = edges.get(key);
    if (!hiddenAdj.has(u)) hiddenAdj.set(u, []);
    if (!hiddenAdj.has(v)) hiddenAdj.set(v, []);
    hiddenAdj.get(u).push(key);
    hiddenAdj.get(v).push(key);
  }
  const seen = new Set();
  const groups = [];
  for (const start of [...hiddenAdj.keys()].sort((x, y) => x - y)) {
    if (seen.has(start)) continue;
    const nodes = [], keys = new Set();
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const n = stack.pop();
      nodes.push(n);
      for (const key of hiddenAdj.get(n)) {
        keys.add(key);
        for (const m of edges.get(key)) if (!seen.has(m)) { seen.add(m); stack.push(m); }
      }
    }
    const doors = nodes.filter((n) => deg.get(n) > hiddenAdj.get(n).length).sort((x, y) => x - y);
    if (doors.length <= 1) { for (const key of keys) drop(key); continue; }
    const metres = [...keys].reduce((s, key) => s + dist(...edges.get(key).map((n) => coord[n])), 0);
    groups.push({ keys, doors, metres });
  }
  // Longest first. Each is judged against the graph as the ones before it left
  // it, so where two passages stand in for each other, the one that hides more
  // path under a roof is the one that goes.
  groups.sort((x, y) => y.metres - x.metres || x.doors[0] - y.doors[0]);
  for (const { keys, doors, metres } of judge ? groups : []) {
    const inside = [...keys].map((key) => edges.get(key));
    const outside = [...edges].filter(([key]) => !keys.has(key)).map(([, e]) => e);
    let worst = 0, through = 0, around = 0;
    for (let x = 0; x < doors.length; x += 1) {
      const by = walkOver(inside, doors[x]);
      const round = walkOver(outside, doors[x]);
      for (let y = x + 1; y < doors.length; y += 1) {
        const t = by.get(doors[y]) ?? Infinity, r = round.get(doors[y]) ?? Infinity;
        if (r / t > worst) { worst = r / t; through = t; around = r; }
      }
    }
    const under = new Set();
    for (const key of keys) {
      const [u, v] = edges.get(key);
      const m = [(coord[u][0] + coord[v][0]) / 2, (coord[u][1] + coord[v][1]) / 2];
      for (const F of hidersOf(key)) if (inFootprint(m, F)) under.add(F.i);
    }
    const keep = worst > PASS_RATIO;
    passages.push({ at: unflat(coord[doors[0]]), under: [...under].sort((x, y) => x - y), metres, through, around, keep });
    if (!keep) for (const key of keys) drop(key);
  }

  // Count what went, as connected pieces rather than segments.
  const pieceOf = new Map();
  const top = (n) => { while (pieceOf.get(n) !== n) n = pieceOf.get(n); return n; };
  for (const [u, v] of removed) {
    if (!pieceOf.has(u)) pieceOf.set(u, u);
    if (!pieceOf.has(v)) pieceOf.set(v, v);
    pieceOf.set(top(u), top(v));
    wallMetres += dist(coord[u], coord[v]);
  }
  wallPieces += new Set([...pieceOf.keys()].map(top)).size;

  // Each piece, as drawn under each roof it lay under, and the door it leaves
  // behind: the node where it met what stays, which is the wall node a stub
  // was peeled back to or where a cut passage met the outside. See DOORS.
  const pieces = new Map();
  for (const [u, v, under] of removed) {
    const t = top(u);
    if (!pieces.has(t)) pieces.set(t, { doors: new Set(), under: new Map() });
    const piece = pieces.get(t);
    for (const n of [u, v]) if (deg.get(n) > 0) piece.doors.add(n);
    for (const F of under) {
      if (!piece.under.has(F)) piece.under.set(F, []);
      piece.under.get(F).push([coord[u], coord[v]]);
    }
  }
  for (const [, { doors, under }] of [...pieces].sort((x, y) => x[0] - y[0])) {
    if (!doors.size) continue;                       // an island wholly under a roof
    for (const [F, segs] of under) {
      if (!stubsOf.has(F)) stubsOf.set(F, []);
      stubsOf.get(F).push({ doors: [...doors], segs });
    }
  }
  rebuild();
}

clipAtWalls(false);

// --- 3d. tee dead ends onto the stroke they stop short of --------------------
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
//
// The dead end moves; the line it meets does not (see anchor()). It is the
// dead end that stopped short, so it is the dead end that is wrong — moving
// one loose vertex at most TEE_M rotates the last drawn segment a little and
// leaves the through-path on its stroke. This used to be a midpoint merge,
// which dragged the through-path halfway towards every side path that met it;
// on its own, the change takes network more than 1 m off the drawing from
// 1,004 to 939 m.

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
      // An edge meeting the dead end's own neighbour is a special case.
      // Distance to a segment clamps to its ends, so wherever the last drawn
      // segment is shorter than TEE_M, every edge at that neighbour "passes
      // within TEE_M" of the dead end — at the neighbour itself. Teed onto, the
      // dead end lands on its own neighbour and its last segment disappears.
      //
      // Where the neighbour is a junction, that is right: the stroke was drawn
      // a metre or three past the path it meets, an overshoot, and the stub
      // beyond the junction is drawing slop, not a path anyone walks to. It is
      // trimmed into the junction, which (see anchor()) no longer moves.
      //
      // Where the neighbour is just the next vertex back along the stroke, it
      // is wrong: there is no junction there at all, only the stroke's own
      // continuation, and four strokes on this sheet lost their drawn ends
      // that way — each folded back into the vertex behind it, which the old
      // midpoint merge then pulled half a segment out towards the lost end.
      if ((u === neighbours[0] || v === neighbours[0]) && adj.get(neighbours[0]).length < 3) continue;
      const d = segDist(p, coord[u], coord[v]);
      if (d > TEE_M || (best && d >= best.d)) continue;
      best = { d, key, u, v };
    }
    if (best) actions.push({ n, ...best });
  }
  if (!actions.length) break;

  // Closest first, as in the collapse pass: the least ambiguous joins get to
  // decide the shape of the junction before the marginal ones see it.
  actions.sort((x, y) => x.d - y.d);
  let applied = 0;
  for (const act of actions) {
    const hit = landOnLine(act, TEE_M);
    if (!hit) continue;
    anchor(hit.at, hit.n);
    applied += 1;
  }
  teed += applied;
  if (!applied) break;
}
rebuild();

// --- 3e. weld near-miss junctions --------------------------------------------
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
// done.
//
// HOW the two are joined matters as much as whether. This used to merge the
// node and the line at their midpoint, which moved BOTH drawn lines by half the
// gap — up to 3 m at JUNCTION_M — and the node here is usually mid-path, so
// the kink bent the edges either side of it off their stroke as well. Moving
// only the node (as the tee stage does) is worse still: it puts the whole kink
// into the node's own path. Neither line is wrong; they are two drawn paths
// that were never snapped together. So within a weld (WELD_M — the distance
// this script already treats as "the same point") the node is snapped onto the
// line, and beyond it the two are joined by a short straight connector and
// nothing moves. That is undrawn path, at most JUNCTION_M long per junction, so
// it is counted and printed beside the hand links. Measured on this sheet,
// everything else equal, against the midpoint merge: network more than 1 m off
// the drawn strokes 1,004 -> 691 m and outside every drawn band 237 -> 88 m,
// for under 40 m of connector; snapping the node onto the line instead managed
// only 149 m outside the band. A connector for every gap, however small, was
// tried too: it left two lines 0.2 m apart joined by rungs, a 6.5 m parallel
// duplicate the collapse stage would otherwise have removed, and gained
// nothing.
//
// A connector carries the strokes of both its ends, so the second collapse
// below never takes it for a separate corridor and folds a neighbouring vertex
// of either stroke onto it — the own-stroke rule, applied to a joint.
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

let welded = 0, connectors = 0, connectorMetres = 0;
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
      best = { d, key, u, v };
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
    const hit = landOnLine(act, JUNCTION_M);
    if (!hit) continue;
    if (hit.d <= WELD_M) {
      anchor(hit.at, hit.n);
    } else if (underRoof(coord[hit.n], coord[hit.at])) {
      // Never through a building. A connector is path the sheet does not draw,
      // and the hand links were held to the same rule: nine candidates were
      // refused for crossing a footprint. One made here would also outlive the
      // walls stage — it only exists because the way round is six times longer,
      // which is exactly what keeps a passage under a roof. With the walls
      // stage's first pass ahead of this one there are no stubs left to reach
      // from, and this never fires; it is the net under that.
      continue;
    } else if (!edges.has(EK(hit.n, hit.at))) {
      connectorMetres += dist(coord[hit.n], coord[hit.at]);
      connectors += 1;
      addEdge(hit.n, hit.at, 1, [...strokesAt(hit.n), ...strokesAt(hit.at)]);
    } else {
      // The same pair queued from its other end — the node on the line and
      // the line's end at the node are each within JUNCTION_M of the other —
      // and the connector the first action built already joins them. Nothing
      // to do, so nothing to count: the log line is a count of junctions.
      continue;
    }
    applied += 1;
  }
  welded += applied;
  if (!applied) break;
}
rebuild();

// Junctions just made can reveal corridors drawn twice that were invisible
// while the two strokes were unconnected. Cheap, and it converges immediately.
collapsePasses();

// The second look at the walls, now the graph is whole: anything the stages
// since have moved under a roof, and the passages right through a building,
// which can only be judged against every other way round.
clipAtWalls(true);

// --- 3f. hand-added links ----------------------------------------------------
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
//
// "Already there" means the vertex the link was written against, wherever the
// stages above have since put it. A link is written by hand against the map as
// it was drawn, and the tee and junction stages move dead ends by up to TEE_M
// onto the line they stopped short of — so measured only against where nodes
// are NOW, a link written 0.3 m from a dead end can find that end 3.2 m away,
// beyond a weld, and silently become a loose end of its own. That happened to
// the STEM Innovation Center link: its walkway end was teed onto the stroke it
// met, the link attached at the LRC end only, and an LRC-to-STEM walk went from
// 50 m to 109 m. A node that has been merged away keeps its last coordinate
// (merge() and anchor() only re-alias it), so each id is measured where it was
// as well as where its survivor is, and the link joins the survivor.

function attach(p) {
  // Only nodes still on the graph. The walls stage leaves the nodes of what it
  // removed behind with nothing attached, and a link landing on one of those
  // would join nothing.
  const live = new Set();
  for (const [u, v] of edges.values()) { live.add(u); live.add(v); }
  let node = null, best = WELD_M;
  for (let id = 0; id < coord.length; id += 1) {
    const at = find(id);
    if (!live.has(at)) continue;
    const d = Math.min(dist(coord[at], p), dist(coord[id], p));
    if (d <= best) { best = d; node = at; }
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
    addEdge(edge.u, w, ew, edgeS.get(edge.key));
    addEdge(w, edge.v, ew, edgeS.get(edge.key));
    return w;
  }

  // Free end. Every link on file today joins the network at both ends, so a
  // free one is almost certainly a link the stages above have walked away from
  // — the failure described above — and it must not pass silently: it is
  // listed in the log, and test/graph.test.js fails on it. A link with both
  // ends free is its own island and will be pruned.
  const id = coord.length;
  coord.push(p);
  alias.push(id);
  freeEnds.push(unflat(p));
  return id;
}
const freeEnds = [];

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

// --- 3g. fold a long edge onto the short one it runs along -----------------
//
// One corridor drawn twice from the same vertex: a long straight edge, and a
// short edge leaving the same node the same way whose far end lies on the
// long one. The collapse stage does not see it — it is not two corridors side
// by side, the short edge's end is a node of its own stroke, and the long edge
// carries no stroke at all — and nearest-vertex snapping never noticed it,
// because nothing snapped into the middle of the long edge.
//
// It is here, after the hand links, because today's one case is a hand link:
// the 29.5 m line across the plaza between Fine & Applied Arts and the Kaneko
// Gallery. Its east end shares a node with the 6.1 m stroke that turns south
// out of the plaza, 6 degrees apart and ending 0.66 m off the link; its west
// end runs over 3.1 m and 2.8 m of drawn walkway into the gate. Snapping onto
// edges found it: a point on the plaza joined the link, walked 10 m east to
// the shared node and came 6 m back down the short stroke to turn south —
// "U-turn" in the directions, 48 ft from the start.
//
// So the long edge is rerouted through the short one's far end, which does not
// move: the long edge becomes the short edge plus the rest of the way.
// Repeated to a fixpoint, which walks along a run of short pieces one at a
// time. At the plaza it takes five folds and leaves the crossing as the drawn
// pieces at either end with 12 m of link between them, 17 m less network and
// no doubled line; nothing else on the sheet folds.
//
// FOLD_ANGLE is the collapse stage's own "runs the same way", DUPE_ANGLE; at
// 8 degrees the last fold, onto a 2.5 m piece of walkway 19 degrees off the
// link, was missed, and a walk south from the plaza still began by going 6 m
// west and coming back. FOLD_M is "on it": within the metre a drawn stroke
// wanders. Together they cannot merge a real fork. A short edge whose end is
// within a metre of the long one at up to 20 degrees is under 3 m long — the
// last scrap of a stroke at a node, not a second way.
const FOLD_ANGLE = DUPE_ANGLE;
const FOLD_M = 1.0;
let folded = 0;
for (let pass = 0; pass < 32; pass += 1) {
  rebuild();
  const adj = new Map();
  for (const [u, v] of edges.values()) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  }
  let applied = 0;
  for (const [n, around] of adj) {
    const p = coord[n];
    const heading = (m) => Math.atan2(coord[m][1] - p[1], coord[m][0] - p[0]);
    let fold = null;
    for (const near of around) {
      for (const far of around) {
        if (near === far || dist(p, coord[near]) >= dist(p, coord[far])) continue;
        let gap = Math.abs(heading(near) - heading(far));
        if (gap > Math.PI) gap = 2 * Math.PI - gap;
        if (gap > (FOLD_ANGLE * Math.PI) / 180) continue;
        const on = project(coord[near], p, coord[far]);
        if (on.d > FOLD_M || on.t >= 1) continue;
        if (!fold || on.d < fold.d) fold = { near, far, d: on.d };
      }
    }
    if (!fold) continue;
    const key = EK(n, fold.far);
    if (!edges.has(key)) continue;
    const w = edgeW.get(key) ?? 1, s = [...(edgeS.get(key) ?? [])];
    edges.delete(key);
    edgeW.delete(key);
    edgeS.delete(key);
    // The run from n to `near` is now both strokes', and the rest is the long one's.
    addEdge(n, fold.near, w, s);
    addEdge(fold.near, fold.far, w, s);
    applied += 1;
    break;
  }
  folded += applied;
  if (!applied) break;
}
rebuild();

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
  addEdge(best.u, id, ew, edgeS.get(best.key));
  addEdge(id, best.v, ew, edgeS.get(best.key));
  return id;
}

/**
 * What the walls stage took off the graph, per footprint, with each piece's
 * doors as live node ids. A door merged away since keeps its survivor; a door
 * no longer on the graph at all is forgotten, and a piece with none left is too.
 */
function liveStubs(within = null) {
  const live = new Set();
  for (const [u, v] of edges.values()) { live.add(u); live.add(v); }
  const out = new Map();
  for (const [F, list] of stubsOf) {
    const kept = list
      .map(({ doors, segs }) => ({
        doors: [...new Set(doors.map(find))].filter((n) => live.has(n) && (!within || within.has(n))).sort((x, y) => x - y),
        segs,
      }))
      .filter((piece) => piece.doors.length);
    if (kept.length) out.set(F, kept);
  }
  return out;
}

/**
 * The door a destination resolves to, or null when the network is at least as
 * close as anything the walls stage removed under its roof. `onNetwork` is the
 * distance from p to the nearest live edge.
 */
function doorFor(p, stubs, onNetwork) {
  let best = null;
  for (const [F, list] of stubs) {
    if (!inFootprint(p, F)) continue;
    for (const { doors, segs } of list) {
      const d = Math.min(...segs.map(([a, b]) => segDist(p, a, b)));
      if (d >= onNetwork || (best && d >= best.d)) continue;
      const door = doors.reduce((x, y) => (dist(p, coord[y]) < dist(p, coord[x]) ? y : x));
      best = { d, door };
    }
  }
  return best?.door ?? null;
}

let spliced = 0, atDoor = 0;
{
  const stubs = liveStubs();
  for (const place of places) {
    if (place.geometry?.type !== 'Point') continue;
    const p = flat(place.geometry.coordinates);
    // Resolved to a door, the door is the destination's node already, and
    // splicing it onto the nearest face would only add a vertex the router is
    // told not to use. See DOORS.
    let onNetwork = Infinity;
    for (const [u, v] of edges.values()) onNetwork = Math.min(onNetwork, segDist(p, coord[u], coord[v]));
    if (doorFor(p, stubs, onNetwork) !== null) { atDoor += 1; continue; }
    if (spliceOnto(p) !== null) spliced += 1;
  }
}

// ENTRANCES, the same way. build-directory.mjs sends a building's Directions
// to where its walls come nearest the network — every corner about as near as
// the nearest, see wallNearest() in building-names.mjs — and a point on an
// edge is no vertex until something splices one there. The directory used to
// take the nearest VERTEX instead, which made the entrance depend on where the
// stages above happened to leave one: when COLLAPSE took the Learning Resource
// Center's away, its entrance moved 53 m to the next corner whose vertex had
// survived, with the network still passing 0.3 m from the old one. The
// buildings are buildings.json's, grouped and named as the directory groups
// and names them, so each point spliced is one the directory asks for.
let entranceNodes = 0, entranceSplices = 0;
{
  const footprints = adoptPrintedNames(loadFootprints(src('buildings.json')),
    JSON.parse(readFileSync(src('labels.json'), 'utf8')).features);
  for (const group of groupByName(footprints).values()) {
    const segments = [...edges.values()].map(([u, v]) => [unflat(coord[u]), unflat(coord[v])]);
    for (const { at } of wallNearest(group, segments)) {
      const before = coord.length;
      if (spliceOnto(flat(at)) === null) continue;
      entranceNodes += 1;
      if (coord.length > before) entranceSplices += 1;
    }
  }
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

// The doors, for the router. Only nodes that shipped: a node all of whose
// edges collapsed in the rounding above is not a vertex the server can route to.
const shippedIds = new Set();
for (const [u, v] of edges.values()) {
  if (!keep.has(u) || !keep.has(v)) continue;
  const a = unflat(coord[u]), b = unflat(coord[v]);
  if (a[0] === b[0] && a[1] === b[1]) continue;
  shippedIds.add(u);
  shippedIds.add(v);
}
const byLonLat = (a, b) => a[0] - b[0] || a[1] - b[1];
const doorFeatures = [];
for (const [F, list] of liveStubs(shippedIds)) {
  const stubs = list
    .map(({ doors, segs }) => ({
      doors: doors.map((n) => unflat(coord[n])).sort(byLonLat),
      under: segs.map(([a, b]) => [unflat(a), unflat(b)]),
    }))
    .sort((x, y) => byLonLat(x.doors[0], y.doors[0]) || byLonLat(x.under[0][0], y.under[0][0]));
  doorFeatures.push({
    type: 'Feature',
    properties: { i: F.i, stubs },
    geometry: { type: 'Polygon', coordinates: F.lonLat },
  });
}
doorFeatures.sort((x, y) => x.properties.i - y.properties.i
  || byLonLat(x.properties.stubs[0].doors[0], y.properties.stubs[0].doors[0]));
writeFileSync(src('doors.json'), `${JSON.stringify({ type: 'FeatureCollection', features: doorFeatures })}\n`);
const doorCount = new Set(doorFeatures.flatMap((f) => f.properties.stubs.flatMap((t) => t.doors.map(String)))).size;

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
console.log(`[walk-network] ${Math.round(wallMetres)} m in ${wallPieces} pieces cut away at building walls, `
  + 'drawn where the print paints a building over them');
console.log(`[walk-network]    ${roofJoins} stub end(s) under a roof joined to the path beyond the wall instead, `
  + `${roofConnectors} by connector: ${Math.round(roofConnectorMetres)} m the sheet does not draw`);
for (const j of roofJoined) {
  const around = Number.isFinite(j.around) ? `${Math.round(j.around)} m` : 'no way';
  console.log(`[walk-network]       at ${j.at.join(',')}: ${j.gap.toFixed(1)} m gap, ${around} round against ${Math.round(j.through)} m through`);
}
for (const p of passages) {
  const around = Number.isFinite(p.around) ? `${Math.round(p.around)} m` : 'no way';
  console.log(`[walk-network]    through sheet ${p.under.join('+')} at ${p.at.join(',')}: ${Math.round(p.metres)} m under the roof, `
    + `${p.keep ? 'kept' : 'cut'} (${around} round against ${Math.round(p.through)} m through)`);
}
console.log(`[walk-network] ${teed} dead ends teed onto the stroke they stopped short of within ${TEE_M} m`);
console.log(`[walk-network] ${welded} near-miss junctions welded within ${JUNCTION_M} m (only where the graph made you walk ${JUNCTION_RATIO}x further around)`);
console.log(`[walk-network]    ${connectors} of them wider than a weld, joined by a connector instead: ${Math.round(connectorMetres)} m the sheet does not draw`);
console.log(`[walk-network] ${linkCount} hand-added link(s) from path-links.json, ${Math.round(linkMetres)} m of path the sheet does not draw, each written down by hand`);
console.log(`[walk-network] ${folded} long edge(s) folded onto a short one leaving the same node within ${FOLD_ANGLE} deg and ending within ${FOLD_M} m of it`);
for (const [lon, lat] of freeEnds) {
  console.warn(`[walk-network]    WARNING: a link end at ${lon.toFixed(DECIMALS)},${lat.toFixed(DECIMALS)} joins nothing — within ${WELD_M} m of no node and ${TEE_M} m of no edge`);
}
console.log(`[walk-network] no bridges invented; ${fragments.length} fragments left disconnected `
  + `(${fragments.reduce((n, c) => n + c.length, 0)} nodes)`);
console.log(`[walk-network] ${spliced} destinations spliced in, ${atDoor} more resolved to the door of the footprint they are in`);
console.log(`[walk-network] ${entranceNodes} points where a building's walls come nearest the network, `
  + `${entranceSplices} of them spliced in as new nodes, the rest within a weld of one`);
console.log(`[walk-network] ${doorCount} doors on ${doorFeatures.length} footprints, `
  + `${doorFeatures.reduce((n, f) => n + f.properties.stubs.length, 0)} pieces taken off the graph under their roofs -> src/doors.json`);
console.log(`[walk-network] ${renumber.size} nodes, ${features.length} segments, ${Math.round(metres)} m -> src/paths.json`);

// CAMPUS_BOUNDS in src/main.js is this box. A network that grows past the old
// one leaves part of itself outside the initial view.
const all = features.flatMap((f) => f.geometry.coordinates);
const box = [
  Math.min(...all.map((c) => c[0])), Math.min(...all.map((c) => c[1])),
  Math.max(...all.map((c) => c[0])), Math.max(...all.map((c) => c[1])),
];
console.log(`[walk-network] CAMPUS_BOUNDS [[${box[0]}, ${box[1]}], [${box[2]}, ${box[3]}]]`);
