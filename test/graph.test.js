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
  // vertices with no edge between them. scripts/build-walk-network.mjs welds
  // every vertex once and reuses the id precisely to avoid this.
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
  // The server routes with findPath, which only accepts vertices, so an
  // incoming coordinate is first snapped to the NEAREST VERTEX. That makes
  // vertices and edges different things: a path can run straight past a
  // building while its nearest vertex is fifty metres up the way, and the
  // destination then quietly resolves to somewhere else entirely.
  //
  // build-walk-network.mjs splices a node into the network at each
  // destination's closest point for exactly this reason, so what has to hold
  // is that snapping to a vertex is never meaningfully worse than snapping to
  // the pavement itself. The slack is WELD_M: a foot landing within welding
  // distance of an existing node deliberately reuses it rather than splitting
  // an edge into a stub.
  //
  // This used to assert that a place with a single node sat exactly on it,
  // which held only while the graph WAS my campus's node table. The network is now
  // traced from the walkways the sheet draws and carries none of their ids;
  // the guarantee below is the one that survived, and it is the one routing
  // actually depends on.
  const WELD_M = 2.0;

  const vertices = [];
  const seen = new Set();
  for (const s of segments) {
    for (const c of s.geometry.coordinates) {
      const k = vertexKey(c);
      if (!seen.has(k)) { seen.add(k); vertices.push(c); }
    }
  }

  /** Metres from a point to a segment, flat-earth over a 1 km campus. */
  const toSegment = (p, a, b) => {
    const ax = metresBetween(a, [p[0], a[1]]) * (p[0] < a[0] ? -1 : 1);
    const ay = metresBetween(a, [a[0], p[1]]) * (p[1] < a[1] ? -1 : 1);
    const bx = metresBetween(a, [b[0], a[1]]) * (b[0] < a[0] ? -1 : 1);
    const by = metresBetween(a, [a[0], b[1]]) * (b[1] < a[1] ? -1 : 1);
    const L = bx * bx + by * by;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, (ax * bx + ay * by) / L));
    return Math.hypot(ax - t * bx, ay - t * by);
  };

  const positioned = load('places').features.filter((f) => f.geometry);
  assert.ok(positioned.length > 100, `only ${positioned.length} positioned places`);

  let checked = 0;
  for (const place of positioned) {
    const { name, nodeIds } = place.properties;
    // my campus's own binding, kept in places.json even though the graph no longer
    // uses it — it is what ties a search result back to their data.
    assert.ok(nodeIds?.length, `${name} has no nodeIds`);
    if (place.geometry.type !== 'Point') continue;

    const p = place.geometry.coordinates;
    const toVertex = Math.min(...vertices.map((v) => metresBetween(p, v)));
    const toEdge = Math.min(...segments.map((s) =>
      toSegment(p, s.geometry.coordinates[0], s.geometry.coordinates[1])));

    assert.ok(
      toVertex <= toEdge + WELD_M + 0.05,
      `${name} snaps to a vertex ${toVertex.toFixed(1)} m away `
      + `while the network runs ${toEdge.toFixed(1)} m from it`,
    );
    checked += 1;
  }
  assert.ok(checked > 100, `only ${checked} destinations were checked`);
});
