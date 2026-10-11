// server/graph.js — the router, and the question it used to get wrong.
//
// This file exists because server/index.js could not be imported. It built the
// graph at module scope and called app.listen() on the way past, so every
// question about the router was a question you could only ask over HTTP, and
// the one that mattered — "what does this answer somebody who is not near the
// campus" — went unasked for as long as the endpoint existed.
//
// The answer was a route. `nearestPoint` has no notion of too far, so a request
// from Paris came back 200 with a real 7,520 ft walk starting at a vertex in
// Sacramento. src/directions.js had had REACH_M written down the whole time,
// with a comment describing that exact failure; it was enforced in the browser
// and nowhere else, which means it was enforced for our own front-end and for
// nothing else that can reach the endpoint.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGraph, VERTEX_PRECISION, SNAP_WELD_M, STREETSIDE_M, OPEN_GROUND_M, OPEN_GROUND_WIDE_M,
  OPEN_GROUND_SHARE, OPEN_GROUND_MAX_M, DETOUR_SHARE, WALL_CLIP_M,
} from '../server/graph.js';
import { REACH_M } from '../src/directions.js';
import { load, metresBetween, pointInRing, vertexKey } from './helpers.js';

// The real committed artifacts, because a router built out of a fixture would
// answer questions about the fixture — and built from the same files, with the
// same options, as server/index.js builds it. About 50 ms, once, for the file.
const graph = createGraph({
  network: load('paths'),
  approach: load('approach-paths'),
  plazas: load('plaza-paths'),
  doors: load('doors'),
  boundary: load('campus-boundary'),
  entrances: load('directory').features.filter((f) => f.properties.doors)
    .map((f) => ({ doors: f.properties.doors, footprint: f.geometry })),
  buildings: load('buildings'),
});

/** Somewhere on the campus network, taken from the data rather than typed. */
const ON_CAMPUS = load('paths').features[0].geometry.coordinates[0];
const ALSO_ON_CAMPUS = load('paths').features.at(-1).geometry.coordinates.at(-1);

const PARIS = [2.3522, 48.8566];
// Sacramento's own downtown: a few miles away, which is the realistic version
// of this mistake. Somebody opens the app from home.
const ACROSS_TOWN = [-121.4944, 38.5816];

test('the graph welds the campus and approach networks into one', () => {
  // The two files share vertices at seven decimals and geojson-path-finder
  // builds topology from coordinates, so concatenation IS the merge. If that
  // ever stopped being true this is where it would show: a route between two
  // campus points would still work, and every route that leaves by a gate
  // would not.
  assert.equal(graph.segmentCount,
    load('paths').features.length + load('plaza-paths').features.length + load('approach-paths').features.length);
  assert.ok(graph.vertices.length > 6000, `only ${graph.vertices.length} vertices`);
});

test('a walk between two campus points is found', () => {
  const result = graph.route(ON_CAMPUS, ALSO_ON_CAMPUS);
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.equal(result.geometry.type, 'LineString');
  assert.ok(result.geometry.coordinates.length >= 2);
  assert.ok(result.distanceFeet > 0);
  // Every route carries a maneuver list, and it always has both ends in it.
  assert.ok(result.maneuvers.length >= 2);
});

