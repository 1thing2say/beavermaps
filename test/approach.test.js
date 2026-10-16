// src/approach-paths.json — the streets around the campus, and the join between
// them and my campus's own network.
//
// This file is never drawn, which is exactly why it needs tests: a fault in it
// is invisible on screen. The campus renders identically whether the approach
// network is connected, disconnected, doubled or empty, and the only symptom is
// a route that fails or takes a strange line — for a user who is standing off
// campus and cannot see why.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, CAMPUS, metresBetween, vertexKey } from './helpers.js';
import { ringOf, inCampus } from '../src/campus-clip.js';

const campus = load('paths').features;
const approach = load('approach-paths').features;
const ring = ringOf(load('campus-boundary'));

test('every approach segment is a two-point LineString with a source', () => {
  assert.ok(approach.length > 5000, `only ${approach.length} approach segments`);
  for (const f of approach) {
    assert.equal(f.geometry.type, 'LineString');
    assert.equal(f.geometry.coordinates.length, 2);
    assert.ok(
      ['osm', 'gate', 'lot'].includes(f.properties.source),
      `unknown source ${f.properties.source}`,
    );
  }
});

/**
 * The apron the generator declares: the campus bounding box grown by 800 m.
 *
 * Worth checking rather than assuming, because Overpass makes it easy to get
 * wrong in a way nothing else notices. Its bounding box selects WAYS and `out
 * geom` returns each one whole, so a way that clips the corner arrives complete
 * — Auburn Blvd came back running two kilometres past the box, and the only
 * symptom was a file a quarter larger than it should have been.
 */
const APRON_M = 800;
const bbox = ring.reduce((b, [lon, lat]) => [
  Math.min(b[0], lon), Math.min(b[1], lat), Math.max(b[2], lon), Math.max(b[3], lat),
], [Infinity, Infinity, -Infinity, -Infinity]);
// A little slack: the generator rounds the box to four decimals for the query.
const SLACK_M = 20;
const grow = APRON_M + SLACK_M;

test('the approach network stays in the apron around campus', () => {
  const apron = {
    west: bbox[0] - grow / metresBetween([0, 38.65], [1, 38.65]),
    south: bbox[1] - grow / metresBetween([0, 38.65], [0, 39.65]),
    east: bbox[2] + grow / metresBetween([0, 38.65], [1, 38.65]),
    north: bbox[3] + grow / metresBetween([0, 38.65], [0, 39.65]),
  };
  for (const f of approach) {
    for (const [lon, lat] of f.geometry.coordinates) {
      assert.ok(
        lon > apron.west && lon < apron.east && lat > apron.south && lat < apron.north,
        `approach vertex at ${lon},${lat} is outside the ${APRON_M} m apron`,
      );
      // The generous outer box too, so a projection fault still fails loudly.
      assert.ok(
        lon > CAMPUS.west - 0.02 && lon < CAMPUS.east + 0.02
        && lat > CAMPUS.south - 0.02 && lat < CAMPUS.north + 0.02,
        `approach vertex at ${lon},${lat} is nowhere near my campus`,
      );
    }
  }
});

/** Metres from a point to the campus boundary, ignoring which side it is on. */
function toRing(p) {
  let best = Infinity;
  for (let i = 1; i < ring.length; i += 1) {
    const [a, b] = [ring[i - 1], ring[i]];
    const L = metresBetween(a, b);
    if (L === 0) { best = Math.min(best, metresBetween(p, a)); continue; }
    // Parameterise in degrees, measure in metres — the campus is 1 km across,
    // so the two agree to far below what this test cares about.
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy)));
    best = Math.min(best, metresBetween(p, [a[0] + t * vx, a[1] + t * vy]));
  }
  return best;
}

/**
 * The whole point of the clip: inside the fence my campus's drawing is the better
 * data, and two networks down one corridor would let the router pick either.
 *
 * "Inside" needs a tolerance, and stating why is the useful part. Two things
 * legitimately put an OSM vertex a hair the campus side of the line, and
 * neither is a way crossing the fence:
 *
 *   - The clip itself. Every vertex it creates lies exactly ON the ring, and a
 *     ray-casting test against a point on its own boundary is a coin flip.
 *   - The weld. Where an OSM vertex lands within half a metre of one of my campus's,
 *     the generator emits my campus's coordinate so the two graphs share a node — and
 *     my campus's vertex can be a few centimetres inside a boundary that runs down
 *     the middle of the kerb.
 *
 * So: nothing more than half a metre inside, unless it is a campus vertex.
 */
