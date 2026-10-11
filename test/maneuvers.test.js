// src/maneuvers.js — the turn-by-turn logic, shared verbatim by the browser and
// by server/index.js so the two can never disagree about what counts as a turn.
// Pure functions over coordinates, which makes them the one part of the routing
// stack that can be tested without a graph, a map or a network.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDelta, classify, buildManeuvers, cumulativeDistances,
  instructionFor, niceFeet, FEET_PER_KM,
} from '../src/maneuvers.js';

// A small patch of campus. At this latitude 0.001 degrees of longitude is about
// 87 m east and 0.001 of latitude about 111 m north.
const O = [-121.3490, 38.6510];
const north = (n) => [O[0], O[1] + 0.001 * n];
const east = (n) => [O[0] + 0.001 * n, O[1]];

test('bearingDelta signs turns the way a walker experiences them', () => {
  // Walking north, then turning to head east, is a right turn.
  assert.ok(bearingDelta(north(-1), O, east(1)) > 0);
  assert.ok(bearingDelta(north(-1), O, east(-1)) < 0);
  assert.ok(Math.abs(bearingDelta(north(-1), O, north(1))) < 1);
});

test('classify splits turns at 20 and 60 degrees, and calls back a U-turn', () => {
  assert.equal(classify(0), 'straight');
  assert.equal(classify(19.9), 'straight');
  assert.equal(classify(45), 'slight-right');
  assert.equal(classify(-45), 'slight-left');
  assert.equal(classify(90), 'right');
  assert.equal(classify(-90), 'left');
  assert.equal(classify(179), 'uturn');
  assert.equal(classify(-179), 'uturn');
});

// This is the behaviour the whole module exists for: my campus's paths are drawn as
// many short collinear segments, and without swallowing them the banner would
// announce "continue straight" every few metres.
test('collinear vertices do not become maneuvers', () => {
  const straightRun = [north(0), north(1), north(2), north(3), north(4)];
  const maneuvers = buildManeuvers(straightRun);
  assert.deepEqual(maneuvers.map((m) => m.type), ['depart', 'arrive']);
});

test('a real turn becomes exactly one maneuver', () => {
  const dogleg = [north(-2), north(-1), O, east(1), east(2)];
  const types = buildManeuvers(dogleg).map((m) => m.type);
  assert.deepEqual(types, ['depart', 'right', 'arrive']);
});

test('distanceFeet is the distance travelled to reach the maneuver', () => {
  const dogleg = [north(-2), north(-1), O, east(1)];
  const [, turn, arrive] = buildManeuvers(dogleg);
  // Two 0.001-degree hops north, ~111 m each, before the turn.
  assert.ok(Math.abs(turn.distanceFeet - 2 * 0.111 * FEET_PER_KM) < 12, `${turn.distanceFeet} ft`);
  // Then one hop east to the end.
  assert.ok(Math.abs(arrive.distanceFeet - 0.087 * FEET_PER_KM) < 12, `${arrive.distanceFeet} ft`);
});

test('degenerate routes do not throw', () => {
  assert.deepEqual(buildManeuvers([]), []);
  assert.deepEqual(buildManeuvers([O]), []);
  assert.deepEqual(buildManeuvers([O, north(1)]).map((m) => m.type), ['depart', 'arrive']);
});

test('cumulativeDistances is monotonic and starts at zero', () => {
  const cumulative = cumulativeDistances([north(0), north(1), north(2), east(1)]);
  assert.equal(cumulative[0], 0);
  assert.equal(cumulative.length, 4);
  for (let n = 1; n < cumulative.length; n++) assert.ok(cumulative[n] > cumulative[n - 1]);
});

test('every maneuver type has a phrase, and there are no street names in them', () => {
  const types = ['depart', 'straight', 'slight-left', 'slight-right', 'left', 'right', 'uturn', 'arrive'];
  for (const type of types) {
    const phrase = instructionFor(type);
    assert.ok(phrase && phrase !== 'Continue', `${type} falls through to the default phrase`);
    assert.ok(!/\b(street|avenue|road|drive|lane)\b/i.test(phrase), `${type} names a road`);
  }
  assert.equal(instructionFor('nonsense'), 'Continue');
});