test('a start on the other side of the world is refused, not routed', () => {
  const result = graph.route(PARIS, ALSO_ON_CAMPUS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
  assert.equal(result.which, 'start');
  // The sentence is directions.js's, not one invented here — the browser and
  // the server refuse in the same words because it is the same rule.
  assert.match(result.error, /too far to walk from here/);
});

test('a start a few miles away is refused too — this is the realistic case', () => {
  // Paris is the version of this bug that is obvious once you see it. This is
  // the version that shipped: near enough that the numbers look plausible.
  const result = graph.route(ACROSS_TOWN, ALSO_ON_CAMPUS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
});

test('an unreachable DESTINATION is refused as well, and says which end', () => {
  const result = graph.route(ON_CAMPUS, PARIS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
  assert.equal(result.which, 'end');
});

test('the start is reported first when both ends are unreachable', () => {
  // Not arbitrary: a destination is picked off the campus directory and an
  // origin is wherever the phone says you are standing, so the origin is the
  // one a person can be wrong about and the one worth naming.
  const result = graph.route(PARIS, ACROSS_TOWN);
  assert.equal(result.which, 'start');
});

test('REACH_M is the line the router actually draws', () => {
  // The property worth asserting is not where the boundary falls on the map —
  // the network is dense enough that stepping 450 m off one vertex usually
  // lands you near another — but that the router's decision IS reachProblem's
  // decision. One rule, one constant, written down in src/directions.js and
  // obeyed on both sides of the wire.
  //
  // Sampled over a wide box so the set covers both answers: points on the
  // campus, points out in the fields around it, and points well past anything
  // this server has ever heard of.
  let refused = 0;
  let allowed = 0;

  for (let dLon = -0.25; dLon <= 0.25; dLon += 0.05) {
    for (let dLat = -0.25; dLat <= 0.25; dLat += 0.05) {
      const at = [-121.3465 + dLon, 38.6486 + dLat];
      const snapped = graph.snap(at);
      const result = graph.route(at, ALSO_ON_CAMPUS);
      const tooFar = snapped.metres > REACH_M;

      assert.equal(
        result.reason === 'unreachable', tooFar,
        `${at} snaps ${snapped.metres.toFixed(0)} m away — REACH_M is ${REACH_M}`,
      );
      if (tooFar) refused++; else allowed++;
    }
  }

  // Both answers have to actually occur, or the assertion above is vacuous.
  assert.ok(refused > 0 && allowed > 0, `refused ${refused}, allowed ${allowed}`);
});

test('snap reports metres, which is what REACH_M is in', () => {
  // turf answers in km and the constant is in metres. That conversion living in
  // the wrong place would make every refusal a thousand times too generous —
  // which is indistinguishable from no check at all.
  const near = graph.snap(graph.vertices[0]);
  assert.equal(near.metres, 0);

  const far = graph.snap(PARIS);
  assert.ok(far.metres > 1e6, `Paris is ${far.metres} m away — that is not metres`);
});

test('a snapped point is on the network, and the line starts exactly there', () => {
  // It used to be a vertex, exactly, because the path finder only accepts
  // vertices. It is now the nearest point on the nearest edge, which is
  // usually between two; route() enters the graph at the edge's ends and the
  // line it answers with begins at the snapped point itself.
  const at = [ON_CAMPUS[0] + 0.0001, ON_CAMPUS[1] + 0.0001];
  const snapped = graph.snap(at);
  const segments = [...load('paths').features, ...load('approach-paths').features]
    .flatMap(({ geometry: { coordinates: cs } }) => cs.slice(1).map((b, k) => [cs[k], b]));
  const off = Math.min(...segments.map(([a, b]) => toSegment(snapped.coord, a, b)));
  assert.ok(off < 0.05, `the snapped point is ${off.toFixed(2)} m off the network`);
  assert.ok(Math.abs(snapped.metres - metresBetween(at, snapped.coord)) < 0.05);

  const result = graph.route(at, ALSO_ON_CAMPUS);
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.deepEqual(result.geometry.coordinates[0], result.snapped.from);
  assert.deepEqual(result.geometry.coordinates.at(-1), result.snapped.to);
});

/** Metres from p to segment a-b, flat-earth over a 1 km campus. */
function toSegment(p, a, b) {
  const mx = metresBetween([0, p[1]], [1e-4, p[1]]) * 1e4;
  const my = metresBetween([p[0], 0], [p[0], 1e-4]) * 1e4;
  const ax = (a[0] - p[0]) * mx, ay = (a[1] - p[1]) * my;
  const vx = (b[0] - a[0]) * mx, vy = (b[1] - a[1]) * my;
  const L = vx * vx + vy * vy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L));
  return Math.hypot(ax + t * vx, ay + t * vy);
}

/**
 * A point `side` metres to the left of the campus's longest edge, `t` of the
 * way along it, and the point on the edge it is beside. Taken from the data,
 * so the test follows whichever edge is longest after the next rebuild.
 */
function besideLongestEdge(t, side) {
  const [a, b] = load('paths').features
    .map((f) => f.geometry.coordinates)
    .reduce((x, y) => (metresBetween(...y) > metresBetween(...x) ? y : x));
  const on = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  // Perpendicular, in degrees scaled back from metres at this latitude.
  const mx = metresBetween([0, on[1]], [1e-4, on[1]]) * 1e4;
  const my = metresBetween([on[0], 0], [on[0], 1e-4]) * 1e4;
  const ex = (b[0] - a[0]) * mx, ey = (b[1] - a[1]) * my;
  const len = Math.hypot(ex, ey);
  return { a, b, on, len, at: [on[0] - (ey / len) * side / mx, on[1] + (ex / len) * side / my] };
}

test('a point beside the middle of a long edge joins it there, not at a far vertex', () => {
  // THE BUG THIS REPLACES. The build collapses a stroke traced as a run of
  // near-collinear points into the one straight edge it is, so the campus now
  // has edges well over a hundred metres long with no vertex in between. The
  // router snapped to the nearest VERTEX, so a point beside the middle of one
  // began its walk fifty-odd metres up the path and came back past where it
  // started: College Oak Parking Lot to the STEM building went 154 m to 210 m.
  const mid = besideLongestEdge(0.5, 4);
  assert.ok(mid.len > 100, `test premise: the longest edge is only ${mid.len.toFixed(0)} m`);
  // Today the nearest vertex is 26 m off, on another path entirely.
  const nearestVertex = Math.min(...graph.vertices.map((v) => metresBetween(mid.at, v)));
  assert.ok(nearestVertex > 20, `test premise: a vertex is ${nearestVertex.toFixed(0)} m from the middle`);

  const snapped = graph.snap(mid.at);
  assert.ok(Math.abs(snapped.metres - 4) < 0.2, `snapped ${snapped.metres.toFixed(1)} m away, not 4`);
  assert.ok(metresBetween(snapped.coord, mid.on) < 0.2, 'snapped somewhere other than the foot');

  // Walking along the edge to a point beside it further on is walking along
  // the edge: one straight line, a depart and an arrive, and the distance
  // between the two feet — not out to an end and back.
  const further = besideLongestEdge(0.75, 4);
  const along = graph.route(mid.at, further.at);
  assert.ok(along.ok, `refused: ${along.error}`);
  assert.equal(along.geometry.coordinates.length, 2);
  assert.deepEqual(along.maneuvers.map((m) => m.type), ['depart', 'arrive']);
  const walked = along.distanceFeet * 0.3048;
  assert.ok(Math.abs(walked - mid.len / 4) < 1, `${walked.toFixed(1)} m to go ${(mid.len / 4).toFixed(1)} m`);

  // And a walk to anywhere else leaves along the edge: the line's first
  // segment runs from the foot to one of the edge's own ends.
  const away = graph.route(mid.at, ALSO_ON_CAMPUS);
  assert.ok(away.ok, `refused: ${away.error}`);
  const [first, second] = away.geometry.coordinates;
  assert.ok(metresBetween(first, mid.on) < 0.2);
  assert.ok([mid.a, mid.b].some((end) => metresBetween(second, end) < 0.01),
    'the walk does not leave the foot along its own edge');
});

test('a destination about as far from two paths leaves by the one that leads where it is going', () => {
  // The STEM building's place in the directory is 30.6 m from a path to its
  // east and 32 m from the STEM walkway to its south. Nearest-only, a walk
  // from College Oak Parking Lot, to the west, ends on the east side and
  // goes round the building to get there. Every edge within the slack is
  // offered, the extra metres to it counted, and the walk picks the south.
  const COLLEGE_OAK = [-121.3494648, 38.6499344];
  const STEM = [-121.3484103, 38.6501505];
  const nearest = graph.snap(STEM);
  const chosen = graph.route(COLLEGE_OAK, STEM);
  assert.ok(chosen.ok, `refused: ${chosen.error}`);
  const total = (r, to) => r.distanceFeet * 0.3048
    + metresBetween(COLLEGE_OAK, r.snapped.from) + metresBetween(to, r.snapped.to);
  const viaNearest = graph.route(COLLEGE_OAK, nearest.coord);
  assert.ok(viaNearest.ok);
  assert.notDeepEqual(chosen.snapped.to, nearest.coord, 'the walk took the nearest side anyway');
  assert.ok(total(chosen, STEM) < total(viaNearest, STEM) - 20,
    `${total(chosen, STEM).toFixed(0)} m against ${total(viaNearest, STEM).toFixed(0)} m by the nearest side`);
  // The side it chose is one it was offered: STEM's place is 30.6 m off the
  // network, which is open ground (OPEN_GROUND_M), so a way on in any
  // direction out to the open-ground reach — no further.
  const leg = metresBetween(STEM, chosen.snapped.to);
  assert.ok(leg <= Math.min(OPEN_GROUND_SHARE * nearest.metres, nearest.metres + OPEN_GROUND_MAX_M) + 0.1,
    `a ${leg.toFixed(0)} m leg, ${nearest.metres.toFixed(0)} m from the nearest edge`);
});

test('a bus stop on the kerb walks onto the campus beside it, not up the street to a gate', () => {
  // The Admin bus stop is 4.7 m from the street's centreline and 16.7 m from
  // the campus walk behind it. Snapping to the nearest edge put it on the
  // street, which joins the campus only at gates a hundred-odd metres either
  // way, so the parking machine 41 m off was a 224 m walk. It was 50 m when
  // the router took the nearest vertex, which there was a campus one.
  const BUS_STOP = [-121.3503761, 38.6508654];
  const PARKING = [-121.3500886, 38.6511552];
  const nearest = graph.snap(BUS_STOP);
  assert.ok(nearest.metres < 5, `test premise: the street is ${nearest.metres.toFixed(1)} m off`);

  const result = graph.route(BUS_STOP, PARKING);
  assert.ok(result.ok, `refused: ${result.error}`);
  const total = result.distanceFeet * 0.3048
    + metresBetween(BUS_STOP, result.snapped.from) + metresBetween(PARKING, result.snapped.to);
  assert.ok(total < 70, `${total.toFixed(0)} m from the stop to a machine 41 m away`);
  // ...by stepping onto the campus, within STREETSIDE_M, not onto the street.
  assert.notDeepEqual(result.snapped.from, nearest.coord);
  assert.ok(metresBetween(BUS_STOP, result.snapped.from) <= STREETSIDE_M);
});

test('across the centreline, the street still leads to the gate', () => {
  // Seven metres west of that stop the street is between you and the campus,
  // and the campus walk is still inside STREETSIDE_M. Being near is not
  // enough: the walk leaves along the street, not straight over the traffic.
  const BUS_STOP = [-121.3503761, 38.6508654];
  const ACROSS = [BUS_STOP[0] - 7 / metresBetween([0, BUS_STOP[1]], [1, BUS_STOP[1]]), BUS_STOP[1]];
  const PARKING = [-121.3500886, 38.6511552];
  const nearest = graph.snap(ACROSS);
  const result = graph.route(ACROSS, PARKING);
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.deepEqual(result.snapped.from, nearest.coord, 'the walk crossed straight to the campus');
});

test('a car park inside the boundary walks to the campus path, not out to the road', () => {
  // The north car parks are campus ground with no campus path through them:
  // OSM draws their aisles and the clip removes them. A permit machine there
  // is 41 m from the road outside the boundary and 56 m from the walk through
  // the lot, and joining the road meant leaving the campus and coming back in
  // at a gate — 495 m to the Arts & Science building, against 263 m walking
  // through the car park.
  const PERMIT_MACHINE = [-121.3495805, 38.6532779];
  const ARTS_AND_SCIENCE = load('directory').features
    .find((f) => f.properties.name.startsWith('Arts & Sci')).properties.anchor;
  const nearest = graph.snap(PERMIT_MACHINE);
  assert.ok(nearest.metres < 45, `test premise: the road is ${nearest.metres.toFixed(1)} m off`);

  const result = graph.route(PERMIT_MACHINE, ARTS_AND_SCIENCE);
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.notDeepEqual(result.snapped.from, nearest.coord, 'the walk went out to the road');
  const total = result.distanceFeet * 0.3048 + metresBetween(PERMIT_MACHINE, result.snapped.from)
    + metresBetween(ARTS_AND_SCIENCE, result.snapped.to);
  assert.ok(total < 300, `${total.toFixed(0)} m from the car park`);

  // Without the boundary the router cannot tell the car park from the road
  // outside it, and used to take the road. The open-ground rule now finds the
  // lot's walk on its own — 56 m off, within 40 m of the road's 41 — so the
  // two agree here; the boundary is what still offers it further out than that.
  const bare = createGraph({ network: load('paths'), approach: load('approach-paths'), doors: load('doors') });
  assert.deepEqual(bare.route(PERMIT_MACHINE, ARTS_AND_SCIENCE).snapped.from, result.snapped.from);
});

test('two nearby rooms are walked between, not declared the same place', () => {
  // TRIO and the Veterans Resource Center are 27 m apart, and the Center's
  // own node was within the slack of TRIO when this was written — so the
  // cheapest pairing of ways on and off was "walk across to it", with nothing
  // along the network. That is not a route; the walk is the cheapest one that
  // is, and a short one is not refused as a detour on not walking at all.
  const TRIO = [-121.3485883, 38.6512852];
  const VETERANS = [-121.3484245, 38.6510656];
  const result = graph.route(TRIO, VETERANS);
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.ok(result.distanceFeet * 0.3048 >= SNAP_WELD_M);
  const total = result.distanceFeet * 0.3048
    + metresBetween(TRIO, result.snapped.from) + metresBetween(VETERANS, result.snapped.to);
  // 57 m before the build collapsed the walkway; 105 m by the nearest side.
  assert.ok(total < 60, `${total.toFixed(0)} m between two rooms 27 m apart`);
});

test('a point on the network is never moved off it to a path beside it', () => {
  // The alternatives are for points well off the network, where which side is
  // nearest is a matter of a metre. A building's entrance is a node; walking
  // to it ends at it, or at another of the building's own doors, never on a
  // parallel path a few metres away with a dotted line across whatever is
  // between.
  for (const feature of load('directory').features) {
    const { entrance, doors = [entrance], name } = feature.properties;
    if (!entrance) continue;
    const result = graph.route(ALSO_ON_CAMPUS, entrance);
    if (!result.ok) continue;
    assert.ok(doors.some((d) => vertexKey(d) === vertexKey(result.snapped.to)),
      `${name}'s walk ends off its doors, at ${result.snapped.to}`);
  }
});

test('a walk to a building may end at any of its doors, and says which', () => {
  // The card's Directions sends the entrance, which is one door of several.
  // The Theatre's box office is 85 m from Fine & Applied Arts' entrance, on
  // its north wall, and 6 m from the door in its south-west corner: the walk
  // used to go round to the north wall, 238 m. It ends at the near door now,
  // and `door.to` says so, so the browser moves the pin there.
  const BOX_OFFICE = [-121.349493, 38.6519142];
  const arts = load('directory').features.find((f) => f.properties.name === 'Fine & Applied Arts').properties;
  assert.ok(arts.doors.length > 1, 'test premise: Fine & Applied Arts has several doors');
  const result = graph.route(BOX_OFFICE, arts.entrance);
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.ok(arts.doors.some((d) => vertexKey(d) === vertexKey(result.door.to)), 'door.to is not one of its doors');
  assert.deepEqual(result.door.to, result.snapped.to);
  assert.equal(result.door.from, null, 'a place that is not a building reports no door');
  const total = result.distanceFeet * 0.3048 + metresBetween(BOX_OFFICE, result.snapped.from);
  assert.ok(total < 60, `${total.toFixed(0)} m to Fine & Applied Arts from the box office beside it`);

  // Without the door lists the entrance is the only end, as it was.
  const bare = createGraph({ network: load('paths'), approach: load('approach-paths'), doors: load('doors') });
  assert.deepEqual(bare.route(BOX_OFFICE, arts.entrance).snapped.to, arts.entrance);
});

test('a room inside a building and the building are the same place', () => {
  // A restroom in the Student Center, asked for directions to the Student
  // Center. Every door is an end of the building, so a pairing of doors that
  // walks somewhere always exists — from one door round the outside to the
  // next — and the router used to offer it, 101 m. You are already there.
  const RESTROOM = [-121.3469722, 38.6512283];
  const center = load('directory').features.find((f) => f.properties.name === 'Student Center').properties;
  const result = graph.route(RESTROOM, center.entrance);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'same-place');
  assert.equal(graph.route(center.entrance, RESTROOM).reason, 'same-place');
});

