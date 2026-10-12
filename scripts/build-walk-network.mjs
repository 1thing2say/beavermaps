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
 * is never in doubt. Today it is 10 links and 196 m out of 13.7 km — 1.4%. The
 * junction stage below adds the only other undrawn metres, a handful of
 * connectors a few metres long, and so do the walls with two more where a
 * building is drawn over a junction, and the vee stage with a chord across
 * the paving wherever two paths merge at a shallow angle; their counts and
 * metres print too. The
 * last stage, PLAZAS, writes the lines across the sheet's paved plazas, and
 * those go to a file of their own, src/plaza-paths.json, which is routed
 * over and never drawn. It prints their count and metres, plaza by plaza.
 *
 * WHERE THE DATA COMES FROM. On the sheet a walkway is a stroked path carrying
 * a real ground width, so the stroke IS the centreline: 103 walkways, 25
 * driveways and 6 driveway-entrance mouths the sheet files as crossings, all
 * in #e2e3e4. It draws no crosswalk; the other 24 "crossings" are lane arrows
 * painted down the driveways, in a darker grey, and are not taken (see the
 * stroke loop below). One of the driveways is the
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
 *      Before any of it, a stroke running ALONG a wall painted over half its
 *      band is stood off to the middle of the half that shows (stage 0), and
 *      a junction drawn just inside a wall is moved out onto the paving.
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
 *      at most JUNCTION_M long and on the paving (or carrying a path on from
 *      the end it stops short at), and those are counted and printed
 *      alongside the links. Then the VEE: where two paths merge at a
 *      shallow angle, a chord across the wedge of paving their bands make,
 *      so a walk from one onto the other does not run on to the point and
 *      back.
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
 *   8. PLAZAS. A walkway the sheet paints as a filled surface rather than a
 *      stroke is open paving, and is crossed by a visibility graph between
 *      where the network meets it, round the buildings, planters and trees
 *      that stand on it. A crossing is kept only where it saves real walking
 *      over the drawn way round, and only where the crossings already kept do
 *      not nearly do the same. What is kept is noded like the strokes and
 *      written to src/plaza-paths.json, for the router only. A piece of the
 *      drawing that reaches the rest only across a plaza ships with it, so
 *      paths.json and doors.json are written after this stage.
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
 * the largest component ships, with any piece a plaza joins to it (PLAZAS).
 *
 *   node scripts/build-walk-network.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptPrintedNames, groupByName, loadFootprints, memberNearest, wallNearest } from './building-names.mjs';

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
 * partial; 6 m adds four more welds. Past that it breaks down fast: at 8-10 m
 * the extra welds cut across a lawn, clip the planted island inside the
 * roundabout, and wander over the Portable Village roofs. The detour guard
 * below is necessary but not sufficient — two paths either side of a lawn
 * genuinely are far apart through the graph, so the ratio test happily
 * approves a shortcut across the grass. That is what bounds this at 6, and
 * it is why a connector must also lie on paving (JUNCTION_OFF_M). Not every
 * one at 6 m did: two by the south car park, at -121.347844,38.645713 and
 * -121.348265,38.645826, crossed 2.3 and 2.1 m off the paving. The first
 * steps from the middle of a walkway over the verge to the footway beside
 * it, and is refused. The second carries a walkway on from its end cap to
 * the footway it stops short of, and is joined (JUNCTION_CAP_OFF_M).
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
 * heads of the lane arrows, filled and unstroked. On today's sheet the rule
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
  // Pavement grey or nothing, crossings included. What the sheet files as
  // `crossing` is not a crosswalk: it draws none. Six of its strokes are the
  // mouths of driveway entrances, in pavement grey at the driveways' 6.6 m,
  // and are pavement like any other. The other 24 are the 11 m shafts of the
  // lane arrows painted at the entrances, two to a driveway or mouth, in a
  // darker grey 0.82 m wide, with their heads as fills beside them. Those were
  // kept "regardless" while they were taken for crossings, and 78 m of the
  // network ran down the carriageway on them: thirteen of the twenty street
  // gates ended on a shaft, and at College Oak Dr the network ran 8 m out
  // into the road on one.
  if (stroke !== PAVEMENT) continue;
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
// it out of the graph. The six driveway mouths filed as crossings are the
// exception that proves the rule: they are painted last of all (2324 and up),
// over everything, so they are never hidden — the comparison is on painter's
// order, not on kind. The one driveway
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

// --- the pavement the print shows -----------------------------------------------
//
// Where the sheet paints pavement grey: the band of every stroke taken above,
// its centreline widened by half its drawn width, and every surface FILLED in
// that grey (the plazas, see stage 5 for which and why). The stages that move
// a node or add a line ask it whether the result is still on paving; the plaza
// stage walks its crossings over it.

const PLAZA_KINDS = new Set(['walkway', 'parking', 'driveway']);
const PLAZA_MIN_M2 = 100;
const closedLine = (cs) => cs.length > 3 && cs[0][0] === cs.at(-1)[0] && cs[0][1] === cs.at(-1)[1];
/** The areas a geometry covers. A closed LineString is a polygon drawn as one. */
const surfacesOf = (g) => (g.type === 'Polygon' ? [g.coordinates]
  : g.type === 'MultiPolygon' ? g.coordinates
    : g.type === 'LineString' && closedLine(g.coordinates) ? [[g.coordinates]] : []);
const ringArea = (r) => {
  let a = 0;
  for (let k = 1; k < r.length; k += 1) a += r[k - 1][0] * r[k][1] - r[k][0] * r[k - 1][1];
  return a / 2;
};
const boxOf = (ring) => {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const inPoly = (p, poly) => inRing(p, poly.rings[0]) && !poly.rings.slice(1).some((r) => inRing(p, r));
const plazas = basemap
  .filter((f) => PLAZA_KINDS.has(f.properties.kind) && f.properties.fill === PAVEMENT)
  .flatMap((f) => surfacesOf(f.geometry).map((rings) => ({ i: f.properties.i, rings: rings.map((r) => r.map(flat)) })))
  .filter((P) => Math.abs(ringArea(P.rings[0])) >= PLAZA_MIN_M2)
  .map((P) => ({ ...P, box: boxOf(P.rings[0]) }));

// A coarse grid over the stroke bands (and, in stage 5, the obstacles), so a
// sample asks only the handful of things in its own cell rather than every
// stroke on the sheet.
const CELL = 10;
const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
const gridOf = (items, boxFn) => {
  const grid = new Map();
  for (const item of items) {
    const [x0, y0, x1, y1] = boxFn(item);
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx += 1) {
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy += 1) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(item);
      }
    }
  }
  return grid;
};
const bandSegs = strokes.flatMap((s) => s.pts.slice(1).map((b, k) => ({ a: s.pts[k], b, half: s.width / 2 })));
const bandGrid = gridOf(bandSegs, ({ a, b, half }) => [
  Math.min(a[0], b[0]) - half, Math.min(a[1], b[1]) - half, Math.max(a[0], b[0]) + half, Math.max(a[1], b[1]) + half,
]);
/** Whether a point lies on paving the print shows: a stroke's band or a filled plaza. */
const paved = (p) => plazas.some((P) => p[0] >= P.box[0] && p[0] <= P.box[2] && p[1] >= P.box[1] && p[1] <= P.box[3] && inPoly(p, P))
  || (bandGrid.get(cellKey(p[0], p[1])) ?? []).some(({ a, b, half }) => segDist(p, a, b) <= half);

/** On paving with room to spare: WELL_INSIDE_M inside a band, or on a plaza. */
const WELL_INSIDE_M = 0.5;
const pavedWell = (p) => plazas.some((P) => p[0] >= P.box[0] && p[0] <= P.box[2] && p[1] >= P.box[1] && p[1] <= P.box[3] && inPoly(p, P))
  || (bandGrid.get(cellKey(p[0], p[1])) ?? []).some(({ a, b, half }) => segDist(p, a, b) <= half - WELL_INSIDE_M);

/** Metres of the straight line a-b off every band and plaza, sampled every BAND_STEP_M. */
const BAND_STEP_M = 0.25;
function unpaved(a, b) {
  const L = dist(a, b);
  const n = Math.max(1, Math.ceil(L / BAND_STEP_M));
  let off = 0;
  for (let k = 0; k <= n; k += 1) if (!paved([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])) off += 1;
  return (off / (n + 1)) * L;
}