test('no OSM way runs inside the campus', () => {
  const campusVertices = new Set();
  for (const f of campus) for (const c of f.geometry.coordinates) campusVertices.add(vertexKey(c));

  const ON_THE_LINE_M = 0.5;
  for (const f of approach) {
    if (f.properties.source !== 'osm') continue;
    for (const c of f.geometry.coordinates) {
      if (!inCampus(c, ring)) continue;
      if (campusVertices.has(vertexKey(c))) continue;
      assert.ok(
        toRing(c) <= ON_THE_LINE_M,
        `an OSM vertex at ${c} is ${toRing(c).toFixed(1)} m inside the campus `
        + 'and is not a weld onto my campus\'s network',
      );
    }
  }

  // ...and no segment lies inside, which is the claim the tolerance above could
  // otherwise hide: a whole way could sit just inside a boundary that happens to
  // run along it.
  const within = approach.filter((f) => {
    if (f.properties.source !== 'osm') return false;
    const [a, b] = f.geometry.coordinates;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return inCampus(mid, ring) && toRing(mid) > ON_THE_LINE_M;
  });
  assert.equal(within.length, 0, `${within.length} OSM segments run inside the campus`);
});

test('gates are short, few, and each has one end on the campus network', () => {
  const campusVertices = new Set();
  for (const f of campus) for (const c of f.geometry.coordinates) campusVertices.add(vertexKey(c));

  const gates = approach.filter((f) => f.properties.source === 'gate');
  // Ten or so real entrances. An order of magnitude more means the redundancy
  // guard in build-approach-network.mjs has stopped working and the two
  // networks are being sewn together down every shared kerb — which is how the
  // first version of that script behaved, at 80 connectors.
  assert.ok(gates.length > 0 && gates.length <= 30, `${gates.length} gate connectors`);

  for (const gate of gates) {
    const [a, b] = gate.geometry.coordinates;
    assert.ok(
      campusVertices.has(vertexKey(a)) || campusVertices.has(vertexKey(b)),
      `a gate at ${a} touches no campus vertex — it will weld to nothing`,
    );
    // GATE_M in the generator. A connector longer than this is not the last few
    // metres of an entrance, it is a path invented across whatever lies between.
    const metres = metresBetween(a, b);
    assert.ok(metres <= 12.5, `a gate connector is ${metres.toFixed(1)} m long`);
  }
});

/**
 * Two connectors at one entrance at most. Under TOUCH_M a connector used to
 * need no argument at all, and wherever the sheet and OSM drew one entrance a
 * metre apart every vertex took one: five side by side in 13 m of College Oak
 * Dr, at the mouth of driveway 1081. Two is a gate and the second end of a
 * street lying along a campus edge, or a gate and the junction beside its foot.
 */
test('no entrance is stitched to the street more than twice', () => {
  const gates = approach.filter((f) => f.properties.source === 'gate').map((f) => f.geometry.coordinates);
  for (const [a] of gates) {
    const near = gates.filter(([b]) => metresBetween(a, b) < 20);
    assert.ok(near.length <= 2, `${near.length} gate connectors within 20 m of ${a}`);
  }
});

/**
 * The lot connectors: a car-park entrance OSM draws and the campus clip cut,
 * joined straight across the car park to the campus path beyond. They are
 * not gates — 78 to 111 m, where a gate is the last 12 — so they carry their
 * own source and are held to their own limits: one end a street end on the
 * campus boundary, the other a campus vertex, and no further than LOT_M.
 */
