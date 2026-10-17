/**
 * Keep our map inside the campus, so the ground outside stays entirely theirs.
 *
 * `addCampusMask` in main.js states the rule — "inside the boundary the map is
 * ours and outside it is theirs" — and enforces half of it, taking the basemap's
 * own data out of the campus. This is the other half, which was missing: parts
 * of my campus's sheet, and a few metres of our own path network, were being drawn
 * OUTSIDE the boundary, on top of a ground that already draws them.
 *
 * That is what the seam at the campus edge was made of:
 *
 *   - 23 `offsite_road` elements. my campus's cartographer drew Auburn Blvd, Myrtle
 *     Ave and College Oak Dr so their sheet would not end in mid-air. Every
 *     provider draws those roads already, from better geometry, so ours landed
 *     as a second road a few metres off the first.
 *   - Both `north_arrow` elements — a print convention with nothing to point at
 *     on a rotatable map, sitting in the middle of a residential street.
 *   - 59 tree canopies, 21 crossings and 2 driveway stubs beyond the fence.
 *   - 17 segments of the white path ribbon, running out of the campus and along
 *     a public road that the basemap was drawing underneath at the same time.
 *
 * TWO MECHANISMS, because the shapes differ. A tree or a road element is
 * dropped whole when every point of it is outside — clipping a polygon to a
 * 50-vertex ring is a different and much larger problem, and the thing it would
 * buy is a metre of overhang on the elements that straddle the line. The path
 * network is a line network, where cutting IS easy and dropping is wrong: a
 * driveway that runs out to the street has to stop at the boundary, not vanish
 * from the last junction inside it.
 *
 * But only a line that runs OUT is cut. The boundary is OpenStreetMap's, not
 * my campus's, and in two places the sheet's own perimeter walkway strays a
 * few metres across it and comes back. Cutting those exactly at the ring is
 * what left a 123 m hole in the south-east corner and the east walkway in four
 * pieces; see EXCURSION_M. Crossings are the third case — a painted mark is
 * kept or dropped whole rather than sliced — and the lamps follow whatever
 * network survives, see trimPointsAlong.
 *
 * Applied on the way in rather than in the build scripts, for the same reason
 * the POI discs are: both files stay a complete record of what my campus drew and
 * where a walker can go, and which side of a line we choose to render is a
 * decision about presentation.
 */

/**
 * Metres per degree at my campus's latitude.
 *
 * The campus is 900 m across, so a flat conversion at one latitude is exact to
 * well under the width of the thinnest thing on the sheet, and every distance
 * this app measures for presentation — how far apart two car parks are, how
 * wide a painted bay divider is — goes through these. Kept here, and imported,
 * so the two modules that need them cannot drift apart on the value.
 */
export const M_PER_LON = 86_940;
export const M_PER_LAT = 110_980;

/** The campus ring, from the Feature build-boundary.mjs writes. */
export function ringOf(boundary) {
  const geometry = boundary.geometry ?? boundary.features?.[0]?.geometry;
  if (geometry?.type === 'Polygon') return geometry.coordinates[0];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates[0][0];
  throw new Error('campus boundary is not a polygon');
}

/** Ray casting. The ring is closed, so the last edge is covered by the wrap. */
export function inCampus([lon, lat], ring) {
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

/**
 * The middle of the campus: the area centroid of the ring.
 *
 * Not the middle of its bounding box, which is the middle of a rectangle nobody
 * drew — my campus's boundary is an L with a long arm down the west side, and the two
 * answers are 60 m apart. The centroid is the one a person would point at.
 *
 * Shoelace, over a closed ring, so the sign of the area cancels and the winding
 * does not matter. It lands 7 m off the nearest walked path and inside no
 * building, which is what makes it usable as a stand-in for a GPS fix.
 */
export function centreOf(ring) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 1; i < ring.length; i += 1) {
    const [x0, y0] = ring[i - 1];
    const [x1, y1] = ring[i];
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    x += (x0 + x1) * cross;
    y += (y0 + y1) * cross;
  }
  // A degenerate ring has no centroid to compute; fall back to its first point
  // rather than handing back a NaN that would silently become a blank map.
  if (!twiceArea) return ring[0].slice(0, 2);
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

function everyCoord(geometry, test) {
  const walk = (c) => (typeof c[0] === 'number' ? test(c) : c.every(walk));
  return walk(geometry.coordinates);
}