test('anywhere inside a building and the building are the same place', () => {
  // The rule above used to reach only a room that resolves to its building's
  // doors — one nearer an approach path the walls stage peeled than the
  // network that is left. Most of what stands in a building is not, and was
  // walked to it: the Library to the Library in 10 m, the vending machine in
  // STEM to STEM in 4. Inside the footprint is inside, whatever it snapped to.
  const buildings = load('directory').features.filter((f) => f.properties.entrance);
  let inside = 0;
  for (const place of load('places').features.filter((f) => f.geometry?.type === 'Point')) {
    const at = place.geometry.coordinates;
    const own = buildings.find((f) => f.geometry.coordinates.some((polygon) => pointInRing(at, polygon[0])));
    if (!own) continue;
    inside += 1;
    for (const [from, to] of [[at, own.properties.entrance], [own.properties.entrance, at]]) {
      const result = graph.route(from, to);
      assert.equal(result.reason, 'same-place',
        `${place.properties.name} and ${own.properties.name}, which it is inside: ${result.ok
          ? `${(result.distanceFeet * 0.3048).toFixed(0)} m walk` : result.reason}`);
    }
  }
  assert.ok(inside > 80, `test premise: only ${inside} places inside a directory building`);
});

test('a walk that is a detour on not walking the paths at all is no walk', () => {
  // Two rooms in the Student Center 2.7 m apart both leave by the door between
  // them, and the walk that was not that went out of one door and round to
  // another: 124 m. The paths have nothing to add.
  const RESTROOM = [-121.3469544, 38.6512627];
  const UNITE_CENTER = [-121.3469545, 38.6512384];
  const result = graph.route(RESTROOM, UNITE_CENTER);
  assert.equal(result.reason, 'same-place', result.ok
    ? `a ${(result.distanceFeet * 0.3048).toFixed(0)} m walk between two rooms 2.7 m apart` : result.reason);
  assert.match(result.error, /pick a destination/i);
});