test('a lot connector runs from a cut street end to a campus vertex, within 120 m', () => {
  const campusVertices = new Set();
  for (const f of campus) for (const c of f.geometry.coordinates) campusVertices.add(vertexKey(c));
  const lots = approach.filter((f) => f.properties.source === 'lot');
  assert.ok(lots.length >= 4, `only ${lots.length} lot connectors: the north car parks have three entrances`);
  for (const { geometry: { coordinates: [a, b] } } of lots) {
    const [mine, street] = campusVertices.has(vertexKey(a)) ? [a, b] : [b, a];
    assert.ok(campusVertices.has(vertexKey(mine)), `a lot connector at ${a} touches no campus vertex`);
    assert.ok(toRing(street) <= 0.5, `the lot connector to ${mine} ends ${toRing(street).toFixed(1)} m off the boundary`);
    assert.ok(metresBetween(a, b) <= 120, `a lot connector is ${metresBetween(a, b).toFixed(0)} m long`);
  }
});

/**
 * Every way the campus clip cut leads somewhere. An OSM way that runs on into
 * the campus is a way in that somebody mapped; cut at the boundary and left,
 * it is a dead end on the fence, and a walk that starts on it goes back the
 * way it came to the next gate — 894 m from the east footway's stub to the
 * Administration Building, and 513 m from the north car park's entrance to
 * Drop-off North, 114 m once joined. So each cut end has a lot connector,
 * or the streets and gates from it reach a campus vertex within 30 m, or it
 * is one that was looked at and left, for the reason given.
 */
const LEFT_AT_THE_FENCE = new Map([
  // Into the south car park from a kerbside pad on its south side: county
  // imagery (2022, 7.5 cm) shows a shrub bed under tree canopy between the pad
  // and the car park's perimeter walk, and no footway through it.
  ['-121.3481894,38.6451231', 'shrub bed'],
  // College Oak Dr's second entrance to the south-west car park: the nearest
  // campus vertex is 89 m down the boundary strip, off the sheet.
  ['-121.3503433,38.6455045', 'no campus path across the car park'],
]);
test('every street the campus clip cut reaches the campus within 30 m', () => {
  const campusVertices = new Set();
  for (const f of campus) for (const c of f.geometry.coordinates) campusVertices.add(vertexKey(c));
  const adj = new Map();
  const at = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  const street = new Map();
  for (const f of approach) {
    const [a, b] = f.geometry.coordinates;
    const [ka, kb] = [vertexKey(a), vertexKey(b)];
    at.set(ka, a);
    at.set(kb, b);
    link(ka, kb);
    link(kb, ka);
    if (f.properties.source === 'osm') for (const k of [ka, kb]) street.set(k, (street.get(k) ?? 0) + 1);
  }
  const lotEnds = new Set(approach.filter((f) => f.properties.source === 'lot')
    .flatMap((f) => f.geometry.coordinates.map(vertexKey)));
  let cut = 0;
  for (const [k, n] of street) {
    if (n !== 1 || campusVertices.has(k) || toRing(at.get(k)) > 0.5) continue;
    cut += 1;
    if (LEFT_AT_THE_FENCE.has(k) || lotEnds.has(k)) continue;
    const best = new Map([[k, 0]]);
    const queue = [k];
    let reached = false;
    while (queue.length && !reached) {
      queue.sort((x, y) => best.get(x) - best.get(y));
      const u = queue.shift();
      for (const v of adj.get(u) ?? []) {
        const d = best.get(u) + metresBetween(at.get(u), at.get(v));
        if (d > 30 || d >= (best.get(v) ?? Infinity)) continue;
        best.set(v, d);
        if (campusVertices.has(v)) reached = true;
        queue.push(v);
      }
    }
    assert.ok(reached, `the street the clip cut at ${k} reaches no campus path within 30 m`);
  }
  assert.ok(cut >= 15, `test premise: only ${cut} cut street ends`);
});

/**
 * The mirror of the test below: a gate's street end on a short branch a few
 * metres from the junction the walk arrives by. At the south-west corner the
 * foot lands on a side branch 5.8 m from the College Oak sidewalk's junction,
 * and walks from the north went down the branch to it and back — "U-turn".
 * The campus vertex is joined to the junction as well.
 */
test('the south-west corner gate is joined to the junction beside its foot', () => {
  const gates = new Set(approach.filter((f) => f.properties.source === 'gate')
    .map((f) => f.geometry.coordinates.map(vertexKey).sort().join('|')));
  const corner = vertexKey([-121.350332, 38.644706]);
  const junction = vertexKey([-121.3504561, 38.6447259]);
  assert.ok(gates.has([corner, junction].sort().join('|')),
    'the south-west corner is not joined to the College Oak sidewalk junction beside its gate');
});

