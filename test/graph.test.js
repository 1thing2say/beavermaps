// src/paths.json — the walkable network, and the only artifact routing depends
// on. Everything else on the map is decoration; if this is wrong, the app is
// wrong in the one way a user notices.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, CAMPUS, metresBetween, vertexKey } from './helpers.js';

const network = load('paths');
const segments = network.features;

test('every segment is a LineString with at least two positions', () => {
  assert.ok(segments.length > 500, `only ${segments.length} segments`);
  for (const s of segments) {
    assert.equal(s.geometry.type, 'LineString');
    assert.ok(s.geometry.coordinates.length >= 2, 'segment with fewer than two positions');
    assert.equal(typeof s.properties.from, 'number');
    assert.equal(typeof s.properties.to, 'number');
  }
});

test('every node is on campus', () => {
  for (const s of segments) {
    for (const [lon, lat] of s.geometry.coordinates) {
      assert.ok(
        lon > CAMPUS.west && lon < CAMPUS.east && lat > CAMPUS.south && lat < CAMPUS.north,
        `node at ${lon},${lat} is off campus`,
      );
    }
  }
});

// A zero-length segment is a self-loop with no cost. geojson-path-finder will
// happily keep it, and it makes the turn-by-turn emit a maneuver at a point the
// walker never moves through.
test('no segment has zero length', () => {
  for (const s of segments) {
    const coords = s.geometry.coordinates;
    const length = coords.slice(1).reduce((sum, c, n) => sum + metresBetween(coords[n], c), 0);
    assert.ok(length > 0.01, `segment ${s.properties.from}->${s.properties.to} has no length`);
  }
});

/**
 * Union-find over the vertex set, keyed exactly as server/index.js keys it.
 *
 * This is the test worth having. A fragmented graph does not throw and does not
 * look wrong on the map — the network draws identically. It fails only when a
 * user asks for a route between two components, and then it fails as a bare
 * "no path found" with nothing to point at.
 */
function components() {
  const parent = new Map();
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const add = (k) => { if (!parent.has(k)) parent.set(k, k); };

  for (const s of segments) {
    const keys = s.geometry.coordinates.map(vertexKey);
    keys.forEach(add);
    for (let n = 1; n < keys.length; n++) {
      const [a, b] = [find(keys[n - 1]), find(keys[n])];
      if (a !== b) parent.set(a, b);
    }
  }

  const groups = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    groups.set(r, (groups.get(r) ?? 0) + 1);
  }
  return { total: parent.size, sizes: [...groups.values()].sort((a, b) => b - a) };
}

test('the walkable network is one connected component', () => {
  const { total, sizes } = components();
  assert.ok(total > 500, `only ${total} vertices`);
  assert.equal(
    sizes.length, 1,
    `network is in ${sizes.length} pieces (${sizes.join(', ')} vertices) — `
    + 'routes between them cannot be found',
  );
});

test('shared endpoints are byte-identical, not merely close', () => {
  // The server snaps at 1e-7 and builds its vertex set by string key, so two
  // nodes that are the same place but differ in the last decimal become two
  // vertices with no edge between them. scripts/build-paths.mjs projects each
  // node once and reuses it precisely to avoid this.
  const keys = new Map();
  for (const s of segments) {
    for (const c of s.geometry.coordinates) keys.set(vertexKey(c), c);
  }
  const all = [...keys.values()];
  let suspicious = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (metresBetween(all[i], all[j]) < 0.05) suspicious += 1;
    }
  }
  assert.equal(suspicious, 0, `${suspicious} vertex pairs are within 5 cm but not merged`);
});

test('search destinations resolve onto the network', () => {
  // src/places.json binds every destination to routing nodes, so picking one
  // from the search box lands on the graph rather than near it. A place with one
  // node sits exactly on that node — no snapping at all. A place with several
  // sits at their mean, which is a building centre and deliberately not a node;
  // there the server's nearestPoint picks the door. What must hold either way is
  // that the position is close to a node it actually claims, because a place
  // that drifts still routes, just to the wrong building.
  const vertices = new Set();
  for (const s of segments) for (const c of s.geometry.coordinates) vertices.add(vertexKey(c));

  const positioned = load('places').features.filter((f) => f.geometry);
  assert.ok(positioned.length > 100, `only ${positioned.length} positioned places`);

  let exact = 0;
  for (const place of positioned) {
    const { name, nodeIds, spread_m: spread } = place.properties;
    assert.ok(nodeIds?.length, `${name} has no nodeIds`);
    if (place.geometry.type !== 'Point') continue;

    if (nodeIds.length === 1) {
      assert.ok(vertices.has(vertexKey(place.geometry.coordinates)),
        `${name} has one node but does not sit on it`);
      exact += 1;
      continue;
    }
    // Its mean cannot be further from the network than its own nodes are spread.
    const nearest = Math.min(...[...vertices].map((k) =>
      metresBetween(place.geometry.coordinates, k.split(',').map(Number))));
    assert.ok(nearest <= Math.max(spread ?? 0, 25) / 2 + 1,
      `${name} is ${nearest.toFixed(0)} m from the network, spread ${spread} m`);
  }
  assert.ok(exact > 50, `only ${exact} places land exactly on a node`);
});
