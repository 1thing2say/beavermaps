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

const at = (a, b, t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];

/**
 * Trim a collection to the campus.
 *
 * A LineString is CUT at the boundary and its inside parts kept. One feature can
 * come back as several, or as none. Properties are carried across unchanged: a
 * clip that quietly renames its output is a trap for whatever reads it next.
 *
 * Anything else is dropped only when it lies WHOLLY outside — clipping a
 * polygon to a fifty-vertex ring is a different and much larger problem, and
 * what it would buy is a metre of overhang on the elements that straddle the
 * line. Wholly, not mostly, for a second reason too: the crossings at my campus's
 * entrances are drawn straddling the boundary because that is where they are,
 * and a majority test would eat the campus edge rather than tidy it.
 */
export function trimToCampus(collection, ring) {
  const features = [];
  for (const feature of collection.features) {
    if (feature.geometry?.type !== 'LineString') {
      if (feature.geometry && !whollyOutside(feature.geometry, ring)) features.push(feature);
      continue;
    }
    const pts = feature.geometry.coordinates;
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        features.push({ ...feature, geometry: { type: 'LineString', coordinates: run } });
      }
      run = [];
    };

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
        const p0 = at(a, b, t0);
        const p1 = at(a, b, t1);
        if (!inCampus(at(a, b, t0 + (t1 - t0) / 2), ring)) { flush(); continue; }
        // Chain onto the run in progress when this part starts where the last
        // one ended, so a path crossing many vertices stays one line and keeps
        // its round joins instead of becoming a string of separate strokes.
        if (!run.length) run.push(p0);
        else if (run[run.length - 1][0] !== p0[0] || run[run.length - 1][1] !== p0[1]) {
          flush();
          run.push(p0);
        }
        run.push(p1);
      }
    }
    flush();
  }
  return { ...collection, features };
}
