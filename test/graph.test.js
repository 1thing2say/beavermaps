// src/paths.json — the walkable network, and the artifact routing depends on,
// with src/doors.json beside it saying where a room inside a building joins it.
// Everything else on the map is decoration; if this is wrong, the app is wrong
// in the one way a user notices.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, CAMPUS, metresBetween, vertexKey, pointInRing } from './helpers.js';
import { createGraph } from '../server/graph.js';

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
 * Union-find over the vertex set, keyed exactly as server/index.js keys it,
 * over the drawn segments and the plaza crossings together, as the server
 * unions them: three strokes on the sheet — the aprons from the Career
 * Technical Education building's doors and the Child Development Center's
 * north door — stop on a paved plaza and touch no other stroke, and the
 * plaza is what joins them to the rest.
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

  for (const s of [...segments, ...load('plaza-paths').features]) {
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

test('no edge doubles a shorter one leaving the same node the same way', () => {
  // The fold stage in build-walk-network.mjs. A long edge and a short one from
  // one node, within 20 degrees, with the short one's end on the long one,
  // are one corridor drawn twice; a point snapped onto the long one walked
  // past the short one's end and came back down it. The plaza link between
  // Fine & Applied Arts and the Kaneko Gallery was the case.
  const toward = new Map();
  for (const f of segments) {
    const cs = f.geometry.coordinates;
    for (let n = 1; n < cs.length; n += 1) {
      for (const [p, q] of [[cs[n - 1], cs[n]], [cs[n], cs[n - 1]]]) {
        if (!toward.has(vertexKey(p))) toward.set(vertexKey(p), []);
        toward.get(vertexKey(p)).push([p, q]);
      }
    }
  }
  const lonM = metresBetween([0, 38.65], [1, 38.65]), latM = metresBetween([0, 0], [0, 1]);
  for (const out of toward.values()) {
    for (const [p, near] of out) {
      for (const [, far] of out) {
        const a = [(near[0] - p[0]) * lonM, (near[1] - p[1]) * latM];
        const b = [(far[0] - p[0]) * lonM, (far[1] - p[1]) * latM];
        const la = Math.hypot(...a), lb = Math.hypot(...b);
        if (la >= lb || la === 0) continue;
        const along = (a[0] * b[0] + a[1] * b[1]) / lb;
        const off = Math.abs(a[0] * b[1] - a[1] * b[0]) / lb;
        const degrees = (Math.acos(Math.min(1, along / la)) * 180) / Math.PI;
        assert.ok(!(degrees <= 20 && off <= 1 && along < lb),
          `the ${lb.toFixed(1)} m edge from ${p} runs over the ${la.toFixed(1)} m one to ${near}`);
      }
    }
  }
});

test('no edge runs down a lane arrow the sheet files as a crossing', () => {
  // build-walk-network.mjs takes pavement grey only. The 24 darker 0.82 m
  // strokes the sheet files as `crossing` are the shafts of the lane arrows at
  // the entrances, not crosswalks; read as path, 78 m of network ran down the
  // carriageway on them and a gate went 8 m out into College Oak Dr. An edge
  // may still lie along one where the arrow is painted on a driveway's own
  // centreline, so only an edge on no pavement-grey stroke fails.
  const lonM = metresBetween([0, 38.65], [1, 38.65]), latM = metresBetween([0, 0], [0, 1]);
  const flat = ([x, y]) => [x * lonM, y * latM];
  const segDist = (q, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy;
    const t = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / L)) : 0;
    return Math.hypot(q[0] - a[0] - t * vx, q[1] - a[1] - t * vy);
  };
  const near = (q, lines, m) => lines.some((l) => l.some((b, k) => k > 0 && segDist(q, l[k - 1], b) <= m));
  const basemap = load('basemap').features;
  const lines = (keep) => basemap.filter((f) => f.geometry.type === 'LineString' && keep(f.properties))
    .map((f) => f.geometry.coordinates.map(flat));
  const arrows = lines((p) => p.kind === 'crossing' && p.stroke !== '#e2e3e4');
  const pavement = lines((p) => ['walkway', 'driveway', 'crossing'].includes(p.kind) && p.stroke === '#e2e3e4');
  assert.equal(arrows.length, 24, 'the sheet\'s lane arrows have changed; re-read them');
  for (const f of segments) {
    const [a, b] = f.geometry.coordinates.map(flat);
    const samples = Array.from({ length: 11 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / 10, a[1] + ((b[1] - a[1]) * k) / 10]);
    const onArrow = samples.filter((q) => near(q, arrows, 0.5)).length;
    if (onArrow < 6) continue;
    assert.ok(samples.every((q) => near(q, pavement, 0.5)),
      `${f.geometry.coordinates.join(' -> ')} runs down a lane arrow, on no pavement stroke`);
  }
});