test('a walk across a plaza is a walk, not a detour on not walking at all', () => {
  // The Student Technology Center's way across the grass to the STEM Center
  // used to land on STEM's entrance itself, 32.5 m off; the cheapest walk that
  // was one left by the nearest path and went 60 m round to the same door, and
  // was refused as the same place. The plaza in between is paving the sheet
  // fills rather than strokes, and with its crossings (src/plaza-paths.json)
  // the walk goes straight over it: a walk, and the straight line give or
  // take the slack the build keeps crossings within (3 m and 8%, see
  // PLAZA_SPANNER in scripts/build-walk-network.mjs).
  const TECHNOLOGY_CENTER = [-121.3477597, 38.6505508];
  const stem = load('directory').features
    .find((f) => f.properties.name === 'Diane Bryant STEM Innovation Center').properties;
  const result = graph.route(TECHNOLOGY_CENTER, stem.entrance);
  assert.ok(result.ok, `refused: ${result.error}`);
  const total = result.distanceFeet * 0.3048 + metresBetween(TECHNOLOGY_CENTER, result.snapped.from)
    + metresBetween(result.snapped.to, stem.entrance);
  const straight = metresBetween(TECHNOLOGY_CENTER, stem.entrance);
  assert.ok(total <= 1.08 * straight + 3, `${total.toFixed(1)} m, legs and all, for ${straight.toFixed(1)} m as the crow flies`);
});

test('a room leaves by whichever door of its building suits the walk', () => {
  // The defibrillator in the gallery's building resolves to the door its
  // nearest drawn approach path left, on the east wall, and that used to be
  // its only way out: 116 m to the Gallery entrance 33 m away. The building's
  // other door is on the side facing the Gallery.
  const DEFIBRILLATOR = [-121.3485544, 38.6519989];
  const gallery = load('directory').features.find((f) => f.properties.name === 'Gallery').properties;
  const result = graph.route(DEFIBRILLATOR, gallery.entrance);
  assert.ok(result.ok, `refused: ${result.error}`);
  const total = result.distanceFeet * 0.3048 + metresBetween(DEFIBRILLATOR, result.snapped.from);
  assert.ok(total < 60, `${total.toFixed(0)} m from the defibrillator to the Gallery`);
});

test('a walk to a building is never longer than one to where its walls come nearest', () => {
  // Before the walls stage, a walk to a building ended at the node nearest its
  // walls. The directory now sends the card's Directions to a drawn door where
  // there is one, and that moved the end of every walk to the Library to its
  // one drawn approach path: from restroom #51, 92 m became 171 m, with the
  // old end still on the graph 2.3 m from a corner. Where the walls come
  // nearest is still one of a building's ways in, after its drawn doors, and
  // the walk takes whichever is nearer. Measured against a router with no
  // door lists, walking to the node at that point; the building's own walk
  // must be no longer.
  const plain = createGraph({
    network: load('paths'), approach: load('approach-paths'), doors: load('doors'),
    boundary: load('campus-boundary'), buildings: load('buildings'),
  });
  const segments = load('paths').features.map((f) => f.geometry.coordinates);
  const wallNode = (feature) => {
    let wall = null;
    for (const corner of feature.geometry.coordinates.flatMap((polygon) => polygon.flat())) {
      for (const [a, b] of segments) {
        for (let k = 0; k <= 40; k += 1) {
          const q = [a[0] + (k / 40) * (b[0] - a[0]), a[1] + (k / 40) * (b[1] - a[1])];
          const d = metresBetween(corner, q);
          if (!wall || d < wall.d) wall = { d, q };
        }
      }
    }
    return graph.vertices.reduce((x, y) => (metresBetween(y, wall.q) < metresBetween(x, wall.q) ? y : x));
  };
  const total = (result, from, to) => result.distanceFeet * 0.3048 + metresBetween(from, result.snapped.from)
    + (result.door?.to ? 0 : metresBetween(to, result.snapped.to));
  // From outside every building. The two routers treat a START inside one
  // differently — the one with door lists leaves by the building's ways in,
  // the plain one by whatever edge is nearest through the wall — and this is a
  // question about the far end. Room 169 in Howard Hall used to leave by an
  // edge clipping the roof's east corner; with that edge stood off the wall it
  // leaves by Howard's doors, 1.7 m longer than the plain router's way out
  // through the north wall to the Science Success Center, and nothing about
  // the Center's end differs.
  const directory = load('directory').features;
  const indoors = (c) => directory.some((f) => f.geometry.coordinates.some(([ring]) => pointInRing(c, ring)));
  const origins = load('places').features.filter((f) => f.geometry?.type === 'Point')
    .map((f) => f.geometry.coordinates).filter((c) => !indoors(c)).filter((_, k) => k % 3 === 0);
  let compared = 0;
  for (const feature of directory) {
    const { entrance, name } = feature.properties;
    if (!entrance) continue;
    const node = wallNode(feature);
    for (const from of origins) {
      const mine = graph.route(from, entrance), there = plain.route(from, node);
      if (!mine.ok || !there.ok) continue;
      assert.ok(total(mine, from, entrance) <= total(there, from, node) + 0.5,
        `from ${from}, ${total(mine, from, entrance).toFixed(0)} m to ${name} against `
        + `${total(there, from, node).toFixed(0)} m to where its walls come nearest`);
      compared += 1;
    }
  }
  assert.ok(compared > 300, `only ${compared} walks compared`);
});

test('a room at the fork of two walkways leaves by the arm that leads where it is going', () => {
  // The Evangelisti Culinary Arts Center's north door is where walkway 1259 met
  // the wall before the walls stage cut its passage through the building, 7.5 m
  // down from the apex it forks from with walkway 1293 — and 1293 passes 3.7 m
  // from the door. With the door as the only way out, a walk from the
  // emergency telephone on 1293 went up 1293 to the apex and back down 1259:
  // 51 m, where the nearest-vertex router walked 40.7 m. The building is also
  // entered where its walls come nearest the network, which is on 1293.
  const TELEPHONE = [-121.3484364, 38.6524225];
  const OAK_CAFE = [-121.3485117, 38.6527007];
  for (const [from, to] of [[TELEPHONE, OAK_CAFE], [OAK_CAFE, TELEPHONE]]) {
    const result = graph.route(from, to);
    assert.ok(result.ok, `refused: ${result.error}`);
    const total = result.distanceFeet * 0.3048 + metresBetween(from, result.snapped.from)
      + metresBetween(to, result.snapped.to);
    assert.ok(total <= 1.25 * 40.7, `${total.toFixed(1)} m between the telephone and the Oak Café`);
  }
});