const whollyOutside = (geometry, ring) => everyCoord(geometry, (c) => !inCampus(c, ring));

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

/** Flat metres from a point to the ring — exact enough at 900 m across. */
function metresToRing([lon, lat], ring) {
  let best = Infinity;
  for (let k = 1; k < ring.length; k += 1) {
    const [ax, ay] = ring[k - 1];
    const vx = (ring[k][0] - ax) * M_PER_LON;
    const vy = (ring[k][1] - ay) * M_PER_LAT;
    const px = (lon - ax) * M_PER_LON;
    const py = (lat - ay) * M_PER_LAT;
    const L = vx * vx + vy * vy;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / L));
    best = Math.min(best, Math.hypot(px - t * vx, py - t * vy));
  }
  return best;
}

/** Flat metres between two points. */
const metres = (a, b) => Math.hypot((b[0] - a[0]) * M_PER_LON, (b[1] - a[1]) * M_PER_LAT);

/**
 * How far past the fence a line may wander and still be drawn, if it comes back.
 *
 * The OSM way this ring is (see scripts/build-boundary.mjs) is somebody's
 * tracing of the property line, and it does not follow my campus's own
 * perimeter paths. At the south-east corner it cuts diagonally across the
 * softball fields, so the sheet's 6.6 m perimeter walkway goes up to 14.8 m
 * past it over open lawn; along the east edge it runs down the centreline of
 * the 3.3 m walkway, which therefore weaves in and out of it a few
 * decimetres at a time. Neither is a path "running out of the campus": the
 * nearest public footway to the south-east excursion is 78 m away, and both
 * stretches start and end inside. Cut exactly at the ring, they came out as a
 * 123 m hole between two dead-end stubs and an east walkway in four pieces,
 * with the lamps along them glowing over lawn where no path was drawn — and
 * the routes still ran through the holes, because the server routes over the
 * whole network.
 *
 * Deep enough to cover the deepest of those with room for a rebuild that moves
 * a vertex, and not so deep that it changes what the clip is for: a line that
 * leaves and does NOT come back — a driveway out to College Oak Dr, a crossing
 * over Myrtle Ave — is still cut at the ring however shallow it is, because
 * the far side of it is the provider's street.
 *
 * And "comes back" means comes back somewhere else. At the College Oak Dr gate
 * a walkway and the plaza link both cross the fence and meet 3 m outside it,
 * where the drawn line carries on out to the street. Prune the part to the
 * street and the two arms left are a V that touches the ring twice, 0.4 m
 * apart — out and back by count, and kept, so the ribbon ran 3 m onto the
 * provider's sidewalk with a lamp glowing at its tip. Every real excursion
 * here runs along the fence further than it strays from it (the south-east
 * one 116 m along against 15 m out; the east-edge weaves 17 to 23 m along
 * against decimetres out), and a V, a loop or a turnaround out at the street
 * does the opposite. So a piece is kept only when its two furthest-apart ring
 * touches are further apart than its deepest point is from the ring.
 */
export const EXCURSION_M = 20;

/** Sample spacing along a part when measuring its depth past the ring. */
const DEPTH_STEP_M = 2;

/** At t = 0 and t = 1 the vertex itself, so a key built from it matches the next segment's. */
const at = (a, b, t) => {
  if (t === 0) return a;
  if (t === 1) return b;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
};

const keyOf = (p) => `${p[0]},${p[1]}`;

/**
 * One LineString, cut wherever it crosses the ring, as parts in order.
 * `cutA`/`cutB` say whether that end is on the ring (a cut) or is one of the
 * feature's own vertices.
 */
function partsOf(pts, ring) {
  const parts = [];
  for (let i = 1; i < pts.length; i += 1) {
    const [a, b] = [pts[i - 1], pts[i]];
    const ts = [0, 1];
    for (let k = 1; k < ring.length; k += 1) {
      const t = crossParam(a, b, ring[k - 1], ring[k]);
      if (t !== null) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let k = 1; k < ts.length; k += 1) {
      const [t0, t1] = [ts[k - 1], ts[k]];
      if (t1 - t0 < 1e-12) continue;
      parts.push({
        a: at(a, b, t0),
        b: at(a, b, t1),
        cutA: t0 > 0,
        cutB: t1 < 1,
        inside: inCampus(at(a, b, t0 + (t1 - t0) / 2), ring),
      });
    }
  }
  return parts;
}

