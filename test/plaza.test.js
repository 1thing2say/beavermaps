// src/plaza-paths.json — the ways across the sheet's paved plazas.
//
// The sheet draws a plaza as a filled surface, not a stroke, so until the last
// stage of scripts/build-walk-network.mjs the router only knew the paths drawn
// round its edge: a walk past the STEM Innovation Center went all the way round
// a plaza the map shows as open paving. These hold the file to what that stage
// promises — routed and welded to the drawn network, never through a building,
// never on anything but pavement — and to the walk that prompted it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, OPEN_GROUND_M } from '../server/graph.js';
import { load, metresBetween, pointInRing } from './helpers.js';

const plazas = load('plaza-paths').features;
const paths = load('paths').features;
const basemap = load('basemap').features;

const shipped = new Set(paths.flatMap((f) => f.geometry.coordinates.map(String)));

test('there are plaza crossings, and each is a straight two-point line tagged with its plaza', () => {
  assert.ok(plazas.length > 0, 'no plaza crossings at all');
  for (const f of plazas) {
    assert.equal(f.geometry.type, 'LineString');
    assert.equal(f.geometry.coordinates.length, 2);
    assert.equal(typeof f.properties.plaza, 'number');
  }
});

test('every plaza crossing ends on the drawn network or at a corner other crossings share', () => {
  // An end that is neither is a dangling line the router would offer as a way
  // to nowhere. Entry points are shipped vertices at their shipped coordinates,
  // so the weld is exact; corners exist only to turn at, so a corner is always
  // the end of at least two crossings.
  const uses = new Map();
  for (const f of plazas) for (const c of f.geometry.coordinates) uses.set(String(c), (uses.get(String(c)) ?? 0) + 1);
  for (const [c, n] of uses) {
    assert.ok(shipped.has(c) || n >= 2, `plaza crossing end ${c} is on no path and turns nowhere`);
  }
});

test('noding the crossings leaves no slivers', () => {
  // Three crossings through one point cut each other at three points a few
  // centimetres apart, and lines grazing a corner cut each other beside it:
  // each cut was a node of its own until the build snapped a cut onto a node
  // within 0.3 m of it (PLAZA_SNAP_M), and 13 crossings were under 10 cm, the
  // shortest 1.4 cm — a vertex for the route to turn at that nobody can see.
  const slivers = plazas.filter((f) => metresBetween(...f.geometry.coordinates) < 0.3);
  assert.deepEqual(slivers.map((f) => f.geometry.coordinates.join(' -> ')), []);
});

test('no plaza crossing passes through a building or the closed block', () => {
  const footprints = basemap
    .filter((f) => f.properties.kind === 'building' || f.properties.kind === 'closed')
    .flatMap(({ geometry: g }) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []));
  for (const f of plazas) {
    const [a, b] = f.geometry.coordinates;
    const n = Math.ceil(metresBetween(a, b) / 0.5);
    for (let k = 0; k <= n; k += 1) {
      const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
      const inside = footprints.some((rings) => pointInRing(p, rings[0]) && !rings.slice(1).some((r) => pointInRing(p, r)));
      assert.ok(!inside, `plaza crossing ${a} -> ${b} enters a building at ${p}`);
    }
  }
});

test('a walk past the STEM Innovation Center crosses its plaza instead of going round it', () => {
  // The report: the plaza round STEM is open paving on the map, and the router
  // sent a walk from its west side to its south-east corner the long way, by
  // the drawn paths round the plaza's edge. Both points are on the plaza.
  const west = [-121.3489, 38.65042];
  const southEast = [-121.34775, 38.64995];
  const options = {
    network: load('paths'), approach: load('approach-paths'), doors: load('doors'),
    boundary: load('campus-boundary'), buildings: load('buildings'),
  };
  const round = createGraph(options).route(west, southEast);
  const across = createGraph({ ...options, plazas: load('plaza-paths') }).route(west, southEast);
  assert.ok(round.ok && across.ok, `refused: ${round.error ?? across.error}`);
  const straight = metresBetween(west, southEast);
  const metres = (r) => r.distanceFeet * 0.3048;
  // By 15 m: the crossing keeps a hedge's clearance off the rows of planters
  // and trees across the plaza (PLAZA_GAP_M), and is kept within the build's
  // slack of the straightest way across (PLAZA_SPANNER), so it is a few
  // metres longer than a line brushing the planters would be.
  assert.ok(metres(across) < metres(round) - 15,
    `across the plaza ${metres(across).toFixed(0)} m is not clearly shorter than round it ${metres(round).toFixed(0)} m`);
  assert.ok(metres(across) < straight * 1.35,
    `${metres(across).toFixed(0)} m for ${straight.toFixed(0)} m as the crow flies is still going round`);
});

// Every walk between two places, by what route() minimises: `cost`, the walk
// along the network and both dotted legs, with the charge on a leg from the
// wider reach (OPEN_GROUND_WIDE_CHARGE in server/graph.js). Built from the
// same files, with the same options, as server/index.js builds the router,
// less whatever a test takes out or adds.
const options = {
  network: load('paths'), approach: load('approach-paths'), doors: load('doors'), boundary: load('campus-boundary'),
  entrances: load('directory').features.filter((f) => f.properties.doors)
    .map((f) => ({ doors: f.properties.doors, footprint: f.geometry })),
  buildings: load('buildings'),
};
const places = load('places').features.filter((f) => f.geometry?.type === 'Point')
  .map((f) => ({ name: f.properties.name, at: f.geometry.coordinates }));