test("a room's other ways into its building are within reach of it", () => {
  // A room may leave by any of its building's ways in (see the fork above),
  // and with no bound on how far, the emergency telephones in the Parking
  // Garage, 7.7 m from its nearest door, began the walk to the Baseball field
  // with a 132 m dotted line diagonally across the garage deck to where its
  // walls come nearest the network on the far side. Its drawn doors are the
  // building's own and stay on offer; the rest are offered within
  // OPEN_GROUND_MAX_M further than the nearest door, OPEN_GROUND_WIDE_M when
  // the walk is a detour.
  const TELEPHONE = [-121.3479177, 38.6482134];
  const drawn = new Set(load('doors').features
    .flatMap((f) => f.properties.stubs.flatMap((stub) => stub.doors)).map(vertexKey));
  const nearest = graph.snap(TELEPHONE).metres;
  let routed = 0;
  for (const place of load('places').features.filter((f) => f.geometry?.type === 'Point')) {
    const result = graph.route(TELEPHONE, place.geometry.coordinates);
    if (!result.ok) continue;
    routed += 1;
    if (drawn.has(vertexKey(result.snapped.from))) continue;
    const leg = metresBetween(TELEPHONE, result.snapped.from);
    assert.ok(leg <= nearest + OPEN_GROUND_WIDE_M + 0.5,
      `a ${leg.toFixed(0)} m leg from the telephone to ${place.properties.name}, its nearest door ${nearest.toFixed(1)} m off`);
  }
  assert.ok(routed > 100, `test premise: only ${routed} walks from the telephone`);
});

test('a walk never leaves the network where it joined it', () => {
  // A walk shorter than the weld is passed over, and the walk is the cheapest
  // that is one. Two points on a lawn 17 m apart each had a way across the
  // grass to the same few metres of path, and the cheapest walk between those
  // two feet that was long enough went 8 m along the path and back: 54 ft,
  // "1 turn", with both dotted legs meeting where the line began. Off the
  // campus, two points either side of a footway came back as 17.7 m out and
  // back again. A pairing of two ways onto the same place is passed over now.
  const bearing = (a, b) => Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]);
  for (const [from, to] of [
    [[-121.349365, 38.6484832], [-121.3493863, 38.648635]],
    [[-121.3508534, 38.6505275], [-121.3508438, 38.6508701]],
  ]) {
    const result = graph.route(from, to);
    if (!result.ok) {
      assert.equal(result.reason, 'same-place');
      continue;
    }
    assert.ok(metresBetween(result.snapped.from, result.snapped.to) >= SNAP_WELD_M,
      `joins at ${result.snapped.from} and leaves ${metresBetween(result.snapped.from, result.snapped.to).toFixed(2)} m away`);
    const cs = result.geometry.coordinates;
    for (let k = 1; k < cs.length - 1; k += 1) {
      let turn = Math.abs(bearing(cs[k - 1], cs[k]) - bearing(cs[k], cs[k + 1])) * (180 / Math.PI);
      if (turn > 180) turn = 360 - turn;
      assert.ok(turn <= 170, `the walk turns back on itself, ${turn.toFixed(0)} degrees at ${cs[k]}`);
    }
  }
});

test('a walk across the Fine & Applied Arts plaza does not double back at its start', () => {
  // The hand link across the plaza ran over the drawn stroke turning south
  // out of it, from the same node, 6 degrees apart. Snapped onto the link, a
  // walk south went 10 m east along it and came 6 m back down the stroke:
  // "Make a U-turn" 48 ft in. The build folds the link onto the stroke now.
  const result = graph.route([-121.3502, 38.652028], [-121.3489, 38.6468]);
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.ok(!result.maneuvers.some((m) => m.type === 'uturn'),
    `a U-turn at ${result.maneuvers.find((m) => m.type === 'uturn')?.coordinate}`);
});

test('a point on open ground can join the network in any direction', () => {
  // A permit machine in the north car park is 10 m from the walk down the
  // lot's east side and 46 m from the corner of the walk at its west end. With
  // only the nearest on offer, the Science Success Center 89 m away was 272 m
  // up the east side and round; across the tarmac to the west corner it is
  // under 100, as the nearest-vertex router made it (93 m).
  const PERMIT = [-121.3460567, 38.6530401];
  const center = load('directory').features.find((f) => f.properties.name === 'Science Success Center').properties;
  const near = graph.snap(PERMIT);
  assert.ok(near.metres >= OPEN_GROUND_M, `test premise: the machine is ${near.metres.toFixed(1)} m off the network`);
  const result = graph.route(center.entrance, PERMIT);
  assert.ok(result.ok, `refused: ${result.error}`);
  const total = result.distanceFeet * 0.3048 + metresBetween(PERMIT, result.snapped.to);
  assert.ok(total < 1.5 * 92.8, `${total.toFixed(0)} m from the Science Success Center to the permit machine`);
  assert.notDeepEqual(result.snapped.to, near.coord, 'the walk still goes round by the nearest edge');
});

test('a point on open ground beside a path that leads the long way round may cross to one that does not', () => {
  // A point on a lawn 7.2 m from walkway 1313 was offered ways on out to the
  // open-ground reach, 36 m. The end of walkway 1314, 58 m across the same
  // lawn, was beyond it, and a walk to a point 123 m away went down 1313 and
  // back up: 336 m, where the nearest-vertex router, snapped to 1314, walked
  // 155. A walk more than DETOUR_SHARE times the straight line is asked again
  // with the wider reach, and the shorter of the two answers.
  const LAWN = [-121.3471995, 38.6465278];
  const EAST = [-121.3458669, 38.6461471];
  assert.ok(graph.snap(LAWN).metres >= OPEN_GROUND_M, 'test premise: the point is on open ground');
  for (const [from, to] of [[LAWN, EAST], [EAST, LAWN]]) {
    const result = graph.route(from, to);
    assert.ok(result.ok, `refused: ${result.error}`);
    const total = result.distanceFeet * 0.3048 + metresBetween(from, result.snapped.from)
      + metresBetween(to, result.snapped.to);
    assert.ok(total <= DETOUR_SHARE * metresBetween(from, to), `${total.toFixed(0)} m for two points 123 m apart`);
  }
});

test('a better walk from the wider reach is never hidden by a nearly-as-bad one', () => {
  // The wider reach used to be asked only when the first answer came out more
  // than DETOUR_SHARE times the straight line, so a first answer just under
  // that stood however much better the wider one was: from the drink machine
  // in the building west of the Soccer Stadium, the walk left by the door
  // nearest the machine and went 197 m round, where leaving by the building's
  // way in on its north side is 81 m. The wider reach is always searched now,
  // its legs charged beyond the first reach (OPEN_GROUND_WIDE_CHARGE).
  const MACHINE = [-121.3469402, 38.6490244];
  const SOCCER = [-121.3454879, 38.6490263];
  const result = graph.route(MACHINE, SOCCER);
  assert.ok(result.ok, `refused: ${result.error}`);
  const walked = result.distanceFeet * 0.3048;
  assert.ok(walked <= 90, `${walked.toFixed(0)} m along the paths from the drink machine to the Soccer Stadium`);
});