test('no edge cuts across the tree planter at the west entrance', () => {
  // Sheet i=1873, beside the walkway diagonal 1321 north of driveway 1087. The
  // second collapse pass once dragged the node where driveway 1086 tees onto
  // 1321 five metres sideways onto walkway 1263, and the edge of 1321 into it
  // ran across this planter and the lawn round it; the collapse now refuses a
  // move that takes an edge off the paving.
  const planter = load('basemap').features.find((f) => f.properties.i === 1873);
  assert.equal(planter?.properties.kind, 'tree');
  const ring = planter.geometry.coordinates[0];
  for (const f of segments) {
    const [a, b] = f.geometry.coordinates;
    for (let k = 0; k <= 40; k += 1) {
      const q = [a[0] + ((b[0] - a[0]) * k) / 40, a[1] + ((b[1] - a[1]) * k) / 40];
      assert.ok(!pointInRing(q, ring), `${f.geometry.coordinates.join(' -> ')} crosses the planter`);
    }
  }
});

test('every hand-added link joins the network at both ends', () => {
  // A link in src/path-links.json is written against the map as drawn, and the
  // build's tee and junction stages move dead ends by up to 3 m afterwards. One
  // link was left behind that way: its walkway end had been teed away from it,
  // it attached at the other end only, and the build carried on with a loose
  // end that doubled an LRC-to-STEM walk. Nothing else notices — the network
  // stays one component, because the link still hangs off it by one end.
  //
  // So each end must sit on a vertex that something besides the link itself
  // reaches: degree two or more. Measured from the link as written, so the
  // vertex may be up to a tee plus a weld away (3 + 2 m).
  const degree = new Map();
  for (const s of segments) {
    const cs = s.geometry.coordinates;
    for (const c of [cs[0], cs.at(-1)]) degree.set(vertexKey(c), (degree.get(vertexKey(c)) ?? 0) + 1);
  }
  const vertices = [...new Set(segments.flatMap((s) => s.geometry.coordinates).map(vertexKey))]
    .map((k) => ({ k, c: k.split(',').map(Number) }));
  const links = load('path-links').features.filter((f) => f.geometry?.type === 'LineString');
  assert.ok(links.length > 0, 'no hand links to check');
  for (const link of links) {
    for (const end of [link.geometry.coordinates[0], link.geometry.coordinates.at(-1)]) {
      let best = null;
      for (const v of vertices) {
        const d = metresBetween(end, v.c);
        if (!best || d < best.d) best = { ...v, d };
      }
      assert.ok(best.d <= 5, `link end ${end} is ${best.d.toFixed(1)} m from the network`);
      assert.ok(
        degree.get(best.k) >= 2,
        `link end ${end} attaches to nothing: its vertex ${best.k} is a dead end — `
        + '"' + (link.properties?.why ?? '').slice(0, 60) + '…"',
      );
    }
  }
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
  // Except a destination inside a building that is closer to an approach path
  // the walls stage peeled off under that roof than to anything left. The
  // build does not splice those: they resolve to the door the path left, and
  // the router (server/graph.js) does the same. For them, what has to hold is
  // that the router's snap IS one of that building's doors.
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

  const doors = load('doors');
  const router = createGraph({ network, approach: load('approach-paths'), doors });
  const doorsAround = (p) => doors.features
    .filter((f) => pointInRing(p, f.geometry.coordinates[0]))
    .flatMap((f) => f.properties.stubs.flatMap((stub) => stub.doors.map(vertexKey)));

  let checked = 0, atDoor = 0;
  for (const place of positioned) {
    const { name, nodeIds } = place.properties;
    // my campus's own binding, kept in places.json even though the graph no longer
    // uses it — it is what ties a search result back to their data.
    assert.ok(nodeIds?.length, `${name} has no nodeIds`);
    if (place.geometry.type !== 'Point') continue;

    const p = place.geometry.coordinates;
    const snapped = vertexKey(router.snap(p).coord);
    if (doorsAround(p).includes(snapped)) {
      assert.ok(vertices.some((v) => vertexKey(v) === snapped), `${name}'s door is not a vertex`);
      atDoor += 1;
      checked += 1;
      continue;
    }
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
  // Today 23: the 21 the build left unspliced for a door, and two whose nearest
  // vertex happens to be one.
  assert.ok(atDoor >= 15, `only ${atDoor} destinations resolve to a door`);
});

test('every door in doors.json is on its building\'s wall and on the network', () => {
  // src/doors.json is written by the walls stage of build-walk-network.mjs:
  // for each footprint, the pieces of drawn path it took off the graph under
  // that roof, and the node each piece left the graph at. The router sends a
  // room to one of those nodes, so a door that is not a vertex is a room the
  // router cannot reach, and a door away from the wall is not a door.
  const doors = load('doors').features;
  assert.ok(doors.length >= 10, `only ${doors.length} footprints have a door`);
  const vertices = new Set(segments.flatMap((s) => s.geometry.coordinates.map(vertexKey)));
  for (const f of doors) {
    const [ring] = f.geometry.coordinates;
    assert.ok(f.properties.stubs.length > 0, `footprint ${f.properties.i} lists no stubs`);
    for (const { doors: at, under } of f.properties.stubs) {
      assert.ok(at.length > 0 && under.length > 0, `footprint ${f.properties.i} has an empty stub`);
      for (const door of at) {
        assert.ok(vertices.has(vertexKey(door)), `door ${door} of footprint ${f.properties.i} is not a vertex`);
        // On the wall, give or take what the later stages moved it: 0.22 m today.
        const mx = metresBetween(door, [door[0] + 1e-4, door[1]]) / 1e-4;
        const my = metresBetween(door, [door[0], door[1] + 1e-4]) / 1e-4;
        let toWall = Infinity;
        for (let k = 1; k < ring.length; k += 1) {
          const ax = (ring[k - 1][0] - door[0]) * mx, ay = (ring[k - 1][1] - door[1]) * my;
          const vx = (ring[k][0] - ring[k - 1][0]) * mx, vy = (ring[k][1] - ring[k - 1][1]) * my;
          const L = vx * vx + vy * vy;
          const t = L === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L));
          toWall = Math.min(toWall, Math.hypot(ax + t * vx, ay + t * vy));
        }
        assert.ok(toWall < 1, `door ${door} is ${toWall.toFixed(1)} m from footprint ${f.properties.i}'s wall`);
      }
      // ...and what was taken away was under the roof, which is the whole reason it went.
      for (const [a, b] of under) {
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        assert.ok(pointInRing(mid, ring), `a stub of footprint ${f.properties.i} runs outside it at ${mid}`);
      }
    }
  }
});

test('a walkway that stops short of the next carries on to it from its end cap', () => {
  // West of the south car park a walkway ends in a round cap 5.4 m from the
  // footway it points at, 2.1 m of the gap over lawn. The junction stage held
  // every connector to a metre off the paving and refused it, so the walkway
  // joined the rest only at its far end. A connector that carries a path on
  // from its end cap may cross more (JUNCTION_CAP_OFF_M); one from the bend
  // 39 m back along the same walkway, over the verge to the footway beside
  // it, may not.
  const CAP = '-121.348265,38.645826';
  const VERGE = '-121.347844,38.645713';
  const at = (key) => segments.filter((s) => s.geometry.coordinates.some((c) => String(c) === key));
  assert.ok(at(CAP).length >= 2, 'the walkway west of the south car park still ends in a dead end');
  const across = segments.filter((s) => s.geometry.coordinates.some((c) => String(c) === VERGE)
    && metresBetween(...s.geometry.coordinates) > 5 && metresBetween(...s.geometry.coordinates) < 6);
  assert.deepEqual(across.map((s) => s.geometry.coordinates.join(' -> ')), [], 'a connector crosses the verge');
});