test('a street end lying along a campus edge is joined to both ends of it', () => {
  // The gate stage joins a campus vertex to the street. Where the street's end
  // lies along a campus edge that vertex ends, the connector runs back along
  // the edge, and a walk from the edge's far end went past the street to the
  // vertex and came back: a spike, and "U-turn", at both the west gate and the
  // east one. The script joins such a street end to the far end as well —
  // within a gate's length of it. One College Oak Dr driveway is a single
  // 100 m edge, and a 100 m "gate" beside it is not one (see the test above);
  // there the walk turns at the near end, a step past the street.
  const flatten = ([x, y]) => [x * metresBetween([0, y], [1, y]), y * metresBetween([0, 0], [0, 1])];
  const campusEdges = [];
  for (const f of campus) {
    const cs = f.geometry.coordinates;
    for (let n = 1; n < cs.length; n += 1) campusEdges.push([cs[n - 1], cs[n]]);
  }
  const campusVertices = new Set(campusEdges.flat().map(vertexKey));
  const gates = approach.filter((f) => f.properties.source === 'gate').map((f) => f.geometry.coordinates);
  const joined = new Set(gates.map(([a, b]) => [vertexKey(a), vertexKey(b)].sort().join('|')));
  let along = 0;
  for (const [a, b] of gates) {
    const [mine, street] = campusVertices.has(vertexKey(a)) ? [a, b] : [b, a];
    if (campusVertices.has(vertexKey(street))) continue;
    for (const [u, v] of campusEdges) {
      if (vertexKey(u) !== vertexKey(mine) && vertexKey(v) !== vertexKey(mine)) continue;
      const other = vertexKey(u) === vertexKey(mine) ? v : u;
      const [p, q, s] = [mine, other, street].map((c) => flatten([c[0] - mine[0], c[1]]));
      const vx = q[0] - p[0], vy = q[1] - p[1], L = Math.hypot(vx, vy);
      const t = ((s[0] - p[0]) * vx + (s[1] - p[1]) * vy) / (L * L);
      const off = Math.abs((s[0] - p[0]) * vy - (s[1] - p[1]) * vx) / L;
      if (off > 2 || t * L < 0.5 || (1 - t) * L < 0.5) continue;
      along += 1;
      if (metresBetween(other, street) > 12.5) continue;
      assert.ok(joined.has([vertexKey(other), vertexKey(street)].sort().join('|')),
        `the street end ${street} lies ${(t * L).toFixed(1)} m along a campus edge from ${mine} `
        + `and is not joined to its other end ${other}`);
    }
  }
  assert.ok(along >= 2, `test premise: only ${along} street ends lie along a campus edge`);
});

/**
 * Union-find over the merged graph, keyed exactly as server/index.js keys it.
 *
 * The server concatenates the collections — the campus's own, its plaza
 * crossings, the streets — and hands them to one PathFinder, which builds its
 * topology from coordinates. So the merge is only real if the
 * gate connectors' campus ends are byte-identical to the campus vertices they
 * are meant to weld to — a difference in the seventh decimal is a connector
 * joined to nothing, a campus that cannot be reached from the street, and a
 * "no path found" with nothing on screen to explain it.
 */
test('the campus and the streets around it are one connected graph', () => {
  const parent = new Map();
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const add = (k) => { if (!parent.has(k)) parent.set(k, k); };

  for (const f of [...campus, ...load('plaza-paths').features, ...approach]) {
    const keys = f.geometry.coordinates.map(vertexKey);
    keys.forEach(add);
    for (let n = 1; n < keys.length; n += 1) {
      const [a, b] = [find(keys[n - 1]), find(keys[n])];
      if (a !== b) parent.set(a, b);
    }
  }

  const groups = new Map();
  for (const k of parent.keys()) groups.set(find(k), (groups.get(find(k)) ?? 0) + 1);
  const sizes = [...groups.values()].sort((a, b) => b - a);

  assert.equal(
    sizes.length, 1,
    `the merged graph is in ${sizes.length} pieces (${sizes.slice(0, 6).join(', ')}…) — `
    + 'a walk from outside the campus to a building on it cannot be found',
  );
});