// How far inside each footprint a leg from p to q goes, metres, read every
// 10 cm: not the stretch it leaves the footprint p stands in by, and not its
// last SNAP_WELD_M, which stands for the wall of a door the leg ends at. The
// router's own sum is in server/graph.js; this one is written again, slowly,
// so the two can disagree.
const BUILDINGS = load('buildings').features.map((f) => {
  const ring = f.geometry.coordinates[0];
  const xs = ring.map((c) => c[0]), ys = ring.map((c) => c[1]);
  return { ring, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
});
function deepestInside(p, q) {
  const whole = metresBetween(p, q);
  if (whole <= SNAP_WELD_M) return 0;
  const steps = Math.ceil((whole - SNAP_WELD_M) / 0.1);
  const at = (k) => {
    const t = ((whole - SNAP_WELD_M) / whole) * (k / steps);
    return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
  };
  const fromOutline = (x, ring) => Math.min(...ring.slice(1).map((b, k) => {
    const a = ring[k];
    const my = 111195, mx = my * Math.cos((x[1] * Math.PI) / 180);
    const vx = (b[0] - a[0]) * mx, vy = (b[1] - a[1]) * my, wx = (x[0] - a[0]) * mx, wy = (x[1] - a[1]) * my;
    const L = vx * vx + vy * vy;
    const t = L ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L)) : 0;
    return Math.hypot(wx - t * vx, wy - t * vy);
  }));
  let most = 0;
  for (const { ring, box } of BUILDINGS) {
    if (box[0] > Math.max(p[0], q[0]) || box[2] < Math.min(p[0], q[0])
      || box[1] > Math.max(p[1], q[1]) || box[3] < Math.min(p[1], q[1])) continue;
    let leaving = pointInRing(p, ring);
    for (let k = 1; k <= steps; k += 1) {
      const x = at(k);
      if (!pointInRing(x, ring)) { leaving = false; continue; }
      if (!leaving) most = Math.max(most, fromOutline(x, ring));
    }
  }
  return most;
}

/** Whether the leg from p to q crosses a drawn path more than SNAP_WELD_M before q. */
const PATHS = load('paths').features.map((f) => f.geometry.coordinates);
function stepsOverPath(p, q) {
  const whole = metresBetween(p, q);
  return PATHS.some(([a, b]) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (den === 0) return false;
    const wx = a[0] - p[0], wy = a[1] - p[1];
    const s = (wx * ey - wy * ex) / den, t = (wx * dy - wy * dx) / den;
    return s >= 0 && s <= 1 && t >= 0 && t <= 1 && (1 - s) * whole > SNAP_WELD_M;
  });
}

const PLACE_POINTS = load('places').features.filter((f) => f.geometry?.type === 'Point');
const placeNamed = (name) => PLACE_POINTS.find((f) => f.properties.name === name).geometry.coordinates;
/** The leg each walk from `from` to every place starts with: [metres, joined]. */
const legsFrom = (from) => PLACE_POINTS.map((f) => graph.route(from, f.geometry.coordinates))
  .filter((r) => r.ok).map((r) => [metresBetween(from, r.snapped.from), r.snapped.from]);

test('no way onto the network goes through a building', () => {
  // The leg from a point to where it joins the network is drawn straight and
  // walked across whatever is there, and a wall is not something to walk
  // across. Every leg, not only the ones from open ground: the nearest join
  // and those beside it used to be taken as found, and a leg to a door was
  // let through the whole building the door is in (see throughBuilding() in
  // server/graph.js). A corner clipped or a wall grazed by up to
  // WALL_CLIP_M is the same leg drawn a hand's width over.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const [west, south, east, north] = [-121.3504, 38.6448, -121.3424, 38.6535];
  // Random points, and every place to the next three on the list.
  const pairs = [];
  for (let n = 0; n < 400; n += 1) {
    pairs.push([[west + rnd() * (east - west), south + rnd() * (north - south)],
      [west + rnd() * (east - west), south + rnd() * (north - south)]]);
  }
  PLACE_POINTS.forEach((f, k) => {
    for (let j = 1; j <= 3; j += 1) pairs.push([f.geometry.coordinates, PLACE_POINTS[(k + j) % PLACE_POINTS.length].geometry.coordinates]);
  });
  let legs = 0;
  for (const [a, b] of pairs) {
    const result = graph.route(a, b);
    if (!result.ok) continue;
    for (const [p, q] of [[a, result.snapped.from], [b, result.snapped.to]]) {
      legs += 1;
      const depth = deepestInside(p, q);
      assert.ok(depth <= WALL_CLIP_M + 0.1, `the leg from ${p} to ${q} goes ${depth.toFixed(1)} m into a building`);
    }
  }
  assert.ok(legs > 1200, `test premise: only ${legs} legs`);
});

test('a way in on a building\'s wall is walked to round the building, not through it', () => {
  // Para Transit's walk to Technical Education began with a 43.7 m line to the
  // Arts and Science door, 21 m of it through Arts and Science; the drink
  // machine west of Administration reached Administration's door by 37.5 m of
  // its 38.5 m leg inside it. The door's own wall is the last SNAP_WELD_M of
  // the leg; the rest of the building is a building.
  const para = graph.route(placeNamed('Para Transit'), placeNamed('Technical Education Division'));
  assert.ok(para.ok);
  assert.notDeepEqual(para.snapped.from, [-121.3478707, 38.6524073], 'leaves by the Arts and Science door');
  assert.ok(deepestInside(placeNamed('Para Transit'), para.snapped.from) <= WALL_CLIP_M + 0.1);
  const machine = [-121.3494853, 38.6510138];
  for (const [metres, joined] of legsFrom(machine)) {
    assert.notDeepEqual(joined, [-121.349925, 38.6509677], 'walks through Administration to its door');
    assert.ok(metres < 10, `a ${metres.toFixed(1)} m leg from the drink machine`);
  }
});

test('the nearest join is not taken through a building either', () => {
  // A bike rack in the lawn between the portables joined the walk on the far
  // side of one, 26.6 m with 14.7 m of it through the portable, in 261 walks:
  // the nearest join was never asked about walls. Behind a building, the way
  // out is round it — here, between two portables — and the walk still goes.
  const rack = [-121.3480034, 38.6489348];
  const legs = legsFrom(rack);
  assert.ok(legs.length > 100, 'the bike rack still walks');
  for (const [, joined] of legs) {
    assert.notDeepEqual(joined, [-121.3482582, 38.6488024], 'joins through the portable');
    assert.ok(deepestInside(rack, joined) <= WALL_CLIP_M + 0.1);
  }
  // And a point behind the Learning Resource Center does not join across it.
  const behind = [-121.34735, 38.64973];
  for (const [, joined] of legsFrom(behind)) assert.ok(deepestInside(behind, joined) <= WALL_CLIP_M + 0.1);
});

test('a leg that steps over a path to another is charged for stepping over it', () => {
  // The emergency telephone on the Gym's north wall walked 47.7 m across the
  // walkway outside and 26 m of lawn to the path beyond, in 104 walks, where
  // the walkway it stepped over was not offered at all. It is now, where the
  // leg crosses it, and the leg past it is charged (CROSSING_CHARGE).
  const phone = [-121.3467086, 38.6482109];
  for (const [metres, joined] of legsFrom(phone)) {
    assert.ok(metres < 22, `a ${metres.toFixed(1)} m leg from the telephone`);
    assert.ok(!stepsOverPath(phone, joined), `steps over a path to ${joined}`);
  }
});