test('niceFeet rounds to increments a person can act on', () => {
  assert.equal(niceFeet(0), '0 ft');
  assert.equal(niceFeet(12), '10 ft');
  assert.equal(niceFeet(48), '50 ft');
  assert.equal(niceFeet(123), '120 ft');
  assert.equal(niceFeet(487), '490 ft');
  assert.equal(niceFeet(512), '500 ft');
  assert.equal(niceFeet(5280), '1.0 mi');
  // Never a negative distance, however the caller arrived at one.
  assert.equal(niceFeet(-3), '0 ft');
});

// --- Bends a few feet apart -------------------------------------------------
//
// Snapped edges and door spurs leave the network with bends a stride apart,
// and each used to be its own maneuver: a sideways jog said "Bear right", then
// "Bear left" eight feet later, on about one route in eleven.

/** `feet` from `from` on compass heading `heading`. Flat-earth, which at this scale is exact enough. */
function go(from, heading, feet) {
  const rad = (heading * Math.PI) / 180;
  const degLat = feet / FEET_PER_KM / 111.2;
  const degLng = degLat / Math.cos((from[1] * Math.PI) / 180);
  return [from[0] + Math.sin(rad) * degLng, from[1] + Math.cos(rad) * degLat];
}

/** A walk that follows `legs` — [heading, feet] pairs — from O. */
function walkOf(legs) {
  const coords = [O];
  for (const [heading, feet] of legs) coords.push(go(coords.at(-1), heading, feet));
  return coords;
}

test('a sideways jog inside the path is no turn at all', () => {
  // North, a 30-degree step to the right for 8 ft, north again.
  const maneuvers = buildManeuvers(walkOf([[0, 300], [30, 8], [0, 300]]));
  assert.deepEqual(maneuvers.map((m) => m.type), ['depart', 'arrive']);
  assert.ok(Math.abs(maneuvers.at(-1).distanceFeet - 608) <= 1, `${maneuvers.at(-1).distanceFeet} ft`);
});

test('two half-turns a stride apart are the one turn they add up to', () => {
  const maneuvers = buildManeuvers(walkOf([[0, 300], [45, 8], [90, 300]]));
  assert.deepEqual(maneuvers.map((m) => m.type), ['depart', 'right', 'arrive']);
  const [, turn, arrive] = maneuvers;
  // At the first bend, and the feet folded into it go on the leg after.
  assert.equal(turn.index, 1);
  assert.ok(Math.abs(turn.distanceFeet - 300) <= 1, `${turn.distanceFeet} ft`);
  assert.ok(Math.abs(arrive.distanceFeet - 308) <= 1, `${arrive.distanceFeet} ft`);
});

test('turns a real distance apart are still two turns', () => {
  const types = buildManeuvers(walkOf([[0, 300], [90, 50], [0, 300]])).map((m) => m.type);
  assert.deepEqual(types, ['depart', 'right', 'left', 'arrive']);
});

test('a dogleg wider than the path keeps both its turns, however short', () => {
  // Left off the path, 18 ft, right into a door: the walker has to leave the
  // line they are on, and folding the pair would walk them straight past.
  const types = buildManeuvers(walkOf([[0, 300], [270, 18], [0, 10]])).map((m) => m.type);
  assert.deepEqual(types, ['depart', 'left', 'right', 'arrive']);
});

test('a bend more than a stride on is not folded into the one before', () => {
  // The second bend is past JOG_FEET, so each is its own maneuver even though
  // the two cancel.
  const types = buildManeuvers(walkOf([[0, 300], [30, 25], [0, 300]])).map((m) => m.type);
  assert.deepEqual(types, ['depart', 'slight-right', 'slight-left', 'arrive']);
});