function everyWalk(graph) {
  const out = [];
  for (let a = 0; a < places.length; a += 1) {
    for (let b = a + 1; b < places.length; b += 1) {
      const r = graph.route(places[a].at, places[b].at);
      out.push(r.ok ? { a, b, cost: r.cost } : { a, b, reason: r.reason });
    }
  }
  return out;
}
const withoutPlazas = everyWalk(createGraph(options));
const withPlazas = everyWalk(createGraph({ ...options, plazas: load('plaza-paths') }));

/** Each walk in `after` that costs more than in `before`, or is answered differently. */
function worse(before, after, skip = () => false) {
  const out = [];
  for (const [k, x] of before.entries()) {
    const y = after[k];
    if (skip(x.a) || skip(x.b)) continue;
    const name = `${places[x.a].name} -> ${places[x.b].name}`;
    if (x.reason !== y.reason) out.push(`${name}: ${x.reason ?? `${x.cost.toFixed(0)} m`} -> ${y.reason ?? `${y.cost.toFixed(0)} m`}`);
    else if (!x.reason && y.cost > x.cost + 0.5) out.push(`${name}: ${x.cost.toFixed(1)} -> ${y.cost.toFixed(1)} m`);
  }
  return out;
}

test('a plaza crossing never makes a walk between two places longer', () => {
  // More ways to walk can only shorten the cheapest one — unless the router
  // lets them take something away. The plaza lines did: measured as the
  // nearest edge, a crossing beside a place shrank the reach every other way
  // on is offered within, and 539 walks between places came out longer, the
  // Math Learning Center to Para Transit 333 -> 377 m. See `plazas` in
  // createGraph().
  const longer = worse(withoutPlazas, withPlazas);
  assert.deepEqual(longer.slice(0, 10), [], `${longer.length} walks longer or answered differently with the plazas`);
  const shorter = withPlazas.filter((w, k) => !w.reason && w.cost < withoutPlazas[k].cost - 0.5).length;
  assert.ok(shorter > 1000, `only ${shorter} walks between places are shorter across the plazas`);
});

test('a new connector never makes a walk between two places longer', () => {
  // The same promise for whatever is added next, and kept by the lot
  // connectors build-approach-network.mjs now draws through the north and
  // south-west car parks, from the entrances the campus clip cut to the campus
  // path beyond. The first of them used to be a connector this test added by
  // hand, from where the first answer used to decide whether the wider reach
  // was asked at all: Drop-off North to the permit machine by the lot went
  // 213 -> 351 m when three such connectors were added, because the new edge
  // brought the first answer just under DETOUR_SHARE times the straight line
  // and the better walk was never searched for. And a lot's pin stands on one:
  // Myrtle Parking Lot West is 0.2 m off it. Measured as its nearest edge, the
  // connector made that pin a point on a path, it lost every way across the
  // tarmac, and its walk to the Administration Building went 307 -> 371 m. So
  // the router offers lot connectors beside the drawn edges, like the plaza
  // lines, and with them every walk costs what it did without them or less.
  const approach = load('approach-paths');
  const lots = approach.features.filter((f) => f.properties.source === 'lot');
  assert.ok(lots.length >= 3, `test premise: only ${lots.length} lot connectors`);
  const onIt = (k) => lots.some(({ geometry: { coordinates: [a, b] } }) => {
    for (let t = 0; t <= 1; t += 0.01) {
      if (metresBetween(places[k].at, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]) < OPEN_GROUND_M) return true;
    }
    return false;
  });
  assert.ok(places.some((_, k) => onIt(k)), 'test premise: a place stands on a lot connector');
  const without = everyWalk(createGraph({
    ...options,
    plazas: load('plaza-paths'),
    approach: { ...approach, features: approach.features.filter((f) => f.properties.source !== 'lot') },
  }));
  const longer = worse(without, withPlazas);
  assert.deepEqual(longer.slice(0, 10), [], `${longer.length} walks longer or answered differently with the lot connectors`);
});

test('a point on a corner only plaza lines meet is offered every way the point beside it is', () => {
  // Such a corner is a vertex of the graph, and was answered as itself and
  // nothing else: from the middle of the plaza west of STEM, every way across
  // the paving and round it that a point a hand's width off was offered was
  // gone, and the walk to Raef Hall went 48.5 -> 106.4 m with the plazas.
  // Now the corner is one more way on, in front of the rest. A building's
  // door is left out: there the request is for the building (`entrances` in
  // createGraph()), and without the plazas the door is no vertex at all.
  const drawn = new Set(paths.flatMap((f) => f.geometry.coordinates.map(String)));
  const doors = new Set(options.entrances.flatMap((e) => e.doors.map(String)));
  const corners = [...new Set(plazas.flatMap((f) => f.geometry.coordinates.map(String)))]
    .filter((c) => !drawn.has(c) && !doors.has(c)).map((c) => c.split(',').map(Number));
  assert.ok(corners.length > 100, `test premise: only ${corners.length} corners only plaza lines meet`);
  const without = createGraph(options), withThem = createGraph({ ...options, plazas: load('plaza-paths') });
  const dearer = [];
  for (const corner of corners) {
    for (let k = 0; k < places.length; k += 12) {
      const x = without.route(corner, places[k].at), y = withThem.route(corner, places[k].at);
      if (x.ok && y.ok && y.cost > x.cost + 0.5) dearer.push(`${corner} -> ${places[k].name}: ${x.cost.toFixed(1)} -> ${y.cost.toFixed(1)} m`);
      else if (x.ok && !y.ok) dearer.push(`${corner} -> ${places[k].name}: ${x.cost.toFixed(1)} m -> ${y.reason}`);
    }
  }
  assert.deepEqual(dearer.slice(0, 10), [], `${dearer.length} walks from a plaza corner cost more with the plazas`);
});
