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
      f.properties.source === 'osm' || f.properties.source === 'gate',
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
 * Union-find over the merged graph, keyed exactly as server/index.js keys it.
 *
 * The server concatenates the two collections and hands them to one PathFinder,
 * which builds its topology from coordinates. So the merge is only real if the
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

  for (const f of [...campus, ...approach]) {
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