// --- 0. stand a half-roofed run off the wall ----------------------------------
//
// Part of WALLS (3c below), done here, on the strokes themselves, because the
// line it moves is the line every later stage builds on. A building painted
// over the side of a wide path hides only that side: the driveway along the
// Gym's north wall (sheet 1102, 9.9 m wide) has its centreline 0 to 0.86 m
// inside the wall for 64 m, and nearly all of its band plainly visible
// outside it. Read verbatim, the centreline is under the roof, the walls stage
// rightly cannot peel a way that goes somewhere, and it kept the run as a
// "passage": 64 m of route ribbon drawn half over a roof, and the Pool's and
// Adaptive PE's doors, peeled back to it, inside the Gym, 2.4 m from it.
//
// So where a stroke runs ALONG a wall painted over it — within STANDOFF_ANGLE
// of the wall beside it — and its centreline is inside by less than its
// half-width minus STANDOFF_VISIBLE_M, the vertex moves square off the wall
// to the middle of the part of the band that shows: (depth + half-width) / 2
// outside. That is the line someone walking it actually takes, on the paving
// the print shows. A path that runs INTO a building (an approach stub) meets
// the wall at an angle and is left for the walls stage to peel; one drawn
// through a building is too deep to qualify. Each moved run is printed.
const STANDOFF_ANGLE = 30;
const STANDOFF_VISIBLE_M = 1.0;
/** Nearest point of a footprint's outline to p, with the bearing of the wall it is on. */
function wallFoot(p, F) {
  let best = null;
  for (const ring of F.rings) {
    for (let k = 1; k < ring.length; k += 1) {
      const a = ring[k - 1], b = ring[k];
      const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy;
      const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L));
      const q = [a[0] + t * vx, a[1] + t * vy];
      const d = dist(p, q);
      if (!best || d < best.d) best = { d, q, ang: Math.atan2(vy, vx), n: [-vy / Math.sqrt(L || 1), vx / Math.sqrt(L || 1)] };
    }
  }
  return best;
}
/** How far either side of a stood-off run the move is eased in, how finely a stroke is read for it, and the longest break in a run that is bridged. */
const STANDOFF_EASE_M = 3.0;
const STANDOFF_STEP_M = 1.0;
const STANDOFF_GAP_M = 8.0;
/** Where p would stand off the wall of a footprint painted over stroke s, as an offset, or null. */
function standoffAt(p, own, s) {
  const half = s.width / 2;
  for (const F of FOOTPRINTS) {
    if (F.i <= s.i) continue;
    if (p[0] < F.box[0] - 0.05 || p[0] > F.box[2] + 0.05 || p[1] < F.box[1] - 0.05 || p[1] > F.box[3] + 0.05) continue;
    const inside = inFootprint(p, F);
    const w = wallFoot(p, F);
    if (!inside && w.d > 0.05) continue;                // outside, and not on the wall
    const depth = inside ? w.d : 0;
    if (half - depth < STANDOFF_VISIBLE_M || bearingGap(own, w.ang) > STANDOFF_ANGLE) continue;
    // Out of the footprint: the wall's normal, on whichever side is outside.
    const sg = inFootprint([w.q[0] + 0.1 * w.n[0], w.q[1] + 0.1 * w.n[1]], F) ? -1 : 1;
    const by = (depth + half) / 2;
    return { F: F.i, depth, by, o: [sg * by * w.n[0], sg * by * w.n[1]] };
  }
  return null;
}
/** Douglas-Peucker over pts, never dropping one marked `keep`. */
function simplify(pts, tol) {
  const keep = pts.map((q) => q.keep);
  keep[0] = keep[pts.length - 1] = true;
  const walk = (a, b) => {
    let far = -1, fd = tol;
    for (let k = a + 1; k < b; k += 1) {
      const d = segDist(pts[k].p, pts[a].p, pts[b].p);
      if (d > fd) { fd = d; far = k; }
    }
    if (far < 0) return;
    keep[far] = true;
    walk(a, far);
    walk(far, b);
  };
  let a = 0;
  for (let k = 1; k < pts.length; k += 1) if (keep[k]) { walk(a, k); a = k; }
  return pts.filter((_, k) => keep[k]).map((q) => q.p);
}
const standoffs = [];
for (const s of strokes) {
  // The stroke read every STANDOFF_STEP_M, its own vertices among the samples.
  const samples = [];
  let at = 0;
  for (let k = 0; k < s.pts.length; k += 1) {
    const p = s.pts[k];
    if (k > 0) {
      const a = s.pts[k - 1], L = dist(a, p);
      const n = Math.floor(L / STANDOFF_STEP_M);
      for (let j = 1; j <= n; j += 1) {
        const t = (j * STANDOFF_STEP_M) / L;
        if (t < 1 - 1e-9) samples.push({ p: [a[0] + t * (p[0] - a[0]), a[1] + t * (p[1] - a[1])], s: at + t * L, own: Math.atan2(p[1] - a[1], p[0] - a[0]) });
      }
      at += L;
    }
    const prev = s.pts[Math.max(0, k - 1)], next = s.pts[Math.min(s.pts.length - 1, k + 1)];
    samples.push({ p, s: at, keep: true, own: Math.atan2(next[1] - prev[1], next[0] - prev[0]) });
  }
  for (const q of samples) q.off = standoffAt(q.p, q.own, s);
  const runs = samples.filter((q) => q.off);
  if (!runs.length) continue;
  // Eased in and out, so the line leaves its drawn centreline over a few
  // metres instead of stepping sideways at the corner of the wall.
  // A short break in a run — a pilaster or a notch in the wall, where the
  // wall beside the line turns for a metre or two — is bridged rather than
  // eased, or the line would dip back towards the wall at every one of them.
  const out = samples.map((q) => {
    if (q.off) return { p: [q.p[0] + q.off.o[0], q.p[1] + q.off.o[1]], keep: q.keep };
    const before = runs.filter((r) => r.s < q.s).at(-1), after = runs.find((r) => r.s > q.s);
    let o = null;
    if (before && after && after.s - before.s <= STANDOFF_GAP_M) {
      const f = (q.s - before.s) / (after.s - before.s);
      o = [before.off.o[0] + f * (after.off.o[0] - before.off.o[0]), before.off.o[1] + f * (after.off.o[1] - before.off.o[1])];
    } else {
      const near = [before, after].filter(Boolean).reduce((x, y) => (Math.abs(y.s - q.s) < Math.abs(x.s - q.s) ? y : x));
      const f = 1 - Math.abs(near.s - q.s) / STANDOFF_EASE_M;
      if (f > 0) o = [f * near.off.o[0], f * near.off.o[1]];
    }
    if (!o) return { p: q.p, keep: q.keep };
    const moved = [q.p[0] + o[0], q.p[1] + o[1]];
    return { p: inAnyFootprint(moved) ? q.p : moved, keep: q.keep };
  });
  s.pts = simplify(out, 0.1);
  s.len = s.pts.slice(1).reduce((t, p, k) => t + dist(s.pts[k], p), 0);
  const byF = new Map();
  for (const r of runs) {
    const m = byF.get(r.off.F) ?? { i: s.i, kind: s.kind, F: r.off.F, metres: 0, depth: 0, by: 0 };
    m.metres += STANDOFF_STEP_M;
    m.depth = Math.max(m.depth, r.off.depth);
    m.by = Math.max(m.by, r.off.by);
    byF.set(r.off.F, m);
  }
  standoffs.push(...byF.values());
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
// As first read, the sheet drew ~857 m of corridor twice: a footway shadowing
// a driveway, a walkway drawn over itself, and — the loudest of the three — the
// lane arrows at the entrances, a pair of shafts 3 m apart down each driveway
// or mouth, so one carriageway became three parallel routes. They were taken
// for zebra crossings then; they are no longer taken at all (see the stroke
// loop), and the other two are what is left here. Riding a centreline down each of
// those is what put three lines down one path on screen.
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

/** Where merge() would put the survivor of a and b, without merging them. */
function mergedAt(a, b, wa = 1, wb = 1) {
  const [x, y] = [find(a), find(b)];
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
  return at(t);
}

function merge(a, b, wa = 1, wb = 1) {
  const [x, y] = [find(a), find(b)];
  if (x === y) return;
  coord[x] = mergedAt(x, y, wa, wb);
  alias[y] = x;
  for (const s of strokesAt(y)) strokesAt(x).add(s);
}

/**
 * Whether moving the nodes `ids` (merged into one) to `to` would drag an edge
 * on them off the paving: more than STRAY_M of it outside every drawn band and
 * plaza (see paved()), where there was not that much before. `extra` lists
 * edges about to exist that are not in `edges` yet, as [their other end, where
 * this end is now].
 *
 * The collapse stage moves a node onto a second drawing of its corridor, and a
 * node joined to a different path — by a tee, or a junction — sits on that
 * path too. Its own stroke runs the same way as the corridor it is offered, so
 * the move is approved, and the other path's edges swing off their pavement
 * with it. That is what the second pass, after the junction stage, did where
 * driveway 1086 is teed onto walkway 1321 at the west entrance: it dragged the
 * tee 5 m sideways onto walkway 1263, and the edge of 1321 into it then cut
 * 5 m across a lawn and a tree planter where the drawn diagonal beside it is
 * paved all the way. Asked of every band rather than the edge's own, because
 * a footway collapsing onto its driveway legitimately leaves the driveway's
 * edges on the footway's band, beside their own.
 */
const STRAY_M = 1.0;
function strays(ids, to, extra = []) {
  const set = new Set(ids.map(find));
  const list = [...extra];
  for (const [u, v] of edges.values()) {
    const a = find(u), b = find(v);
    if (set.has(a) === set.has(b)) continue;
    list.push(set.has(a) ? [b, coord[a]] : [a, coord[b]]);
  }
  for (const [o, from] of list) {
    const after = unpaved(to, coord[o]);
    if (after > STRAY_M && after > unpaved(from, coord[o]) + 0.01) {
      return true;
    }
  }
  return false;
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
const strayed = new Set();

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
      // a different stroke — a walkway drawn twice, a footway beside its
      // driveway — so excluding the node's own strokes loses none of the
      // duplicates this stage exists for.
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
    const end = live.t * span < WELD_M ? u : (1 - live.t) * span < WELD_M ? v : null;
    if (end !== null) {
      if (strays([n, end], mergedAt(n, end, nw, ew))) { strayed.add(act.n); continue; }
      merge(n, end, nw, ew);
      applied += 1;
      continue;
    }
    // Cut at the foot and merge there: judged as the merge it will be, with
    // the two halves of the cut edge among the edges that move.
    {
      const w = coord.length;
      coord.push(live.foot);
      alias.push(w);
      const to = mergedAt(n, w, nw, ew);
      coord.pop();
      alias.pop();
      if (strays([n], to, [[u, live.foot], [v, live.foot]])) { strayed.add(act.n); continue; }
    }
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
function landOnLine(act, tol, reach = Infinity) {
  const at = landingOf(act, tol, reach);
  if (!at) return null;
  if (at.end !== null) return { n: at.n, at: at.end, d: at.d };
  const { u, v, n } = at;
  const w = coord.length;
  const ew = edgeW.get(act.key) ?? 1, es = edgeS.get(act.key);
  coord.push(at.p);
  alias.push(w);
  edges.delete(act.key);
  addEdge(u, w, ew, es);
  addEdge(w, v, ew, es);
  return { n, at: w, d: at.d };
}

/**
 * Where landOnLine() would join `n` to the action's edge, without joining it:
 * `end` is the end it would weld to, or null for a cut at `p`. An end is taken
 * only within a weld of the foot along the line and within `reach` of the
 * node itself; past that the cut is made at the foot, so a connector is never
 * longer than the stage that asked for it allows — unless the foot is within
 * LAND_MIN_M of the end, where a cut would leave two nodes a hand's width
 * apart and the end is taken after all.
 */
const LAND_MIN_M = 0.5;
function landingOf(act, tol, reach = Infinity) {
  if (!edges.has(act.key)) return null;               // already restructured
  const n = find(act.n), u = find(act.u), v = find(act.v);
  if (n === u || n === v || u === v) return null;
  const live = project(coord[n], coord[u], coord[v]);
  if (live.d > tol) return null;
  const span = dist(coord[u], coord[v]);
  // Landing near either end is a weld, not a cut — splitting there would leave
  // a sub-centimetre edge the router has to carry forever.
  for (const [end, along] of [[u, live.t * span], [v, (1 - live.t) * span]]) {
    if (along < WELD_M && (dist(coord[n], coord[end]) <= reach || along < LAND_MIN_M)) return { n, u, v, end, p: coord[end], d: live.d };
  }
  return { n, u, v, end: null, p: live.foot, d: live.d };
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
// the driveway mouths, painted last of all, are never touched — and what lies
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
// come out within one tee of each other, because the two stub ends the junction stage used to join through a wall,
// in a Health Education portable and in the Science Success Center, are now
// joined here first, by the same test, and nothing else under a roof is in
// reach of anything but its own stroke.
//
// Measured on this sheet: network under a roof 314 -> 143 m, segments more
// than a metre deep 38 -> 14, the deepest 13.1 -> 3.6 m, and no dead end
// further than 0.25 m inside a wall where there were 35; 283 m cut away in 41
// pieces. Standing half-roofed runs off their wall (stage 0) and moving out
// the one junction drawn just inside a wall (standOffCorners()) then took it
// to 67 m in 17 segments, 12 of them more than a metre deep, with 275 m cut
// away. Every destination still splices or resolves to a door, and the
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
// What is still under a roof is all passage, and the ratio's decision is not
// close. The one passage it cuts, 39 m of walkway through the corner of the
// Evangelisti Culinary Arts Center, with a second walkway drawn just outside
// the wall beside it, has a way round 1.9 times as long; the least-needed
// passage it keeps, 8 times. Any ratio from 2 to 8 draws the same line.
//
// The ratio is not the only question, though: a passage on which no pavement
// shows at all is cut, rejoined outside the wall or listed in path-links.json
// whatever the ratio says (see BARE_M). What stays:
//
//   - 10 m: the joint of 1295 and 1296 under the Science Success Center, with
//     no way round; it is the only way to the visible 1295. Listed.
//   - 9 m: a corner of the stadium-side walkway under a small unnamed building,
//     3.7 m in: too deep to move out onto paving, and since the two verge
//     connectors by the south car park were refused (JUNCTION_M) the only way
//     to the walkway beyond, 530 m round otherwise. Listed.
//   - 6 m: walkway 1287's south end beside portable 2003, its band showing
//     past the portable's east wall.
//   - 6 m in four places: paths whose edge a wall outline clips on the way
//     past, crossing the wall rather than running along it.
//
// Gone from that list: walkway 1287, which threaded four Health Education
// portables (1987, 1988, 1989, 1998) with most of it bare, is cut at each:
// the walk across the complex goes round, 150-160 m, and what is left of 1287
// and 1288 between the portables, which the sheet reaches only through them,
// goes with the fragments. And 64 m of the 9.9 m driveway alongside the Gym,
// whose centreline ran up to 0.86 m inside the wall with most of its band in
// plain view, now stood off to the middle of what shows; and 5 m round the
// corner tucked into the Student Center's notch, now moved out of it.

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
 * and a piece shorter would collapse to nothing on the way out. With `sliver`,
 * a hidden piece shorter than that with open ground either side of it — the
 * line grazing a corner of the outline — counts as open too (see
 * cutAtWalls()).
 */
function piecesUnder(a, b, over, sliver = 0) {
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
  if (!sliver) return runs;
  const open = runs.map(([t0, t1, hidden], k) => [t0, t1,
    hidden && !(k > 0 && k < runs.length - 1 && (t1 - t0) * L < sliver)]);
  const merged = [];
  for (const r of open) {
    const last = merged[merged.length - 1];
    if (last && last[2] === r[2]) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged;
}

/** Whether a straight line from a to b would run more than a few centimetres under any footprint. */
function underRoof(a, b) {
  const over = FOOTPRINTS.filter((F) => boxMeets(F, a, b));
  const L = dist(a, b);
  return over.length > 0 && piecesUnder(a, b, over).some(([t0, t1, hidden]) => hidden && (t1 - t0) * L > 0.05);
}

/**
 * Cut every edge where it crosses the wall of a footprint painted over it —
 * but not into slivers. A line that grazes a corner of an outline crosses two
 * walls a few centimetres apart, and cut at both it left two nodes 8 cm apart
 * and an 8 cm "passage" under the roof, which the router's vertex precision
 * then has to keep apart. A hidden piece under SLIVER_M with open ground at
 * both ends is not cut out. One that ends under the roof still is, however
 * short: that is an approach path stopping at its door.
 */
const SLIVER_M = 0.25;
function cutAtWalls() {
  for (const [key, [u, v]] of [...edges]) {
    const a = coord[u], b = coord[v];
    if (dist(a, b) === 0) continue;
    const over = hidersOf(key).filter((F) => boxMeets(F, a, b));
    if (!over.length) continue;
    const runs = piecesUnder(a, b, over, SLIVER_M);
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

/**
 * BARE: metres of an edge where no pavement shows at all — where every point
 * across the width drawn down it is under a footprint painted over it. A
 * passage along a wall, or a wide driveway whose edge a wall clips, shows its
 * pavement beside the roof; a walkway with a portable set down on top of it
 * shows none. Sampled every SHOW_STEP_M along the edge at nine points across
 * the widest stroke drawn down it. A connector carries the strokes it joins
 * and is measured at their width.
 */
const SHOW_STEP_M = 0.25;
function bareMetres(key) {
  const [u, v] = edges.get(key);
  const a = coord[u], b = coord[v], L = dist(a, b);
  const over = hidersOf(key);
  if (L === 0 || !over.length) return 0;
  let width = 0;
  for (const s of edgeS.get(key) ?? []) width = Math.max(width, kept[s].width);
  const half = (width || (edgeW.get(key) ?? 1)) / 2;
  const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
  const steps = Math.max(1, Math.round(L / SHOW_STEP_M));
  let bare = 0;
  for (let k = 0; k < steps; k += 1) {
    const t = (k + 0.5) / steps;
    const m = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    let shows = false;
    for (let j = -4; j <= 4 && !shows; j += 1) {
      const p = [m[0] + nx * half * (j / 4), m[1] + ny * half * (j / 4)];
      shows = !over.some((F) => inFootprint(p, F));
    }
    if (!shows) bare += L / steps;
  }
  return bare;
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
/**
 * A passage with at least this much of it bare (see bareMetres()) is not kept
 * for being the shorter walk. The ratio asks only whether the walk round is
 * long, never whether anyone could walk where the passage runs, and kept 49 m
 * of walkway on which the sheet shows no pavement at all: walkway 1287 down
 * the middle of four Health Education portables set on top of it, a joint of
 * two walkways under the Science Success Center, another under a small
 * building on the stadium side, and the bend of a walkway tucked into the
 * Student Center's notch. 220 of 3,907 random walks went through portable
 * 1998 alone, and the route ribbon, which nothing hides, drew them across its
 * roof.
 *
 * Such a passage is, in order:
 *
 *   - REJOINED OUTSIDE THE WALL, where it has two ways out and the straight
 *     line between them is at most JUNCTION_M and under no roof: the stroke
 *     bends round a corner of the building and its pavement shows round the
 *     outside of the bend. The hidden piece goes, as a cut passage does, and
 *     the two wall nodes are joined by a connector, counted like the junction
 *     stage's. The Student Center's notch, 3.3 m outside against 5 m under.
 *   - KEPT, where path-links.json lists the footprint under `passages`, with a
 *     `why`: a decision written down, not a side effect of the ratio.
 *   - CUT otherwise, like any passage the ratio turns down, and its ways out
 *     are doors.
 *
 * One metre, so the corner of a roof clipping a wide stroke — the six passages
 * of under a metre each that the ratio kept, which all show pavement beside
 * them — is never the question.
 */
const BARE_M = 1.0;
const passageExceptions = new Map();
{
  const file = src('path-links.json');
  const listed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).passages ?? [] : [];
  for (const p of listed) passageExceptions.set(p.under, { ...p, used: false });
}
let bareKept = 0, wallChords = 0, wallChordMetres = 0;
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
/**
 * A junction drawn just inside a wall: a node under a roof, every edge on it
 * hidden and leaving through the same face of the wall, or the two faces
 * either side of one corner, within CORNER_M of it. The building was painted
 * over the bend of a path that goes round it, a couple of metres in, and the
 * walls stage could only keep that bend as a "passage" under the roof. It is
 * moved out instead: a metre outside the face, square to it, or a metre out
 * along the corner's bisector, and the wall nodes the cut left are taken out
 * so the edges run straight to it — when it lands on paving, under no roof,
 * and no edge to it runs more than STRAY_M off the paving. Each move is
 * counted and printed. A node deeper in, or one whose edges leave by faces
 * far apart, is a path drawn through the building and is left to the
 * passage test.
 */
const CORNER_M = 4.0;
/** How far clear of the wall a moved junction stands. */
const CORNER_CLEAR_M = 0.5;
const cornerMoves = [];
function standOffCorners() {
  rebuild();
  const adj = new Map();
  for (const [u, v] of edges.values()) {
    if (!adj.has(u)) adj.set(u, new Set());
    if (!adj.has(v)) adj.set(v, new Set());
    adj.get(u).add(v);
    adj.get(v).add(u);
  }
  for (const n of [...adj.keys()].sort((x, y) => x - y)) {
    const around = [...adj.get(n)];
    if (around.length < 2) continue;
    const F = FOOTPRINTS.find((G) => inFootprint(coord[n], G));
    if (!F || !around.every((m) => hidersOf(EK(n, m)).includes(F))) continue;
    // Every neighbour a wall node of F, and the node itself near the wall.
    if (around.some((m) => wallFoot(coord[m], F).d > 0.05) || wallFoot(coord[n], F).d > CORNER_M) continue;
    // Where: the point on paving outside, within CORNER_M, that makes the walk
    // through the junction shortest — the bend of the paths as the print
    // shows it, just clear of the wall. Its edges run straight to whatever
    // each wall node leads on to, the wall node gone, where that stays on
    // paving; where it does not, to the wall nodes themselves.
    const o = coord[n];
    const place = (targets) => {
      let q = null, best = Infinity;
      for (let dx = -CORNER_M; dx <= CORNER_M; dx += 0.25) {
        for (let dy = -CORNER_M; dy <= CORNER_M; dy += 0.25) {
          const c = [o[0] + dx, o[1] + dy];
          if (Math.hypot(dx, dy) > CORNER_M || inAnyFootprint(c) || wallFoot(c, F).d < CORNER_CLEAR_M || !pavedWell(c)) continue;
          const walk = targets.reduce((t, p) => t + dist(c, p), 0);
          if (walk >= best) continue;
          if (targets.some((p) => underRoof(c, p) || unpaved(c, p) > STRAY_M)) continue;
          best = walk;
          q = c;
        }
      }
      return q;
    };
    const ends = around.map((m) => {
      const beyond = [...adj.get(m)].filter((x) => x !== n);
      return { m, o: beyond.length === 1 ? beyond[0] : null };
    });
    let q = place(ends.map((e) => coord[e.o ?? e.m]));
    if (q) {
      for (const { m, o: on } of ends) {
        if (on === null) continue;
        const k = EK(m, on), w = edgeW.get(k) ?? 1, s = edgeS.get(k) ?? new Set();
        const kn = EK(n, m), sn = edgeS.get(kn) ?? new Set();
        edges.delete(k);
        edges.delete(kn);
        addEdge(n, on, w, [...s, ...sn]);
      }
    } else {
      q = place(around.map((m) => coord[m]));
      if (!q) continue;
    }
    const from = unflat(coord[n]);
    coord[n] = q;
    cornerMoves.push({ F: F.i, from, to: unflat(q) });
    rebuild();
    return standOffCorners();
  }
}

function clipAtWalls(judge) {
  rebuild();
  cutAtWalls();
  joinHiddenEnds();
  standOffCorners();
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
    // A passage with no pavement showing over it is not kept on the ratio
    // alone: see BARE_M.
    const bare = [...keys].reduce((sum, key) => sum + bareMetres(key), 0);
    let keep = worst > PASS_RATIO, outcome = keep ? 'kept' : 'cut';
    let chord = null;
    if (keep && bare >= BARE_M) {
      const excepted = [...under].map((i) => passageExceptions.get(i)).find(Boolean);
      const [a, b] = doors.map((n) => coord[n]);
      if (doors.length === 2 && dist(a, b) <= JUNCTION_M && !underRoof(a, b)) {
        chord = doors;
        outcome = 'rejoined outside the wall';
      } else if (excepted) {
        excepted.used = true;
        outcome = 'kept, a listed exception';
      } else {
        keep = false;
        outcome = 'cut, no pavement shows';
      }
    }
    passages.push({ at: unflat(coord[doors[0]]), under: [...under].sort((x, y) => x - y), metres, bare, through, around, outcome });
    if (keep && !chord && bare >= BARE_M) bareKept += bare;
    if (keep && !chord) continue;
    if (!chord) {
      for (const key of keys) drop(key);
      continue;
    }
    // Rejoined: the stroke bends round the outside of the wall, so the piece
    // under the roof is no approach path, and its two ends are not doors. It
    // goes without being written down in DOORS: recorded, the Student
    // Center's notch gave two rooms 2.7 m apart a door each, 3.3 m apart along
    // the chord, and a "walk" between them out of one and in at the other.
    const strokesUnder = new Set([...keys].flatMap((key) => [...(edgeS.get(key) ?? [])]));
    for (const key of keys) {
      const [u, v] = edges.get(key);
      wallMetres += dist(coord[u], coord[v]);
      edges.delete(key);
      hidden.delete(key);
    }
    wallChords += 1;
    wallChordMetres += dist(coord[chord[0]], coord[chord[1]]);
    addEdge(chord[0], chord[1], 1, strokesUnder);
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
// "To get across" means to the point the join would land on, and every line
// within JUNCTION_M is asked, nearest first. This used to take the nearest
// line only and measure the way round to its nearer END, and both halves hid
// junctions. A dead end whose last drawn segment is shorter than JUNCTION_M
// finds its own neighbour's edges nearest, which are rightly refused, and
// never got to the line beyond; and the two tines of a fork are a few steps
// apart at their apex however far it is from one to the other along them.
// Driveway 1081 stopping 5.2 m short of driveway 1087 at the west entrance
// was both: 52 m round by the graph, and missed. Asked properly, the stage
// makes eight more joins than it did, every connector on pavement, and 440
// walks between two places get shorter, by 720 m in all.
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

/**
 * The most of a junction connector that may lie off the paving the print
 * shows; and the most where the connector carries a path on from its END CAP.
 *
 * A path drawn up to another and stopping short ends in a round cap, and the
 * lawn between the cap and the other path's band is drawing slop, not a verge:
 * nobody lays a walkway to stop two metres short of the next. Where the node
 * is a dead end and the connector runs on within CAP_ANGLE of the line of its
 * last drawn segment, it may cross JUNCTION_CAP_OFF_M. A connector from the
 * middle of a path, or turning off it, is across a verge between two paths
 * and keeps to JUNCTION_OFF_M. The walkway west of the south car park was
 * the case: its cap stops 5.4 m from the footway it points at, 2.1 m of that
 * off the paving, and refused, the walkway joined the rest only at its far
 * end. Of 2,000 random walks on the campus, 11 went round, up to 497 m
 * further; no walk between two places used it either way.
 */
const JUNCTION_OFF_M = 1.0;
const JUNCTION_CAP_OFF_M = 2.5;
const CAP_ANGLE = 30;
/** Whether `n` is a dead end and `to` lies on along its last drawn segment. */
const capOn = (n, adjOf, to) => {
  const [m, ...more] = adjOf.get(n) ?? [];
  if (m === undefined || more.length) return false;
  const p = coord[n], q = coord[m];
  const h1 = Math.atan2(p[1] - q[1], p[0] - q[0]), h2 = Math.atan2(to[1] - p[1], to[0] - p[0]);
  let gap = Math.abs(h1 - h2);
  if (gap > Math.PI) gap = 2 * Math.PI - gap;
  return gap <= (CAP_ANGLE * Math.PI) / 180;
};
let welded = 0, connectors = 0, connectorMetres = 0;
const offPaving = new Map();
for (let pass = 0; pass < 8; pass += 1) {
  rebuild();
  const nodes = new Set();
  for (const [u, v] of edges.values()) { nodes.add(u); nodes.add(v); }

  const adjOf = new Map();
  for (const [u, v] of edges.values()) {
    if (!adjOf.has(u)) adjOf.set(u, new Set());
    if (!adjOf.has(v)) adjOf.set(v, new Set());
    adjOf.get(u).add(v);
    adjOf.get(v).add(u);
  }
  const actions = [];
  for (const n of [...nodes].sort((x, y) => x - y)) {
    const p = coord[n];
    // Every line in reach, nearest first, and not just the nearest: a dead end
    // whose last drawn segment is shorter than JUNCTION_M finds its own
    // neighbour's edges first, and those are rightly turned down.
    const near = [];
    for (const [key, [u, v]] of edges) {
      if (u === n || v === n) continue;
      const d = segDist(p, coord[u], coord[v]);
      if (d <= JUNCTION_M) near.push({ n, d, key, u, v });
    }
    if (!near.length) continue;
    near.sort((x, y) => x.d - y.d || (x.key < y.key ? -1 : 1));
    const reach = junctionDistances(n, JUNCTION_RATIO * JUNCTION_M + 1);
    for (const cand of near) {
      // The guard: only weld where the graph really does send you the long
      // way — to the point on the line it would join, not to the line's
      // nearer end. A fork's two tines meet at their apex, so measured to the
      // ends they are always a few steps apart, however far round the walk
      // from one tine across to the other really is.
      const land = landingOf(cand, JUNCTION_M, JUNCTION_M);
      if (!land) continue;
      const around = Math.min(
        (reach.get(cand.u) ?? Infinity) + dist(coord[cand.u], land.p),
        (reach.get(cand.v) ?? Infinity) + dist(coord[cand.v], land.p),
      );
      if (around <= JUNCTION_RATIO * Math.max(cand.d, 1)) continue;
      // ...and only on paving. A connector is path the sheet does not draw,
      // and it has to lie where the sheet paints pavement: no more than
      // JUNCTION_OFF_M of it off every band and plaza. Where the line it
      // joins forks off the node's own (a fork), all of it on paving, because
      // two tines either side of a planted wedge are far apart by the graph by
      // construction, and the ratio approves a shortcut across the planting.
      if (land.d > WELD_M) {
        const fork = [cand.u, cand.v].some((e) => adjOf.get(n)?.has(e));
        const off = unpaved(p, land.p);
        if (off > (fork ? 0 : capOn(n, adjOf, land.p) ? JUNCTION_CAP_OFF_M : JUNCTION_OFF_M)) {
          offPaving.set(unflat(p).join(','), { off, fork, to: unflat(land.p), around, d: cand.d });
          continue;
        }
      }
      actions.push({ ...cand, around });
      break;
    }
  }
  if (!actions.length) break;

  actions.sort((x, y) => x.d - y.d);
  let applied = 0;
  for (const act of actions) {
    const hit = landOnLine(act, JUNCTION_M, JUNCTION_M);
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

// --- 3e'. cut across the vee where two paths merge ---------------------------
//
// Two paths that merge at a shallow angle are drawn as two strokes whose
// bands run together for metres before their centrelines meet. On the sheet
// that is one wedge of paving, and anyone walking from one path onto the
// other cuts across it. In the graph they meet only at the point of the vee,
// so the walk ran on to the point and came back down the other arm: south of
// the stadium, where walkway 1271 runs into 1314 at 27 degrees, a walk from
// one to the other went 19.5 m east and 10.8 m back, turning through 152
// degrees, on 130 walks between two places; where 1269 runs into 1376 south of
// the ITC, on 155 more.
//
// None of the stages above sees it. JUNCTION asks for a way round six times
// the gap, and a vee is never that: its way round is the two arms. So this
// asks the band instead. At every node, for every two edges leaving it within
// VEE_ANGLE of each other on different strokes, it slides a point back along
// one and drops it square onto the other, and keeps the furthest such chord
// that lies wholly on paving — every sample at least WELL_INSIDE_M inside a
// drawn band or on a plaza — and under no roof. Where that saves VEE_SAVE_M
// or more over the point of the vee, the chord is added as a connector,
// counted and printed beside the junction stage's. The chord sits where the
// two grey bands have already become one, so it is path the sheet does show,
// as paving, and does not draw as a line. Both arms stay exactly as drawn.
//
// A chord's end within a weld of the far end of its arm is that end, at both
// ends of the chord. It was only within LAND_MIN_M at one of them, and three
// chords landed a metre from the junction at the end of their arm, at the
// west entrance and beside the Evangelisti Culinary Arts Center: two
// junctions a stride apart, and every walk through them told to turn, walk
// 3 ft and turn again. Over every walk between two places, instructions
// under 10 ft after the one before went from 514 to 203. Those three chords
// are gone (15 -> 12 chords, 48 -> 42 m), and the walking rises by 2.2 km
// of 3,174, 8.3 m at most.
const VEE_ANGLE = 45;
const VEE_SAVE_M = 4;
const pavedLine = (a, b) => {
  const n = Math.max(1, Math.ceil(dist(a, b) / BAND_STEP_M));
  for (let k = 0; k <= n; k += 1) if (!pavedWell([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])) return false;
  return true;
};
let vees = 0, veeMetres = 0;
const veeAt = [];
for (let pass = 0; pass < 4; pass += 1) {
  rebuild();
  const adj = new Map();
  for (const [u, v] of edges.values()) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  }
  const cands = [];
  for (const [n, around] of [...adj].sort((x, y) => x[0] - y[0])) {
    const o = coord[n];
    for (const a of around) {
      for (const b of around) {
        // Already a triangle: a chord made in an earlier pass, or drawn.
        if (a === b || edges.has(EK(a, b))) continue;
        const ka = EK(n, a), kb = EK(n, b);
        if (shareStroke(edgeS.get(ka) ?? new Set(), edgeS.get(kb) ?? new Set())) continue;
        const ha = Math.atan2(coord[a][1] - o[1], coord[a][0] - o[0]), hb = Math.atan2(coord[b][1] - o[1], coord[b][0] - o[0]);
        let gap = Math.abs(ha - hb);
        if (gap > Math.PI) gap = 2 * Math.PI - gap;
        if (gap > (VEE_ANGLE * Math.PI) / 180) continue;
        const La = dist(o, coord[a]), Lb = dist(o, coord[b]);
        let best = null;
        for (let s = WELD_M; s <= La + 1e-9; s += BAND_STEP_M) {
          // Within a weld of the arm's far end is that end, as it is for the
          // other arm's below. It was only within LAND_MIN_M here, and two
          // chords landed a metre from the junction at the arm's end: two
          // junctions a stride apart, and every walk through them told to
          // turn, walk 3 ft and turn again.
          const t = La - s < WELD_M ? 1 : s / La;
          const X = [o[0] + t * (coord[a][0] - o[0]), o[1] + t * (coord[a][1] - o[1])];
          const f = project(X, o, coord[b]);
          if (f.t * Lb < WELD_M || f.d > JUNCTION_M) continue;
          const Y = (1 - f.t) * Lb < WELD_M ? coord[b] : f.foot;
          if (!pavedLine(X, Y) || underRoof(X, Y)) continue;
          const save = t * La + dist(o, Y) - dist(X, Y);
          if (!best || save > best.save) best = { n, a, b, ka, kb, t, X, Y, ty: (1 - f.t) * Lb < WELD_M ? 1 : f.t, save, chord: dist(X, Y) };
        }
        if (best && best.save >= VEE_SAVE_M) cands.push(best);
      }
    }
  }
  cands.sort((x, y) => y.save - x.save || x.n - y.n);
  let applied = 0;
  const touched = new Set();
  for (const c of cands) {
    if (touched.has(c.ka) || touched.has(c.kb) || !edges.has(c.ka) || !edges.has(c.kb)) continue;
    touched.add(c.ka); touched.add(c.kb);
    const cutAt = (key, from, to, t, p) => {
      if (t >= 1 - 1e-9) return to;
      const w = coord.length, ew = edgeW.get(key) ?? 1, es = edgeS.get(key);
      coord.push(p);
      alias.push(w);
      edges.delete(key);
      addEdge(from, w, ew, es);
      addEdge(w, to, ew, es);
      return w;
    };
    const x = cutAt(c.ka, c.n, c.a, c.t, c.X);
    const y = cutAt(c.kb, c.n, c.b, c.ty, c.Y);
    addEdge(x, y, 1, [...strokesAt(x), ...strokesAt(y)]);
    vees += 1;
    veeMetres += c.chord;
    veeAt.push({ at: unflat(coord[c.n]), save: c.save, chord: c.chord });
    applied += 1;
  }
  if (!applied) break;
}
rebuild();

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

// What a link crosses that the sheet paints as LAWN: sampled like unpaved(),
// off every band and plaza, where the topmost filled surface in the
// cartographer's painter's order is lawn. Printed per link with the count,
// because a link is accepted against imagery and the sheet may disagree —
// the apron between the Student Center and CTE is concrete on the ground and
// lawn on the print — and the disagreement should be on the record, in the
// log and in the link's `why`, rather than discovered by the next audit.
const sheetFills = basemap
  .filter((f) => f.properties.fill)
  .flatMap((f) => surfacesOf(f.geometry).map((rings) => ({ kind: f.properties.kind, i: f.properties.i, rings: rings.map((r) => r.map(flat)) })))
  .map((P) => ({ ...P, box: boxOf(P.rings[0]) }));
function sheetLawn(a, b) {
  const L = dist(a, b);
  const n = Math.max(1, Math.ceil(L / BAND_STEP_M));
  let lawn = 0;
  for (let k = 0; k < n; k += 1) {
    const p = [a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n];
    if (paved(p)) continue;
    let top = null;
    for (const P of sheetFills) {
      if (p[0] < P.box[0] || p[0] > P.box[2] || p[1] < P.box[1] || p[1] > P.box[3]) continue;
      if ((!top || P.i > top.i) && inPoly(p, P)) top = P;
    }
    if (top?.kind === 'lawn') lawn += L / n;
  }
  return lawn;
}

let linkCount = 0, linkMetres = 0, linkLawn = 0;
const linkLawnAt = [];
{
  const file = src('path-links.json');
  const links = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')).features ?? []
    : [];
  for (const link of links) {
    if (link.geometry?.type !== 'LineString') continue;
    const pts = link.geometry.coordinates.map(flat);
    if (pts.length < 2) continue;
    // Only the two ends attach. A vertex between them is where the link bends
    // round something on the ground — the planted bed beside the CTE apron —
    // and is a node of the link's own, not a loose end.
    const inner = (p) => {
      const id = coord.length;
      coord.push(p);
      alias.push(id);
      return id;
    };
    let prev = attach(pts[0]);
    let lawn = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const next = i === pts.length - 1 ? attach(pts[i]) : inner(pts[i]);
      addEdge(find(prev), find(next));
      linkMetres += dist(coord[find(prev)], coord[find(next)]);
      lawn += sheetLawn(coord[find(prev)], coord[find(next)]);
      prev = next;
    }
    linkCount += 1;
    linkLawn += lawn;
    if (lawn >= 0.5) linkLawnAt.push({ at: link.geometry.coordinates[0], lawn });
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
// It is here, after the hand links, because the case it was written for is a
// hand link: the 26.4 m line across the mouth of driveway 1081, from the end of
// the walkway west of Fine & Applied Arts to the College Oak Dr entrance. Its
// east end shares a node with the 6.1 m stroke the walkway turns south by,
// ending 0.41 m off the link; its west end runs back over 3.0 m, 3.0 m and
// 2.5 m of the drawn driveway to the node it was written against. (It used
// to end 3 m further west, on a lane arrow painted down the driveway that the
// walk build read as path, and this comment called those pieces walkway.)
// Snapping onto edges found it: a point beside the link joined it, walked
// 10 m east to the shared node and came 6 m back down the short stroke to
// turn south — "U-turn" in the directions, 48 ft from the start.
//
// So the long edge is rerouted through the short one's far end, which does not
// move: the long edge becomes the short edge plus the rest of the way.
// Repeated to a fixpoint, which walks along a run of short pieces one at a
// time. At the driveway it takes four folds and leaves the crossing as the
// drawn pieces at either end with 11.8 m of link between them, 14.6 m less
// network and no doubled line. Two more fold a 5.8 m chord of one stroke, 27 m
// east of the Hutchison Loop bus stop, onto the 2.3 m and 2.9 m pieces of the
// stroke beside it.
//
// FOLD_ANGLE is the collapse stage's own "runs the same way", DUPE_ANGLE; at
// 8 degrees the last fold, onto a 2.5 m piece of the driveway 19 degrees off
// the link, was missed, and a walk south from the walkway still began by
// going 6 m west and coming back. FOLD_M is "on it": within the metre a drawn stroke
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

// --- 5. across the plazas: the surfaces ---------------------------------------
//
// The sheet draws a walkway two ways: as a stroke with a ground width, which is
// a path and everything above turns into the graph, and as a FILLED shape in
// the same pavement grey, which is a surface. strokeLines() rightly refuses to
// ride the outline of a surface as if it were a path, and until this stage
// nothing else read them at all, so the router only knew the strokes drawn
// round a plaza's edge. A walk from one side of the paving round the STEM
// Innovation Center to the other went all the way round it, on a map that
// shows open paving straight across.
//
// WHICH SURFACES. Every shape filled in PAVEMENT on the walkway, parking or
// driveway layer (PLAZA_KINDS). The colour is what the print shows; the layer
// the cartographer filed a shape on is not. The promenade east of the Career
// Technical Education building is on the parking layer and the wedge between
// the Child Development Center and Kinesiology on the driveway layer, and both
// are the same grey paving as the rest. The car parks' own tarmac is a darker
// grey and is not taken. A closed LineString counts as the ring it draws: the
// apron outside the Welcome and Support Center is filled that way. Anything
// under PLAZA_MIN_M2 is a strip, not a plaza. Ten on today's sheet, by sheet
// index:
//
//   i=1374  8,195 m2  round STEM, the ITC and the Library
//   i=1400  4,301 m2  between TEW and Science & Engineering
//   i=1381  3,796 m2  Kinesiology, Adaptive PE and the Gym, round the pool
//   i=1257  2,619 m2  south and west of CTE
//   i=1399  2,190 m2  between the Welcome and Support Center and Admin
//   i=50    1,890 m2  east of CTE (on the parking layer)
//   i=1395  1,155 m2  between the Welcome and Support Center and the Library
//   i=1080    972 m2  between CDC and Kinesiology (on the driveway layer)
//   i=1398    221 m2  the Welcome and Support Center's apron (a closed line)
//   i=1380    200 m2  between Howard Hall and Raef Hall
//
// WHAT STANDS ON THEM. Everything of a kind that cannot be walked through,
// filled or not (OBSTACLE_CLEARANCE): 101 building footprints and the three
// buildings drawn only as an outline, the closed block, 509 trees and 46
// shrubs in their planters, the pool, 24 rows of bleachers, the tennis courts
// and the pitches, and the 45 bike-rack and 15 permit-machine symbols painted
// on the paving where a rack or a machine stands. Each is kept off by its
// clearance, and a gap between two of them narrower than PLAZA_GAP_M is closed
// too. An outline drawn as an open line is a wall with no inside.

const PLAZA_SAVE_M = 5;
const PLAZA_SAVE = 0.15;
/** How far outside its outline a vertex can sit and still be a way onto a plaza. */
const PLAZA_REACH_M = 2.0;
const PLAZA_STEP_M = 0.5;
/** The narrowest gap between two obstacles a crossing may thread. */
const PLAZA_GAP_M = 1.5;
/** How far a corner looks for a drawn edge to step straight onto, how long that edge is, and how far apart two such steps. */
const PLAZA_FOOT_M = 12;
const PLAZA_FOOT_EDGE_M = 15;
const PLAZA_FOOT_GAP_M = 6;
/** A crossing's end this close to another line's middle meets it there. */
const PLAZA_TEE_M = 1.0;
/** Where crossings are cut, a node already on the line this close is the cut. */
const PLAZA_SNAP_M = 0.3;
/** How much longer than across, in metres and as a share, a pair may go by what is already kept. */
const PLAZA_SPANNER = [{ metres: 1, share: 0.03 }, { metres: 2, share: 0.05 }, { metres: 3, share: 0.08 }];
const PLAZA_LINES_MAX = 150;
/** A crossing this close to the drawn network over this share of its length runs beside it. */
const PLAZA_SHADOW_M = 3;
const PLAZA_SHADOW = 0.5;
/** Clearance round an obstacle, by kind: a metre off a wall, less off a planter. */
const OBSTACLE_CLEARANCE = {
  building: 1.0, closed: 1.0, bleachers: 1.0, pool: 1.0,
  tree: 0.3, shrub: 0.6, sport: 0.3, tennis: 0.3, tennis_apron: 0.3,
  bike_marker: 0.5, permit_machine: 0.5,
};

const toRings = (p, poly) => Math.min(...poly.rings.map((r) => {
  let d = Infinity;
  for (let k = 1; k < r.length; k += 1) d = Math.min(d, segDist(p, r[k - 1], r[k]));
  return d;
}));

// Every outline of a kind that cannot be walked through, filled or not: a
// building's wall drawn as a line is still a wall, and a court drawn as its
// white outline is still a court. An open line is a wall with no inside.
const obstacles = basemap
  .filter((f) => f.properties.kind in OBSTACLE_CLEARANCE)
  .flatMap((f) => {
    const g = f.geometry;
    const solid = g.type !== 'LineString' || closedLine(g.coordinates);
    return (g.type === 'LineString' ? [[g.coordinates]] : surfacesOf(g)).map((rings) => {
      const flatRings = rings.map((r) => r.map(flat));
      const c = OBSTACLE_CLEARANCE[f.properties.kind];
      const [x0, y0, x1, y1] = boxOf(flatRings[0]);
      const m = Math.max(c, PLAZA_GAP_M);
      return { i: f.properties.i, kind: f.properties.kind, clear: c, solid, rings: flatRings, box: [x0 - m, y0 - m, x1 + m, y1 + m] };
    });
  });

const obstacleGrid = gridOf(obstacles, (o) => o.box);

/**
 * Whether a point is too near something that cannot be walked through: inside
 * its clearance, or in a gap between two such things narrower than
 * PLAZA_GAP_M — a row of planters with a metre between them is one hedge.
 */
const blocked = (p) => {
  let near = null;
  for (const o of obstacleGrid.get(cellKey(p[0], p[1])) ?? []) {
    if (p[0] < o.box[0] || p[0] > o.box[2] || p[1] < o.box[1] || p[1] > o.box[3]) continue;
    const d = o.solid && inPoly(p, o) ? 0 : toRings(p, o);
    if (d < o.clear) return true;
    if (d >= PLAZA_GAP_M) continue;
    if (near && near.d + d < PLAZA_GAP_M) return true;
    if (!near || d < near.d) near = { d };
  }
  return false;
};
const walkable = (p) => paved(p) && !blocked(p);
const clearLine = (a, b) => {
  const n = Math.max(1, Math.ceil(dist(a, b) / PLAZA_STEP_M));
  for (let k = 0; k <= n; k += 1) {
    if (!walkable([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])) return false;
  }
  return true;
};
/** Whether a vertex is a way onto plaza P: on it, or within PLAZA_REACH_M of its edge, and not in an obstacle. */
const portalOf = (P, p) => p[0] >= P.box[0] - PLAZA_REACH_M && p[0] <= P.box[2] + PLAZA_REACH_M
  && p[1] >= P.box[1] - PLAZA_REACH_M && p[1] <= P.box[3] + PLAZA_REACH_M
  && (inPoly(p, P) || toRings(p, P) <= PLAZA_REACH_M) && !blocked(p);

// FRAGMENTS, held until the plazas have been crossed. Pieces the drawing does
// not join to the rest used to go here, before anything was spliced onto
// them: splicing first strands a destination whose nearest edge is in a piece
// that is then dropped. But a piece that ends on a plaza is joined to the rest
// by the plaza — the aprons the sheet draws from the Career Technical
// Education building's doors out onto the paving south and west of it, and
// from the Child Development Center's north door, stop on the paving and
// touch no stroke. So a piece with a vertex that is a way onto a plaza is
// held, and the plaza stage below decides; the rest go now, as before.
const fragments = components().slice(1);
const mainNode = components()[0][0];
const held = fragments.filter((c) => c.some((n) => plazas.some((P) => portalOf(P, coord[n]))));
{
  const keepNodes = new Set([...components()[0], ...held.flat()]);
  for (const [key, [u, v]] of [...edges]) {
    if (!keepNodes.has(u) || !keepNodes.has(v)) edges.delete(key);
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
// Every node a destination or an entrance ended on, to say if any is left
// on a piece that does not ship.
const placeNodes = [];
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
    const door = doorFor(p, stubs, onNetwork);
    if (door !== null) { atDoor += 1; placeNodes.push(door); continue; }
    const id = spliceOnto(p);
    if (id !== null) { spliced += 1; placeNodes.push(id); }
  }
}

// ENTRANCES, the same way. build-directory.mjs sends a building's Directions
// to where its walls come nearest the network — every corner about as near as
// the nearest, see wallNearest() in building-names.mjs, and for a building
// drawn as several footprints the point nearest each of them, memberNearest()
// — and a point on an edge is no vertex until something splices one there. The directory used to
// take the nearest VERTEX instead, which made the entrance depend on where the
// stages above happened to leave one: when COLLAPSE took the Learning Resource
// Center's away, its entrance moved 53 m to the next corner whose vertex had
// survived, with the network still passing 0.3 m from the old one. The
// buildings are buildings.json's, grouped and named as the directory groups
// and names them, so each point spliced is one the directory asks for.
let entranceNodes = 0, entranceSplices = 0, memberNodes = 0, memberSplices = 0;
{
  const footprints = adoptPrintedNames(loadFootprints(src('buildings.json')),
    JSON.parse(readFileSync(src('labels.json'), 'utf8')).features);
  for (const group of groupByName(footprints).values()) {
    const segments = [...edges.values()].map(([u, v]) => [unflat(coord[u]), unflat(coord[v])]);
    for (const { at } of wallNearest(group, segments)) {
      const before = coord.length;
      const id = spliceOnto(flat(at));
      if (id === null) continue;
      placeNodes.push(id);
      entranceNodes += 1;
      if (coord.length > before) entranceSplices += 1;
    }
  }
}

// --- 5. across the plazas: the crossings ---------------------------------------
//
// Each plaza is walked the way open ground is walked: a visibility graph. Its
// nodes are its WAYS ON and the corners worth turning at. The ways on are
// every vertex of the network on the plaza or within PLAZA_REACH_M of its edge
// (the fragments held above among them), every point where a drawn edge crosses
// its outline, and points on the long drawn edges beside it (below). The
// corners are each convex corner of an obstacle, pushed out past its
// clearance, and each reflex corner of the plaza's own outline, pushed in. Two
// nodes see each other when the straight line between them stays on pavement
// (inside a plaza, or on the drawn band of a stroke) and walkable, tested every
// PLAZA_STEP_M, which is finer than anything on the sheet that could be missed
// between samples.
//
// THE OUTLINE ITSELF GETS NO CLEARANCE, only its reflex corners. Two ways on
// the outline see each other along it, so where a plaza's edge meets lawn
// rather than more paving a crossing can run on the edge: 191 m of the 4,628 m
// has unpaved ground within 0.75 m of one side, most of it along the paving
// west and east of CTE, and a route there is drawn on the grey's edge. It is
// on the paving; an inset off an edge that meets lawn would keep it a stride
// in, at the price of every figure in this stage.
//
// A pair of ways on is worth a crossing when the way across the plaza is
// shorter than the way round by the drawn network, by PLAZA_SAVE_M and by
// PLAZA_SAVE of the way round. That rule is a judgement, not a proof: a
// walk that carries on past the two ways on can want a crossing between two
// that do not qualify. It keeps a route from being pulled off a drawn path to
// save a stride. On today's sheet 1,090 pairs qualify, and their shortest
// paths across are 716 lines, 19.3 km. Most of those are near-twins (see THE
// SPANNER below), and what is kept is 221 lines, 4.8 km. Noded with each
// other and with the network, those become the 590 pieces, 4,628 m, that
// ship. When this was measured on the network of the time, keeping every path
// instead, 643 lines once one pair's path serves another, saved 166.4 km over
// every walk between two places, by what the router weighs, and the lines
// kept 157.7 km, 95% of that.
//
// What ships goes to src/plaza-paths.json, not paths.json, for the reason
// approach-paths.json is separate: paths.json is what the map DRAWS, and these
// lines are not drawn — the plaza already is, as paving, and a route across it
// shows on its own ribbon. The router unions the file in (see `plazas` in
// createGraph()) and measures nothing to it: a plaza line is offered beside the
// drawn network, never instead of it. Ways on are shipped vertices at the
// coordinates they shipped at, so the two files weld exactly; the corners, and
// the points where two crossings cross, are vertices only plaza lines touch.
// There are 268 of those.

/** Dijkstra over `adj` (node -> [{ v, w, line }]) from one node, out to `cap` metres or until `target` is settled. */
function plazaDijkstra(adj, from, cap = Infinity, target = null) {
  const d = new Map([[from, 0]]);
  const prev = new Map();
  const heap = [[0, from]];
  const push = (item) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (heap[up][0] <= heap[i][0]) break;
      [heap[up], heap[i]] = [heap[i], heap[up]];
      i = up;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [du, u] = pop();
    if (du > d.get(u)) continue;
    if (u === target) break;
    for (const { v, w, line } of adj.get(u) ?? []) {
      if (line?.removed) continue;
      const dv = du + w;
      if (dv > cap || dv >= (d.get(v) ?? Infinity)) continue;
      d.set(v, dv);
      prev.set(v, { u, line });
      push([dv, v]);
    }
  }
  return { d, prev };
}
const link = (adj, u, v, w, line = null) => {
  if (!adj.has(u)) adj.set(u, []);
  if (!adj.has(v)) adj.set(v, []);
  adj.get(u).push({ v, w, line });
  adj.get(v).push({ v: u, w, line });
};

// Every node of the crossings by key: a drawn node by its id, and `c`orners,
// `f`eet on drawn edges and `x` crossings by name. `at` is where it is.
const plazaNode = new Map();
const nodeKeyOf = (n) => {
  if (!plazaNode.has(n)) plazaNode.set(n, { key: n, at: coord[n] });
  return n;
};
const liveNodes = [...new Set([...edges.values()].flat())].sort((x, y) => x - y);

// The drawn edges as they stand, for the feet and the shadow test.
const drawnSegs = [...edges].map(([key, [u, v]]) => ({ key, u, v, a: coord[u], b: coord[v] }));
const drawnGrid = gridOf(drawnSegs, ({ a, b }) => [
  Math.min(a[0], b[0]) - PLAZA_FOOT_M, Math.min(a[1], b[1]) - PLAZA_FOOT_M,
  Math.max(a[0], b[0]) + PLAZA_FOOT_M, Math.max(a[1], b[1]) + PLAZA_FOOT_M,
]);
const nearDrawn = (p) => drawnGrid.get(cellKey(p[0], p[1])) ?? [];
/** Every drawn edge whose box comes near the line a-b. */
const drawnAlong = (a, b) => {
  const out = new Set();
  const n = Math.max(1, Math.ceil(dist(a, b) / (CELL / 2)));
  for (let k = 0; k <= n; k += 1) {
    for (const seg of nearDrawn([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])) out.add(seg);
  }
  return [...out];
};

// Feet: points on drawn edges a crossing may start from, by edge, each `t` of
// the way along it. Shared between plazas, so two that step onto one edge at
// one place step onto one node.
const feetOn = new Map();
let footCount = 0;
function footAt(seg, t, apart = WELD_M) {
  const L = dist(seg.a, seg.b);
  if (t * L < WELD_M) return nodeKeyOf(seg.u);
  if ((1 - t) * L < WELD_M) return nodeKeyOf(seg.v);
  const list = feetOn.get(seg.key) ?? [];
  const same = list.find((f) => Math.abs(f.t - t) * L < apart);
  if (same) return same.key;
  const key = `f${footCount += 1}`;
  const at = flat(unflat([seg.a[0] + t * (seg.b[0] - seg.a[0]), seg.a[1] + t * (seg.b[1] - seg.a[1])]));
  list.push({ key, t });
  feetOn.set(seg.key, list);
  plazaNode.set(key, { key, at, foot: seg });
  return key;
}

// A corner: each convex corner of an obstacle near the plaza, pushed out
// along its bisector past the clearance; each reflex corner of the plaza's
// own outline, pushed half a metre in.
const cornerOf = (r, k, sign, push) => {
  const n = r.length - 1;                          // rings repeat their first vertex
  const p = r[k], a = r[(k - 1 + n) % n], b = r[(k + 1) % n];
  const ua = [(a[0] - p[0]) / (dist(a, p) || 1), (a[1] - p[1]) / (dist(a, p) || 1)];
  const ub = [(b[0] - p[0]) / (dist(b, p) || 1), (b[1] - p[1]) / (dist(b, p) || 1)];
  const cross = ua[0] * ub[1] - ua[1] * ub[0];
  // On a counter-clockwise ring a convex corner turns right (cross < 0) and a
  // reflex one left; `sign` says which is wanted, already flipped for winding.
  if (Math.sign(cross) * sign <= 0) return null;
  const bis = [ua[0] + ub[0], ua[1] + ub[1]];
  const L = Math.hypot(...bis);
  if (L < 1e-6) return null;
  return [p[0] - (bis[0] / L) * push, p[1] - (bis[1] / L) * push];
};

let cornerCount = 0;
const plazaRuns = [];
for (const P of plazas) {
  const reach = [P.box[0] - PLAZA_REACH_M, P.box[1] - PLAZA_REACH_M, P.box[2] + PLAZA_REACH_M, P.box[3] + PLAZA_REACH_M];
  const keys = [];
  const has = new Set();
  const add = (key) => { if (!has.has(key)) { has.add(key); keys.push(key); } };
  const near = (q) => keys.some((k) => dist(plazaNode.get(k).at, q) < WELD_M);

  // Ways on: the network's vertices on the plaza or within reach of its edge.
  for (const n of liveNodes) if (portalOf(P, coord[n])) add(nodeKeyOf(n));
  // ...and where a drawn edge crosses its outline, away from the edge's ends.
  for (const seg of drawnSegs) {
    for (const r of P.rings) {
      for (let k = 1; k < r.length; k += 1) {
        const hit = crossing(seg.a, seg.b, r[k - 1], r[k]);
        if (!hit) continue;
        const q = [seg.a[0] + hit[0] * (seg.b[0] - seg.a[0]), seg.a[1] + hit[0] * (seg.b[1] - seg.a[1])];
        if (!blocked(q)) add(footAt(seg, hit[0]));
      }
    }
  }

  // Corners worth turning at, welded: none within WELD_M of a way on or of
  // a corner already taken, so a row of planters is not a fan of near-twins.
  const corners = [];
  const take = (q) => {
    if (!q || !walkable(q) || near(q)) return;
    const key = `c${cornerCount += 1}`;
    plazaNode.set(key, { key, at: q });
    add(key);
    corners.push(key);
  };
  for (const o of obstacles) {
    if (!o.solid || o.box[2] < reach[0] || o.box[0] > reach[2] || o.box[3] < reach[1] || o.box[1] > reach[3]) continue;
    const r = o.rings[0];
    const orient = Math.sign(ringArea(r));
    for (let k = 0; k < r.length - 1; k += 1) take(cornerOf(r, k, -orient, o.clear + 0.3));
  }
  {
    const r = P.rings[0];
    const orient = Math.sign(ringArea(r));
    for (let k = 0; k < r.length - 1; k += 1) take(cornerOf(r, k, orient, 0.5));
  }

  // ...and from each corner, straight onto the long drawn edge beside it:
  // its foot on the nearest edge of PLAZA_FOOT_EDGE_M or more within
  // PLAZA_FOOT_M, if it can see it, and one step every PLAZA_FOOT_GAP_M along
  // it at most. A long edge along a plaza has no vertex in its middle to cross
  // from — the 107 m south face of STEM has none in 107 m — and a short one
  // has its ends.
  for (const c of corners) {
    const p = plazaNode.get(c).at;
    const seg = nearDrawn(p)
      .filter((sg) => dist(sg.a, sg.b) >= PLAZA_FOOT_EDGE_M && segDist(p, sg.a, sg.b) <= PLAZA_FOOT_M)
      .sort((x, y) => segDist(p, x.a, x.b) - segDist(p, y.a, y.b) || x.key.localeCompare(y.key))[0];
    if (!seg) continue;
    const vx = seg.b[0] - seg.a[0], vy = seg.b[1] - seg.a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - seg.a[0]) * vx + (p[1] - seg.a[1]) * vy) / (vx * vx + vy * vy)));
    if (clearLine(p, [seg.a[0] + t * vx, seg.a[1] + t * vy])) add(footAt(seg, t, PLAZA_FOOT_GAP_M));
  }
  plazaRuns.push({ P, keys });
}

// The drawn network with every foot in it, by node: what a crossing is
// judged against, and what the kept crossings are added to.
const network = new Map();
for (const seg of drawnSegs) {
  const chain = [{ t: 0, key: seg.u }, ...(feetOn.get(seg.key) ?? []), { t: 1, key: seg.v }].sort((x, y) => x.t - y.t);
  const L = dist(seg.a, seg.b);
  for (let k = 1; k < chain.length; k += 1) link(network, chain[k - 1].key, chain[k].key, (chain[k].t - chain[k - 1].t) * L);
}

// The visibility graph of each plaza, and every pair of ways on that is
// shorter across it than round it by PLAZA_SAVE_M and PLAZA_SAVE.
const pairs = [];
for (const run of plazaRuns) {
  const { P, keys } = run;
  const vis = new Map();
  const at = keys.map((k) => plazaNode.get(k).at);
  for (let x = 0; x < keys.length; x += 1) {
    for (let y = x + 1; y < keys.length; y += 1) {
      if (clearLine(at[x], at[y])) link(vis, keys[x], keys[y], dist(at[x], at[y]));
    }
  }
  const portals = keys.filter((k) => !String(k).startsWith('c'));
  const span = dist([P.box[0], P.box[1]], [P.box[2], P.box[3]]);
  run.portals = portals.length;
  run.nodes = keys.length;
  run.pairs = 0;
  for (const [x, a] of portals.entries()) {
    const across = plazaDijkstra(vis, a, span * 2);
    const round = plazaDijkstra(network, a, span * 6);
    for (const b of portals.slice(x + 1)) {
      const dAcross = across.d.get(b);
      if (dAcross === undefined) continue;
      const dRound = round.d.get(b) ?? Infinity;
      if (dRound - dAcross < Math.max(PLAZA_SAVE_M, PLAZA_SAVE * dRound)) continue;
      const path = [b];
      for (let v = b; v !== a; v = across.prev.get(v).u) path.push(across.prev.get(v).u);
      pairs.push({ a, b, dAcross, dRound, path: path.reverse(), plaza: P.i });
      run.pairs += 1;
    }
  }
}

// THE SPANNER. Every qualifying pair's whole path was the first cut, and it
// kept fans of near-twins: 247 lines for 206 pairs, a dozen of them meeting at
// one point, and every instruction on a walk across them a few feet from the
// last. Shortest pair first, a path is kept only where the network and the
// crossings kept so far do not already go within a metre and 3% of it. If that
// still leaves more than PLAZA_LINES_MAX, the next tier of PLAZA_SPANNER is
// tried, then the one after. On today's sheet the three tiers keep 346, 294
// and 221 lines, so it is the last one, within 3 m and 8%, that ships. That is
// still over the mark, because the pairs to serve are five times what they
// were when the mark was set (1,090 against 206) now that the feet, the
// outline crossings and four more plazas are counted. Over every walk between
// two places, 203 instructions come under 10 ft after the one before with the
// crossings, against 234 without them.
const lineKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);
pairs.sort((x, y) => x.dAcross - y.dAcross);
let lines, graph, slack;
for (slack of PLAZA_SPANNER) {
  const { metres, share } = slack;
  lines = new Map();
  graph = new Map([...network].map(([k, list]) => [k, [...list]]));
  for (const pair of pairs) {
    const limit = pair.dAcross + Math.max(metres, share * pair.dAcross);
    if ((plazaDijkstra(graph, pair.a, limit, pair.b).d.get(pair.b) ?? Infinity) <= limit) continue;
    for (let k = 1; k < pair.path.length; k += 1) {
      const [u, v] = [pair.path[k - 1], pair.path[k]];
      if (lines.has(lineKey(u, v))) continue;
      const line = { u, v, plaza: pair.plaza };
      lines.set(lineKey(u, v), line);
      link(graph, u, v, dist(plazaNode.get(u).at, plazaNode.get(v).at), line);
    }
  }
  if (lines.size <= PLAZA_LINES_MAX) break;
}
const linesSpanned = lines.size;
const metresOf = (list) => list.reduce((s, l) => s + dist(plazaNode.get(l.u).at, plazaNode.get(l.v).at), 0);
const metresSpanned = metresOf([...lines.values()]);
const linesAll = new Set(pairs.flatMap((p) => p.path.slice(1).map((v, k) => lineKey(p.path[k], v))));
const metresAll = [...linesAll].reduce((s, k) => {
  const [u, v] = k.split('|');
  const node = (x) => plazaNode.get(/^\d+$/.test(x) ? Number(x) : x);
  return s + dist(node(u).at, node(v).at);
}, 0);

// A CROSSING THAT RUNS BESIDE A DRAWN PATH is dropped, where it can be: one
// within PLAZA_SHADOW_M of the network for PLAZA_SHADOW of its length pulls a
// walk a metre or two off the path it is beside — the hook beside the Math
// Learning Center. Unless dropping it costs some pair more than PLAZA_SAVE_M
// over what the spanner gave it.
const shadowOf = (line) => {
  const a = plazaNode.get(line.u).at, b = plazaNode.get(line.v).at;
  const n = Math.max(1, Math.ceil(dist(a, b) / PLAZA_STEP_M));
  let near = 0;
  for (let k = 0; k <= n; k += 1) {
    const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
    if (nearDrawn(p).some((seg) => segDist(p, seg.a, seg.b) <= PLAZA_SHADOW_M)) near += 1;
  }
  return near / (n + 1);
};
let shadowed = 0, shadowMetres = 0;
{
  // No pair is further by the spanner than the looser of its two tolerances.
  const walk = (pair) => {
    const cap = pair.dAcross + Math.max(2, 0.05 * pair.dAcross) + PLAZA_SAVE_M;
    const { d, prev } = plazaDijkstra(graph, pair.a, cap, pair.b);
    const used = new Set();
    for (let v = pair.b; v !== pair.a && prev.has(v); v = prev.get(v).u) if (prev.get(v).line) used.add(prev.get(v).line);
    return { d: d.get(pair.b) ?? Infinity, used };
  };
  const now = pairs.map(walk);
  const spanned = now.map((w) => w.d);
  const beside = [...lines.values()].map((line) => ({ line, share: shadowOf(line) }))
    .filter((s) => s.share >= PLAZA_SHADOW)
    .sort((x, y) => y.share - x.share || lineKey(x.line.u, x.line.v).localeCompare(lineKey(y.line.u, y.line.v)));
  for (const { line } of beside) {
    line.removed = true;
    const touched = pairs.map((_, k) => k).filter((k) => now[k].used.has(line));
    const after = touched.map((k) => walk(pairs[k]));
    if (after.some((w, j) => w.d > spanned[touched[j]] + PLAZA_SAVE_M)) {
      line.removed = false;
      continue;
    }
    touched.forEach((k, j) => { now[k] = after[j]; });
    lines.delete(lineKey(line.u, line.v));
    shadowed += 1;
    shadowMetres += dist(plazaNode.get(line.u).at, plazaNode.get(line.v).at);
  }
}

// NODED, as the drawn strokes are (see NODE): where two crossings cross, or a
// crossing crosses a drawn edge, both are cut there, and a crossing's end
// within PLAZA_TEE_M of another line's middle meets it — the router joins
// lines only at a shared vertex, and a corner 0.4 m from another crossing was
// 78 m from it by the graph. A drawn edge cut this way is cut at a point on
// it, so the drawing does not move.
let plazaNoded = 0, plazaTeed = 0, plazaSnapped = 0, crossingCount = 0;
{
  const cutsOf = new Map();                         // line -> [{ t, key }]
  const cut = (line, t, key) => {
    if (!cutsOf.has(line)) cutsOf.set(line, []);
    cutsOf.get(line).push({ t, key });
  };
  const drawnAt = (seg, t) => footAt(seg, t);       // a cut on a drawn edge is a foot
  const list = [...lines.values()];
  const ends = (l) => [plazaNode.get(l.u).at, plazaNode.get(l.v).at];
  const named = (q) => {
    const key = `x${crossingCount += 1}`;
    plazaNode.set(key, { key, at: flat(unflat(q)) });
    return key;
  };
  // SNAPPED: a cut within PLAZA_SNAP_M of a node the crossings already have —
  // an end of one of them, or a cut made before — is made at that node. Three
  // lines through one point cross at three points a few centimetres apart, and
  // lines that graze a corner on their way past cross beside it; each of
  // those was a node of its own, with a line of a centimetre or two from it to
  // the next: 13 under 10 cm, the shortest 1.4 cm.
  const inPlay = [...new Set(list.flatMap((l) => [l.u, l.v]))];
  const snapTo = (q) => {
    let best = null;
    for (const k of inPlay) {
      const d = dist(plazaNode.get(k).at, q);
      if (d < PLAZA_SNAP_M && (!best || d < best.d)) best = { k, d };
    }
    return best?.k ?? null;
  };
  const cutOnce = (line, t, key) => {
    if (key !== line.u && key !== line.v && !(cutsOf.get(line) ?? []).some((c) => c.key === key)) cut(line, t, key);
  };
  for (let x = 0; x < list.length; x += 1) {
    const [a, b] = ends(list[x]);
    for (let y = x + 1; y < list.length; y += 1) {
      const A = list[x], B = list[y];
      if ([A.u, A.v].some((k) => k === B.u || k === B.v)) continue;
      const [c, d] = ends(B);
      const hit = crossing(a, b, c, d);
      if (!hit || hit.some((t) => t < 1e-6 || t > 1 - 1e-6)) continue;
      const q = [a[0] + hit[0] * (b[0] - a[0]), a[1] + hit[0] * (b[1] - a[1])];
      const near = snapTo(q);
      if (near !== null) plazaSnapped += 1;
      const key = near ?? named(q);
      if (near === null) inPlay.push(key);
      cutOnce(A, hit[0], key);
      cutOnce(B, hit[1], key);
      plazaNoded += 1;
    }
    for (const seg of drawnAlong(a, b)) {
      if ([seg.u, seg.v].some((k) => k === list[x].u || k === list[x].v)) continue;
      const hit = crossing(a, b, seg.a, seg.b);
      if (!hit || hit.some((t) => t < 1e-6 || t > 1 - 1e-6)) continue;
      const key = drawnAt(seg, hit[1]);
      if (key === list[x].u || key === list[x].v) continue;
      if (!(cutsOf.get(list[x]) ?? []).some((c) => c.key === key)) {
        cut(list[x], hit[0], key);
        if (!inPlay.includes(key)) inPlay.push(key);
        plazaNoded += 1;
      }
    }
  }
  // Tees: an end near another line's middle.
  const tees = [];
  const endsOf = new Set(list.flatMap((l) => [l.u, l.v]));
  for (const e of endsOf) {
    const p = plazaNode.get(e).at;
    for (const l of list) {
      if (l.u === e || l.v === e) continue;
      const [a, b] = ends(l);
      if (segDist(p, a, b) > PLAZA_TEE_M) continue;
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy);
      const L = Math.hypot(vx, vy);
      if (t * L < WELD_M || (1 - t) * L < WELD_M) continue;
      const q = [a[0] + t * vx, a[1] + t * vy];
      if (!clearLine(p, q)) continue;
      const near = snapTo(q);
      if (near === e) continue;
      if (near !== null) plazaSnapped += 1;
      const key = near ?? named(q);
      if (near === null) inPlay.push(key);
      cutOnce(l, t, key);
      tees.push({ u: e, v: key, plaza: l.plaza });
    }
    // Onto a drawn edge only from a corner or a crossing: two drawn paths
    // that pass close and never meet are the junction stage's to join.
    if (!/^[cx]/.test(String(e))) continue;
    for (const seg of nearDrawn(p)) {
      if (seg.u === e || seg.v === e || segDist(p, seg.a, seg.b) > PLAZA_TEE_M) continue;
      const vx = seg.b[0] - seg.a[0], vy = seg.b[1] - seg.a[1];
      const t = ((p[0] - seg.a[0]) * vx + (p[1] - seg.a[1]) * vy) / (vx * vx + vy * vy);
      if (t <= 0 || t >= 1) continue;
      const key = footAt(seg, t);
      if (key === e || !clearLine(p, plazaNode.get(key).at)) continue;
      tees.push({ u: e, v: key, plaza: list.find((l) => l.u === e || l.v === e).plaza });
    }
  }
  for (const line of list) {
    const cs = cutsOf.get(line);
    if (!cs) continue;
    lines.delete(lineKey(line.u, line.v));
    const chain = [{ t: 0, key: line.u }, ...cs.sort((x, y) => x.t - y.t), { t: 1, key: line.v }];
    for (let k = 1; k < chain.length; k += 1) {
      if (chain[k].key === chain[k - 1].key) continue;
      lines.set(lineKey(chain[k - 1].key, chain[k].key), { u: chain[k - 1].key, v: chain[k].key, plaza: line.plaza });
    }
  }
  for (const tee of tees) {
    if (tee.u === tee.v || lines.has(lineKey(tee.u, tee.v))) continue;
    lines.set(lineKey(tee.u, tee.v), tee);
    plazaTeed += 1;
  }
}

// A corner or crossing only one line still reaches is a way to nowhere — the
// line that carried on from it went beside a drawn path, above — and so is
// the line to it. Off, and again, until every one turns somewhere.
let danglers = 0;
for (;;) {
  const degree = new Map();
  for (const l of lines.values()) for (const k of [l.u, l.v]) degree.set(k, (degree.get(k) ?? 0) + 1);
  const loose = [...lines].filter(([, l]) => [l.u, l.v].some((k) => /^[cx]/.test(String(k)) && degree.get(k) === 1));
  if (!loose.length) break;
  for (const [key] of loose) lines.delete(key);
  danglers += loose.length;
}

// The feet the kept crossings use become vertices of the drawn edges they
// are on, and nothing else does: an edge is cut only where a crossing leaves
// it. The rest of the drawing is untouched.
let edgesSplit = 0, feetUsed = 0;
{
  const used = new Set([...lines.values()].flatMap((l) => [l.u, l.v]));
  for (const seg of drawnSegs) {
    const feet = (feetOn.get(seg.key) ?? []).filter((f) => used.has(f.key)).sort((x, y) => x.t - y.t);
    if (!feet.length) continue;
    const w = edgeW.get(seg.key) ?? 1, s = edgeS.get(seg.key);
    edges.delete(seg.key);
    let from = seg.u;
    for (const f of feet) {
      const id = coord.length;
      coord.push(plazaNode.get(f.key).at);
      plazaNode.get(f.key).id = id;
      addEdge(from, id, w, s);
      from = id;
    }
    addEdge(from, seg.v, w, s);
    edgesSplit += 1;
    feetUsed += feet.length;
  }
}

// The point nearest each shard of a building drawn as several footprints
// (memberNearest() in building-names.mjs), spliced last, once the plazas are
// crossed: an extra vertex on a drawn edge beside a plaza is one more way onto
// it, and these are for the directory's ways in, not for the crossings.
{
  const footprints = adoptPrintedNames(loadFootprints(src('buildings.json')),
    JSON.parse(readFileSync(src('labels.json'), 'utf8')).features);
  for (const group of groupByName(footprints).values()) {
    const segments = [...edges.values()].map(([u, v]) => [unflat(coord[u]), unflat(coord[v])]);
    for (const { at } of memberNearest(group, segments)) {
      const before = coord.length;
      const id = spliceOnto(flat(at));
      if (id === null) continue;
      placeNodes.push(id);
      memberNodes += 1;
      if (coord.length > before) memberSplices += 1;
    }
  }
}

// --- ship -------------------------------------------------------------------
//
// What ships is what a walk can reach from the network's main piece: by the
// drawn edges, and across the plazas. A fragment a crossing joins ships with
// it, in paths.json, drawn like any other stroke; what nothing joins is left
// out, as it always was.
const idOf = (k) => (typeof k === 'number' ? k : plazaNode.get(k).id ?? k);
const keep = new Set();
let rescued = 0;
{
  const adj = new Map();
  const join = (u, v) => {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u).push(v);
    adj.get(v).push(u);
  };
  for (const [u, v] of edges.values()) join(u, v);
  for (const l of lines.values()) join(idOf(l.u), idOf(l.v));
  const stack = [mainNode];
  keep.add(mainNode);
  while (stack.length) for (const m of adj.get(stack.pop()) ?? []) if (!keep.has(m)) { keep.add(m); stack.push(m); }
  rescued = held.filter((c) => keep.has(c[0])).length;
  for (const [key, l] of [...lines]) if (!keep.has(idOf(l.u))) lines.delete(key);
}
const stranded = placeNodes.filter((n) => !keep.has(n)).length;

const renumber = new Map();
[...keep].filter((id) => typeof id === 'number').sort((a, b) => a - b).forEach((id) => renumber.set(id, renumber.size + 1));

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

// The crossings, at the coordinates their ends shipped at, so the two files
// weld exactly; corners and crossings are new vertices only crossings touch.
const llOf = (k) => unflat(typeof idOf(k) === 'number' ? coord[idOf(k)] : plazaNode.get(k).at);
const plazaFeatures = [...lines.values()]
  .map((l) => ({
    type: 'Feature',
    properties: { plaza: l.plaza },
    geometry: { type: 'LineString', coordinates: [llOf(l.u), llOf(l.v)].sort(byLonLat) },
  }))
  .filter((f) => f.geometry.coordinates[0].join() !== f.geometry.coordinates[1].join())
  .sort((x, y) => x.properties.plaza - y.properties.plaza
    || byLonLat(x.geometry.coordinates[0], y.geometry.coordinates[0])
    || byLonLat(x.geometry.coordinates[1], y.geometry.coordinates[1]));
writeFileSync(src('plaza-paths.json'), `${JSON.stringify({ type: 'FeatureCollection', features: plazaFeatures })}\n`);
const plazaMetres = plazaFeatures.reduce((s, f) => s + dist(...f.geometry.coordinates.map(flat)), 0);
const plazaNodes = new Set(plazaFeatures.flatMap((f) => f.geometry.coordinates.map(String)));
const shippedLL = new Set(features.flatMap((f) => f.geometry.coordinates.map(String)));
const plazaOnly = [...plazaNodes].filter((c) => !shippedLL.has(c)).length;
for (const run of plazaRuns) {
  const mine = plazaFeatures.filter((f) => f.properties.plaza === run.P.i);
  run.lines = mine.length;
  run.metres = mine.reduce((s, f) => s + dist(...f.geometry.coordinates.map(flat)), 0);
}

const metres = features.reduce((s, f) => {
  const [a, b] = f.geometry.coordinates.map(flat);
  return s + dist(a, b);
}, 0);
const byKind = (list) => Object.entries(list.reduce((acc, s) => {
  acc[s.kind] = (acc[s.kind] ?? 0) + 1;
  return acc;
}, {})).map(([k, n]) => `${k} ${n}`).join(', ');

console.log(`[walk-network] ${strokes.length} drawn strokes taken verbatim (${byKind(strokes)})`);
for (const m of standoffs) {
  console.log(`[walk-network]    ${m.kind} ${m.i}: about ${Math.round(m.metres)} m along the wall of sheet ${m.F}, up to ${m.depth.toFixed(2)} m under it, `
    + `stood off to the middle of the band that shows (up to ${m.by.toFixed(1)} m out)`);
}
console.log(`[walk-network] ${dropped.length} dropped as duplicates (${byKind(dropped.map((d) => d.s))})`);
console.log(`[walk-network] ${tailKept} kept despite being mostly shadowed — an uncovered tail over ${DUPE_TAIL_M} m`);
for (const { s, by } of dropped.slice(0, 6)) {
  console.log(`[walk-network]    ${s.kind} ${Math.round(s.len)} m covered by ${by.kind} ${Math.round(by.len)} m`);
}
if (dropped.length > 6) console.log(`[walk-network]    ...and ${dropped.length - 6} more`);
console.log(`[walk-network] ${kept.length} kept, ${intersections} crossings noded, welded at ${WELD_M} m`);
console.log(`[walk-network] ${collapsed} nodes collapsed onto a duplicate corridor `
  + `(tolerance = half the sum of the two drawn widths, min ${DUPE_M} m), `
  + `${strayed.size} refused for dragging an edge over ${STRAY_M} m off the paving`);
console.log(`[walk-network] ${Math.round(wallMetres)} m in ${wallPieces} pieces cut away at building walls, `
  + 'drawn where the print paints a building over them');
for (const c of cornerMoves) {
  console.log(`[walk-network]    a junction under the wall of sheet ${c.F} moved out from ${c.from.join(',')} to ${c.to.join(',')}, `
    + `${dist(flat(c.from), flat(c.to)).toFixed(1)} m, onto the paving outside`);
}
console.log(`[walk-network]    ${roofJoins} stub end(s) under a roof joined to the path beyond the wall instead, `
  + `${roofConnectors} by connector: ${Math.round(roofConnectorMetres)} m the sheet does not draw`);
for (const j of roofJoined) {
  const around = Number.isFinite(j.around) ? `${Math.round(j.around)} m` : 'no way';
  console.log(`[walk-network]       at ${j.at.join(',')}: ${j.gap.toFixed(1)} m gap, ${around} round against ${Math.round(j.through)} m through`);
}
for (const p of passages) {
  const around = Number.isFinite(p.around) ? `${Math.round(p.around)} m` : 'no way';
  const bare = p.bare >= BARE_M ? `, ${p.bare.toFixed(1)} m of it bare` : '';
  console.log(`[walk-network]    through sheet ${p.under.join('+')} at ${p.at.join(',')}: ${Math.round(p.metres)} m under the roof${bare}, `
    + `${p.outcome} (${around} round against ${Math.round(p.through)} m through)`);
}
console.log(`[walk-network]    ${bareKept.toFixed(1)} m kept where no pavement shows, all of it listed in path-links.json; `
  + `${wallChords} passage(s) rejoined outside the wall: ${wallChordMetres.toFixed(1)} m the sheet does not draw`);
for (const [i, p] of passageExceptions) {
  if (!p.used) console.warn(`[walk-network]    WARNING: path-links.json lists a passage under sheet ${i} that no longer needs it`);
}
console.log(`[walk-network] ${teed} dead ends teed onto the stroke they stopped short of within ${TEE_M} m`);
console.log(`[walk-network] ${welded} near-miss junctions welded within ${JUNCTION_M} m (only where the graph made you walk ${JUNCTION_RATIO}x further around)`);
console.log(`[walk-network]    ${connectors} of them wider than a weld, joined by a connector instead: ${Math.round(connectorMetres)} m the sheet does not draw`);
for (const [at, r] of offPaving) {
  console.log(`[walk-network]    refused at ${at}: a ${r.d.toFixed(1)} m connector${r.fork ? ' across a fork' : ''} `
    + `${r.off.toFixed(1)} m off the paving (${Number.isFinite(r.around) ? `${Math.round(r.around)} m` : `over ${JUNCTION_RATIO * JUNCTION_M} m`} round)`);
}
console.log(`[walk-network] ${vees} vee(s) where two paths merge cut across on the paving, `
  + `${Math.round(veeMetres)} m of connector the sheet does not draw (only where it saves ${VEE_SAVE_M} m or more)`);
for (const v of veeAt) console.log(`[walk-network]    at ${v.at.join(',')}: a ${v.chord.toFixed(1)} m chord saves ${v.save.toFixed(1)} m`);
console.log(`[walk-network] ${linkCount} hand-added link(s) from path-links.json, ${Math.round(linkMetres)} m of path the sheet does not draw, each written down by hand; `
  + `${linkLawn.toFixed(1)} m of them over what the sheet paints as lawn`);
for (const { at, lawn } of linkLawnAt) console.log(`[walk-network]    ${lawn.toFixed(1)} m over sheet lawn: the link from ${at.join(',')}`);
console.log(`[walk-network] ${folded} long edge(s) folded onto a short one leaving the same node within ${FOLD_ANGLE} deg and ending within ${FOLD_M} m of it`);
for (const [lon, lat] of freeEnds) {
  console.warn(`[walk-network]    WARNING: a link end at ${lon.toFixed(DECIMALS)},${lat.toFixed(DECIMALS)} joins nothing — within ${WELD_M} m of no node and ${TEE_M} m of no edge`);
}
const left = fragments.filter((c) => !keep.has(c[0]));
console.log(`[walk-network] no bridges invented; ${left.length} fragments left disconnected `
  + `(${left.reduce((n, c) => n + c.length, 0)} nodes), ${rescued} more joined to the rest across a plaza`);
if (stranded) console.warn(`[walk-network]    WARNING: ${stranded} destination or entrance node(s) left on a piece that does not ship`);
console.log(`[walk-network] ${spliced} destinations spliced in, ${atDoor} more resolved to the door of the footprint they are in`);
console.log(`[walk-network] ${entranceNodes} points where a building's walls come nearest the network, `
  + `${entranceSplices} of them spliced in as new nodes, the rest within a weld of one`);
console.log(`[walk-network]    and ${memberNodes} nearest a shard of a building drawn as several footprints, ${memberSplices} of them spliced in`);
console.log(`[walk-network] ${doorCount} doors on ${doorFeatures.length} footprints, `
  + `${doorFeatures.reduce((n, f) => n + f.properties.stubs.length, 0)} pieces taken off the graph under their roofs -> src/doors.json`);
console.log(`[walk-network] ${renumber.size} nodes, ${features.length} segments, ${Math.round(metres)} m -> src/paths.json`);
console.log(`[walk-network] ${pairs.length} pairs of ways onto ${plazas.length} plazas shorter across than round, `
  + `whose paths are ${linesAll.size} lines, ${Math.round(metresAll)} m`);
console.log(`[walk-network]    ${linesSpanned} lines, ${Math.round(metresSpanned)} m, keep every pair within ${slack.metres} m and ${Math.round(slack.share * 100)}%; `
  + `${shadowed} beside a drawn path dropped (${Math.round(shadowMetres)} m)`);
console.log(`[walk-network]    noded: ${plazaNoded} crossings cut, ${plazaTeed} ends teed onto a line within ${PLAZA_TEE_M} m, `
  + `${plazaSnapped} cuts made at a node within ${PLAZA_SNAP_M} m, `
  + `${danglers} left leading nowhere dropped; ${feetUsed} feet on ${edgesSplit} drawn edges made vertices`);
console.log(`[walk-network] ${plazaFeatures.length} plaza crossings, ${Math.round(plazaMetres)} m, ${plazaOnly} vertices only they touch, `
  + `over ${plazaRuns.filter((r) => r.lines).length} of ${plazas.length} plazas -> src/plaza-paths.json (routed, not drawn)`);
for (const r of plazaRuns) {
  console.log(`[walk-network]    plaza i=${r.P.i}: ${Math.round(Math.abs(ringArea(r.P.rings[0])))} m2, ${r.portals} ways on, `
    + `${r.nodes} nodes, ${r.pairs} pairs shorter across, ${r.lines} lines, ${Math.round(r.metres)} m`);
}

// CAMPUS_BOUNDS in src/main.js is this box. A network that grows past the old
// one leaves part of itself outside the initial view.
const all = features.flatMap((f) => f.geometry.coordinates);
const box = [
  Math.min(...all.map((c) => c[0])), Math.min(...all.map((c) => c[1])),
  Math.max(...all.map((c) => c[0])), Math.max(...all.map((c) => c[1])),
];
console.log(`[walk-network] CAMPUS_BOUNDS [[${box[0]}, ${box[1]}], [${box[2]}, ${box[3]}]]`);