test("a room's ways out across a yard stay beside its own building", () => {
  // The directory gives a building's doors and where its walls come nearest
  // the network, on every footprint it has; a room inside one footprint was
  // offered all of them, and walked 50 m and more across the yard to another
  // footprint's, over the paths on the way. Its own footprint's drawn doors
  // stay; anything else is offered only within OPEN_GROUND_M of the
  // footprint and over no path, and the network walks the rest.
  for (const name of ['Fine and Applied Arts', 'Design Hub', 'MCT HomeBase - CTE, 2nd Floor - Manufacturing, Construction, and Transportation HomeBase']) {
    const room = placeNamed(name);
    for (const [, joined] of legsFrom(room)) assert.ok(!stepsOverPath(room, joined), `${name} steps over a path to ${joined}`);
  }
  // The Counseling Center to a point on the lawn west of it left by where
  // Administration's walls come nearest, 35.9 m over the path between.
  const counseling = placeNamed('Counseling Center');
  const walk = graph.route(counseling, [-121.3498163, 38.6511516]);
  assert.ok(walk.ok);
  assert.ok(!stepsOverPath(counseling, walk.snapped.from), `steps over a path to ${walk.snapped.from}`);
});

test('a dotted leg is charged for its metres beyond the nearest join', () => {
  // A leg is walked across whatever is there, and costed at its straight
  // metres it bought a stride of path with fifty metres of lawn. LEG_CHARGE
  // weighs the metres beyond the nearest a little more than path. The bike
  // rack on the lawn beside the Child Development Center took a 61.3 m
  // leg across the grass in 56 walks. Off the campus the reach stops at the
  // slack beyond the nearest, because OSM draws the footways that serve a
  // stop: Bus 1 and 82 Heading West walked 42 m across the pavement to the
  // street's centreline, with the footway 8.9 m away.
  const rack = [-121.3460627, 38.6503687];
  for (const [metres] of legsFrom(rack)) assert.ok(metres < 30, `a ${metres.toFixed(1)} m leg from the bike rack`);
  const stop = [-121.3510696, 38.650374];
  const footway = graph.snap(stop);
  for (const [metres, joined] of legsFrom(stop)) {
    assert.deepEqual(joined, footway.coord, `the bus stop joins at ${joined}, ${metres.toFixed(1)} m off`);
  }
});

test('a walk does not end by stepping past the corner it turns off at', () => {
  // The way off was the foot of a perpendicular a few metres past the vertex
  // the walk came along to, so the line ran on past the corner and came back
  // to it, a hook of 127 degrees drawn at the end of the walk from Room 560 to
  // CalWORKs, and 40 walks like it. The ends of the edge a point joins are
  // offered too (see candidates()), and the walk stops at the corner.
  const turn = (a, b, c) => {
    const k = Math.cos((b[1] * Math.PI) / 180);
    const u = [(b[0] - a[0]) * k, b[1] - a[1]], v = [(c[0] - b[0]) * k, c[1] - b[1]];
    return (Math.acos((u[0] * v[0] + u[1] * v[1]) / Math.hypot(...u) / Math.hypot(...v)) * 180) / Math.PI;
  };
  const result = graph.route(placeNamed('Art Division - Fine and Applied Arts, Room 560'), placeNamed('CalWORKs'));
  assert.ok(result.ok);
  const line = result.geometry.coordinates;
  assert.ok(turn(line.at(-3), line.at(-2), line.at(-1)) < 120, 'the walk hooks back at its end');
  assert.ok(turn(line[2], line[1], line[0]) < 120, 'the walk hooks back at its start');
});


test('the dotted legs are served beside the walk, and the instructions know where the walk was asked from', () => {
  // distanceFeet is the line; legFeet is the two dotted legs, which the
  // browser adds for the whole walk. And buildManeuvers is told where the
  // walk was asked from and to, so a leg long enough to turn from says so.
  const from = [-121.3460627, 38.6503687];
  const to = load('directory').features.find((f) => f.properties.name === 'Gym').properties.doors[0];
  const result = graph.route(from, to);
  assert.ok(result.ok);
  const feet = (a, b) => Math.round(metresBetween(a, b) * 3.28084);
  assert.ok(Math.abs(result.legFeet.from - feet(from, result.snapped.from)) <= 1, JSON.stringify(result.legFeet));
  // A building's end stands at the door the walk used: no leg.
  assert.equal(result.legFeet.to, 0);
  assert.ok(result.maneuvers[0].turn, 'the depart carries the turn off the dotted leg');
  const plain = graph.route(placeNamed('Kaneko Art Gallery'), placeNamed('Pool'));
  assert.ok(Math.abs(plain.legFeet.from - feet(placeNamed('Kaneko Art Gallery'), plain.snapped.from)) <= 1);
});


test('the path finder is built at the precision this file says', () => {
  // geojson-path-finder 2.x reads `tolerance`; the option was passed as
  // `precision`, its 1.x name, and silently ignored, so the graph was welded
  // at 1e-5 and lost twelve vertices. The constant was tested against the
  // data the whole time; this asks the graph that was actually built.
  assert.equal(graph.vertexCount, graph.vertices.length);
});

test('the vertex precision is tight enough not to weld distinct junctions', () => {
  // The library's default is 1e-5 and the closest pair of distinct campus nodes
  // is 2.9e-6 apart — the default would already weld five real pairs in the
  // drawn network, the sub-metre joints the build leaves where it cuts a path
  // at a wall, and 69 more among the corners and cuts of the plaza crossings,
  // which are campus network to the router too. This is the assertion that
  // makes that number answerable to the data.
  let closest = Infinity;
  const campus = [...new Map([...load('paths').features, ...load('plaza-paths').features]
    .flatMap((f) => f.geometry.coordinates).map((c) => [String(c), c])).values()];
  for (let i = 0; i < campus.length; i++) {
    for (let j = i + 1; j < campus.length; j++) {
      const d = Math.hypot(campus[i][0] - campus[j][0], campus[i][1] - campus[j][1]);
      if (d > 0 && d < closest) closest = d;
    }
  }
  assert.ok(VERTEX_PRECISION < closest / 10,
    `precision ${VERTEX_PRECISION} vs closest distinct pair ${closest.toExponential(3)}`);
});

test('a route from a place to itself is refused rather than answered', () => {
  // FOUND BY A TEST FOR SOMETHING ELSE. A one-coordinate route is what
  // findPath returns when both ends snap to the same vertex, and that is not
  // exotic: two taps inside one courtyard do it, and so does picking a
  // destination while standing on it. The endpoint answered 200 with
  // `coordinates: [[lon, lat]]`, `distanceFeet: 0` and `maneuvers: []`.
  //
  // Nothing downstream survives that. `lineString()` throws outright on a
  // single coordinate, so the browser's handler died mid-assignment and left
  // the panel saying "Calculating…"; `maneuvers.length - 2` would have read
  // "-2 turns"; and the banner's first render indexes `maneuvers[0]`, which is
  // not there. Same shape as the Paris bug above — a 200 to a question that
  // should have been a refusal — and refused the same way.
  const vertex = graph.vertices[0];
  const result = graph.route(vertex, vertex);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'same-place');
  assert.match(result.error, /same place/i);
  // A refusal names the way forward.
  assert.match(result.error, /pick a destination/i);
});