/**
 * The outside parts that belong to a line which leaves the campus and comes
 * back, no further out than EXCURSION_M.
 *
 * Worked on the whole collection at once rather than feature by feature,
 * because the network is stored one edge per feature: the south-east
 * excursion is three edges, the middle one with both ends outside, and none of
 * them can tell on its own that the other two bring it home. Lines are joined
 * where they share a vertex exactly, which is how paths.json joins its edges
 * and how one sheet stroke's consecutive segments join.
 *
 * Two steps. First, dead-end tails are pruned: a part that ends at a vertex
 * outside the campus that nothing else reaches is a line running out to the
 * street, and so is whatever led only to it. That is what still gets cut. Then
 * what is left is grouped into connected pieces, and a piece is kept when it
 * touches the ring at two or more points — out and back — nowhere goes deeper
 * than EXCURSION_M, and runs further along the ring than it goes out from it
 * (see EXCURSION_M for the gate that last rule is for). A loop sitting wholly
 * outside, or a piece that only touches the ring once, is not a way back in
 * and is dropped as before.
 */
function returningParts(outside, ring) {
  const degree = new Map();
  const ends = (part) => [[part.a, part.cutA], [part.b, part.cutB]];
  for (const part of outside) {
    for (const [p, cut] of ends(part)) {
      if (!cut) degree.set(keyOf(p), (degree.get(keyOf(p)) ?? 0) + 1);
    }
  }

  const alive = new Set(outside);
  for (let pruned = true; pruned;) {
    pruned = false;
    for (const part of alive) {
      if (!ends(part).some(([p, cut]) => !cut && degree.get(keyOf(p)) === 1)) continue;
      alive.delete(part);
      for (const [p, cut] of ends(part)) {
        if (!cut) degree.set(keyOf(p), degree.get(keyOf(p)) - 1);
      }
      pruned = true;
    }
  }

  // Connected pieces of what survived, joined at shared vertices.
  const parts = [...alive];
  const parent = parts.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstAt = new Map();
  parts.forEach((part, i) => {
    for (const [p, cut] of ends(part)) {
      if (cut) continue;
      const k = keyOf(p);
      if (firstAt.has(k)) parent[find(i)] = find(firstAt.get(k));
      else firstAt.set(k, i);
    }
  });
  const pieces = new Map();
  parts.forEach((part, i) => {
    const root = find(i);
    if (!pieces.has(root)) pieces.set(root, []);
    pieces.get(root).push(part);
  });

  const kept = new Set();
  for (const piece of pieces.values()) {
    const touches = piece.flatMap((part) => [part.cutA && part.a, part.cutB && part.b].filter(Boolean));
    if (touches.length < 2) continue;
    let depth = 0;
    for (const part of piece) {
      const steps = Math.max(1, Math.ceil(metres(part.a, part.b) / DEPTH_STEP_M));
      for (let s = 0; s <= steps; s += 1) {
        depth = Math.max(depth, metresToRing(at(part.a, part.b, s / steps), ring));
      }
    }
    if (depth > EXCURSION_M) continue;
    let along = 0;
    for (const p of touches) for (const q of touches) along = Math.max(along, metres(p, q));
    if (along <= depth) continue;
    for (const part of piece) kept.add(part);
  }
  return kept;
}

/** Whether the point halfway along a line, by length, is on the campus. */
function middleInCampus(pts, ring) {
  const lengths = pts.slice(1).map((p, i) => metres(pts[i], p));
  let half = lengths.reduce((s, l) => s + l, 0) / 2;
  for (let i = 0; i < lengths.length; i += 1) {
    if (half <= lengths[i]) return inCampus(at(pts[i], pts[i + 1], lengths[i] ? half / lengths[i] : 0), ring);
    half -= lengths[i];
  }
  return inCampus(pts[0], ring);
}