test('two points that snap to the same vertex are the same place', () => {
  // The check is on the SNAPPED ends, not the requested ones — a metre apart
  // in the request is the same vertex in the graph, and it is the graph's
  // answer that the rest of the app has to work with.
  const vertex = graph.vertices[0];
  const almost = [vertex[0] + 0.000002, vertex[1] + 0.000002];

  const snapped = graph.snap(almost);
  assert.deepEqual(snapped.coord, vertex, 'test premise: these snap together');

  assert.equal(graph.route(vertex, almost).reason, 'same-place');
});

test('two taps beside one edge are the same place inside the weld, and a walk outside it', () => {
  // Now that ends land between vertices, "the same vertex" no longer catches
  // two taps a hand's width apart: they join the edge a hand's width apart,
  // and a line that long is drawable and still not a walk. The line is the
  // build's weld distance — closer than that along the network is one node.
  const here = besideLongestEdge(0.5, 3);
  const nudge = (t) => besideLongestEdge(0.5 + t / here.len, 3).at;
  assert.equal(graph.route(here.at, nudge(SNAP_WELD_M / 2)).reason, 'same-place');

  const ten = graph.route(here.at, nudge(10));
  assert.ok(ten.ok, `refused: ${ten.error}`);
  assert.ok(Math.abs(ten.distanceFeet * 0.3048 - 10) < 0.5);
});

test('every route that IS answered has a drawable line', () => {
  // The invariant the browser assumes everywhere and the server never stated:
  // two coordinates minimum, and a maneuver at each end.
  const pairs = [
    [ON_CAMPUS, ALSO_ON_CAMPUS],
    [ALSO_ON_CAMPUS, ON_CAMPUS],
    [graph.vertices[0], graph.vertices.at(-1)],
  ];
  for (const [from, to] of pairs) {
    const result = graph.route(from, to);
    if (!result.ok) continue;
    assert.ok(result.geometry.coordinates.length >= 2,
      `${JSON.stringify(from)} -> ${JSON.stringify(to)} gave one coordinate`);
    assert.ok(result.maneuvers.length >= 2, 'a walk has at least a depart and an arrive');
  }
});

test('a building drawn over a junction does not take the junction away', () => {
  // The walls stage peels back what the sheet draws under a roof, and most of
  // it is a stroke run past the wall for the building to hide. Not all of it.
  // A Health Education portable is drawn over the end of walkway 1287, where it
  // meets walkway 1284 to the south; peeled as a stub, that end took the
  // junction with it, and a walk from the portable's north wall to the path
  // nine metres south became 166 m round the complex. The build now asks every
  // loose end under a roof whether it was drawn to meet a path beyond the far
  // wall before peeling it. Through the real router, so the snap is the app's.
  const NORTH_WALL = [-121.3466934, 38.648467];
  const SOUTH_PATH = [-121.346634, 38.648396];
  const result = graph.route(NORTH_WALL, SOUTH_PATH);
  assert.ok(result.ok, `refused: ${result.error}`);
  const walked = result.distanceFeet * 0.3048;
  const straight = metresBetween(NORTH_WALL, SOUTH_PATH);
  assert.ok(walked < 3 * straight, `${walked.toFixed(0)} m to go ${straight.toFixed(0)} m`);

  // The same failure stranded the 12 m of walkway 1295 that is visible between
  // the Science Success Center and STEM: it met walkway 1296 under the
  // Center's roof, and peeling both ends left it joined to nothing.
  // Measured to the nearest segment, not the nearest vertex, so a splice
  // landing somewhere else along it cannot move the answer.
  const VISIBLE_1295 = [-121.3469614, 38.6526538];
  const off = Math.min(...load('paths').features.map(({ geometry: { coordinates: [a, b] } }) => {
    let best = Infinity;
    for (let k = 0; k <= 50; k += 1) {
      const t = k / 50;
      best = Math.min(best, metresBetween(VISIBLE_1295, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]));
    }
    return best;
  }));
  assert.ok(off < 1, `walkway 1295 is ${off.toFixed(1)} m from the network`);
  assert.ok(graph.route(VISIBLE_1295, SOUTH_PATH).ok, 'walkway 1295 is cut off from the campus');
});

test('a room inside a building goes to the door its approach path led to', () => {
  // The sheet draws a building's approach path a few metres in through its
  // wall, and the walls stage peels it back to the wall. A room inside used to
  // snap onto that stub, so the walk ended where the drawn path goes in. With
  // the stub gone, its nearest vertex can be a path past another face of the
  // building with no way in from it. The Library's defibrillator is the case on
  // today's sheet: nearest vertex 22.5 m off, on the walkway along the Library's
  // far side; the Library's one drawn approach path is 17 m from it under the
  // roof and meets the wall 25 m away. Through the real router, so the snap is
  // the app's.
  const DEFIBRILLATOR = [-121.3476882, 38.6510102];
  const LIBRARY_DOOR = [-121.3479599, 38.6509353];
  const snapped = graph.snap(DEFIBRILLATOR);
  assert.deepEqual(snapped.coord, LIBRARY_DOOR);
  assert.ok(Math.abs(snapped.metres - metresBetween(DEFIBRILLATOR, LIBRARY_DOOR)) < 0.5,
    `snap reports ${snapped.metres.toFixed(1)} m to a door ${metresBetween(DEFIBRILLATOR, LIBRARY_DOOR).toFixed(1)} m away`);

  // Without doors.json the router is what it was: the nearest vertex.
  const bare = createGraph({ network: load('paths'), approach: load('approach-paths') });
  assert.notDeepEqual(bare.snap(DEFIBRILLATOR).coord, LIBRARY_DOOR, 'test premise: the door is not the nearest vertex');
});

test('a point on the network inside a building is never moved to a door', () => {
  // The door rule only stands in for a stub that is no longer there. Where the
  // network itself runs under a roof — a passage the walls stage kept — a point
  // on it is already on the graph, and every vertex snaps to itself.
  const doors = load('doors').features;
  const inside = graph.vertices.filter((v) => doors.some((f) => pointInRing(v, f.geometry.coordinates[0])));
  assert.ok(inside.length > 0, 'test premise: some vertex lies inside a footprint with a door');
  for (const v of graph.vertices.filter((_, k) => k % 7 === 0).concat(inside)) {
    assert.deepEqual(graph.snap(v).coord, v);
  }
});

test('a room leaves by a door on another footprint of its own building', () => {
  // CTE is drawn as two footprints that abut. The MCT HomeBase is in one, and
  // CTE's north door is on the other, 42 m away. The leg between them never
  // leaves the building, but it was counted as out of doors (it was outside
  // the room's own footprint) and the other footprint was held against it as
  // a wall: the walk to the bike rack north of CTE went round, 97.5 m.
  const MCT_HOMEBASE = [-121.3456785, 38.6515565];
  const BIKE_RACK = [-121.3459545, 38.6519019];
  const walk = graph.route(MCT_HOMEBASE, BIKE_RACK);
  assert.ok(walk.ok, `refused: ${walk.error}`);
  const metres = (walk.distanceFeet + walk.legFeet.from + walk.legFeet.to) * 0.3048;
  assert.ok(metres < 60, `${metres.toFixed(1)} m from the MCT HomeBase to the bike rack outside CTE's north door`);
});