/**
 * Trim a collection to the campus.
 *
 * A LineString is CUT at the boundary and its inside parts kept — along with
 * any stretch outside that comes back in, within EXCURSION_M (see there). One
 * feature can come back as several, or as none. Properties are carried across
 * unchanged: a clip that quietly renames its output is a trap for whatever
 * reads it next.
 *
 * Except a `crossing`, which is kept or dropped WHOLE, by which side of the
 * ring its middle is on. A crossing is a painted mark across one road, not a
 * line that goes somewhere, and cut at the ring the ones at the gates came out
 * as slivers of 0.3 to 8 m ending at an invisible line beside the provider's
 * street — half a crosswalk is not a smaller crosswalk. The ones mostly over
 * College Oak Dr and Myrtle Ave now go entirely; the ones mostly on campus stay
 * entirely, overhanging by less than half their length.
 *
 * Anything else is dropped only when it lies WHOLLY outside — clipping a
 * polygon to a fifty-vertex ring is a different and much larger problem, and
 * what it would buy is a metre of overhang on the elements that straddle the
 * line. Wholly, not mostly, for a second reason too: the crossings at my campus's
 * entrances are drawn straddling the boundary because that is where they are,
 * and a majority test would eat the campus edge rather than tidy it.
 */
export function trimToCampus(collection, ring) {
  const lines = [];
  const outside = [];
  for (const feature of collection.features) {
    if (feature.geometry?.type !== 'LineString') continue;
    if (feature.properties?.kind === 'crossing') continue;
    const parts = partsOf(feature.geometry.coordinates, ring);
    lines.push([feature, parts]);
    for (const part of parts) if (!part.inside) outside.push(part);
  }
  const returning = returningParts(outside, ring);
  const partsFor = new Map(lines);

  const features = [];
  for (const feature of collection.features) {
    if (!feature.geometry) continue;
    if (feature.geometry.type !== 'LineString') {
      if (!whollyOutside(feature.geometry, ring)) features.push(feature);
      continue;
    }
    if (feature.properties?.kind === 'crossing') {
      if (middleInCampus(feature.geometry.coordinates, ring)) features.push(feature);
      continue;
    }

    let run = [];
    const flush = () => {
      if (run.length > 1) {
        features.push({ ...feature, geometry: { type: 'LineString', coordinates: run } });
      }
      run = [];
    };
    for (const part of partsFor.get(feature)) {
      if (!part.inside && !returning.has(part)) { flush(); continue; }
      // Chain onto the run in progress when this part starts where the last
      // one ended, so a path crossing many vertices stays one line and keeps
      // its round joins instead of becoming a string of separate strokes.
      if (!run.length) run.push(part.a);
      else if (keyOf(run[run.length - 1]) !== keyOf(part.a)) {
        flush();
        run.push(part.a);
      } else if (part.cutA) {
        // Both sides of a crossing kept: the cut point is in the middle of one
        // straight segment, so it adds nothing to the shape. Taken back out so
        // a line that came back whole is the line that went in.
        run.pop();
      }
      run.push(part.b);
    }
    flush();
  }
  return { ...collection, features };
}

/**
 * Points, kept where the drawn lines are: anything on the campus, and anything
 * outside it that lies within `toleranceM` of a line `trimToCampus` kept.
 *
 * For the lamps. scripts/build-lamps.mjs places them along the whole network
 * and knows nothing of the fence, so they have to be trimmed by the same rule
 * as the network they light, or they disagree with it in both directions: a
 * lamp on a stub that was cut away glows over the provider's street with no
 * path under it, and a lamp on an excursion that was kept must not be dropped
 * from under its path. Measured against the trimmed network rather than
 * re-deciding from the ring, so the two cannot drift apart. The lamps sit on
 * the network to 7 cm; a metre is tolerance, not reach.
 */
export function trimPointsAlong(collection, drawn, ring, toleranceM = 1) {
  const segments = [];
  for (const f of drawn?.features ?? []) {
    if (f.geometry?.type !== 'LineString') continue;
    const cs = f.geometry.coordinates;
    for (let i = 1; i < cs.length; i += 1) segments.push([cs[i - 1], cs[i]]);
  }
  const near = ([lon, lat]) => segments.some(([a, b]) => {
    const vx = (b[0] - a[0]) * M_PER_LON;
    const vy = (b[1] - a[1]) * M_PER_LAT;
    const px = (lon - a[0]) * M_PER_LON;
    const py = (lat - a[1]) * M_PER_LAT;
    const L = vx * vx + vy * vy;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / L));
    return Math.hypot(px - t * vx, py - t * vy) <= toleranceM;
  });
  const features = collection.features.filter((f) => {
    if (f.geometry?.type !== 'Point') return false;
    const c = f.geometry.coordinates;
    return inCampus(c, ring) || near(c);
  });
  return { ...collection, features };
}
