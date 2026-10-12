// src/maneuvers.js — the turn-by-turn logic, shared verbatim by the browser and
// by server/index.js so the two can never disagree about what counts as a turn.
// Pure functions over coordinates, which makes them the one part of the routing
// stack that can be tested without a graph, a map or a network.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDelta, classify, buildManeuvers, cumulativeDistances,
  instructionFor, thenPhrase, niceFeet, countdownFeet, FEET_PER_KM, LEG_TURN_M,
} from '../src/maneuvers.js';
import { SNAP_WELD_M } from '../server/graph.js';

// A small patch of campus. At this latitude 0.001 degrees of longitude is about
// 87 m east and 0.001 of latitude about 111 m north.
const O = [-121.3490, 38.6510];
const north = (n) => [O[0], O[1] + 0.001 * n];
const east = (n) => [O[0] + 0.001 * n, O[1]];
// And in metres, for the shapes the sheet actually draws, which are a few
// metres across rather than a hundred.
const at = (e, n) => [O[0] + e / 86940, O[1] + n / 110980];
const types = (maneuvers) => maneuvers.map((m) => m.type);

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
  // Never "0 ft": 32 steps of the old sweep read "in 0 ft", which is a sign
  // telling you that you have already missed the corner.
  assert.equal(niceFeet(0), '5 ft');
  assert.equal(niceFeet(2), '5 ft');
  assert.equal(niceFeet(12), '10 ft');
  assert.equal(niceFeet(48), '50 ft');
  assert.equal(niceFeet(123), '120 ft');
  assert.equal(niceFeet(487), '490 ft');
  assert.equal(niceFeet(512), '500 ft');
  assert.equal(niceFeet(5280), '1.0 mi');
  // Never a negative distance, however the caller arrived at one.
  assert.equal(niceFeet(-3), '5 ft');
});

test('the countdown says "now" at the corner, never "0 ft"', () => {
  assert.equal(countdownFeet(0), 'now');
  assert.equal(countdownFeet(-4), 'now');
  assert.equal(countdownFeet(2.4), 'now');
  assert.equal(countdownFeet(3), '5 ft');
  assert.equal(countdownFeet(120), niceFeet(120));
});

// ---------------------------------------------------------------------------
// The drawing is not the walk. Every shape below is one the sheet draws and the
// old per-vertex pass turned into instructions; see buildManeuvers.
// ---------------------------------------------------------------------------

test('a dog-leg kink at a crossing is not two turns', () => {
  // The kink west of Administration: 2.7 m sideways where a stroke was cut and
  // anchored. It used to read "bear left", then nine feet later "bear right".
  const kink = [at(0, -60), at(0, 0), at(-2.5, 1), at(-2.5, 60)];
  assert.deepEqual(types(buildManeuvers(kink)), ['depart', 'arrive']);
});

test('a corner drawn as several bends is one turn', () => {
  const corner = [at(0, -60), at(0, 0), at(1, 2), at(3, 3.5), at(5, 4), at(60, 4)];
  assert.deepEqual(types(buildManeuvers(corner)), ['depart', 'right', 'arrive']);
});

test('a hairpin is a right, not a U-turn', () => {
  // Two right angles five metres apart. Only a vertex that itself doubles back
  // makes "make a U-turn", which otherwise reads as "you are going the wrong way".
  const hairpin = [at(0, -60), at(0, 0), at(5, 0), at(5, -60)];
  assert.deepEqual(types(buildManeuvers(hairpin)), ['depart', 'right', 'arrive']);
  const doubleBack = [at(0, -60), at(0, 0), at(1, -60)];
  assert.deepEqual(types(buildManeuvers(doubleBack)), ['depart', 'uturn', 'arrive']);
});

test('a jog round something is two turns, not a straight', () => {
  // Right, eight metres along, left: merged, it nets to nothing.
  const jog = [at(0, -60), at(0, 0), at(8, 0), at(8, 60)];
  assert.deepEqual(types(buildManeuvers(jog)), ['depart', 'right', 'left', 'arrive']);
});

/** A curve of `steps` bends of `each` degrees, two metres apart, then a long run out. */
function curve(steps, each) {
  const coords = [at(0, -60), at(0, 0)];
  let [e, n, h] = [0, 0, 0];
  for (let k = 0; k < steps; k++) {
    h += each;
    e += 2 * Math.sin((h * Math.PI) / 180);
    n += 2 * Math.cos((h * Math.PI) / 180);
    coords.push(at(e, n));
  }
  coords.push(at(e + 60 * Math.sin((h * Math.PI) / 180), n + 60 * Math.cos((h * Math.PI) / 180)));
  return coords;
}

test('a gentle curve with no choice on it stays silent, and is said at a junction on it', () => {
  // Ninety degrees over 36 m, five at a time: no vertex is a bend.
  const bend = curve(18, 5);
  const plain = { degreeAt: () => 2 };
  assert.deepEqual(types(buildManeuvers(bend, plain)), ['depart', 'arrive']);

  const junction = { degreeAt: (c, i) => (i === 10 ? 3 : 2) };
  const said = buildManeuvers(bend, junction);
  assert.deepEqual(types(said), ['depart', 'slight-right', 'arrive']);
  assert.equal(said[1].index, 10, 'said somewhere other than the junction');
});

test('a bear with no choice is dropped only when the caller can say there is none', () => {
  const bear = [at(0, -60), at(0, 0), at(60 * Math.sin(0.7), 60 * Math.cos(0.7))];
  assert.deepEqual(types(buildManeuvers(bear)), ['depart', 'slight-right', 'arrive']);
  assert.deepEqual(types(buildManeuvers(bear, { degreeAt: () => 2 })), ['depart', 'arrive']);
  assert.deepEqual(
    types(buildManeuvers(bear, { degreeAt: (c, i) => (i === 1 ? 3 : 2) })),
    ['depart', 'slight-right', 'arrive'],
  );
});

test('a corner past a junction is said at the corner, not at the junction', () => {
  // Through a junction, a bend 4 m on, and the corner 8 m on. Said at the
  // junction, "turn right" points down whatever branch leaves it.
  const coords = [at(60, 0), at(0, 0), at(-4, 1), at(-8, 1), at(-8, 60)];
  const opts = { degreeAt: (c, i) => (i === 1 ? 3 : 2) };
  const turns = buildManeuvers(coords, opts).slice(1, -1);
  assert.deepEqual(types(turns), ['right']);
  assert.equal(turns[0].index, 3);
});

test('a dog-leg at a junction is said at the junction', () => {
  const coords = [at(0, -60), at(0, 0), at(2, 1.5), at(60, 1.5)];
  const opts = { degreeAt: (c, i) => (i === 1 ? 4 : 2) };
  const turns = buildManeuvers(coords, opts).slice(1, -1);
  assert.deepEqual(types(turns), ['right']);
  assert.equal(turns[0].index, 1);
});

test('going straight at a fork says which way to keep', () => {
  // Straight on, and another drawn branch 17 degrees to the right of it. The
  // walk's own bearing barely changes, so there used to be no instruction.
  const coords = [at(0, -60), at(0, 0), at(-3, 60)];
  const fork = {
    degreeAt: (c, i) => (i === 1 ? 3 : 2),
    branchesAt: (c, i) => (i === 1 ? [at(0, -60), at(-3, 60), at(15, 60)] : []),
  };
  const [, keep] = buildManeuvers(coords, fork);
  assert.equal(keep.type, 'slight-left');
  assert.equal(keep.fork, true);
  assert.equal(instructionFor(keep.type, keep), 'Keep left');

  // A branch off at a right angle is a junction, not a fork.
  const tee = { ...fork, branchesAt: (c, i) => (i === 1 ? [at(0, -60), at(-3, 60), at(60, 0)] : []) };
  assert.deepEqual(types(buildManeuvers(coords, tee)), ['depart', 'arrive']);
});

test('the dotted legs give depart a turn and arrive a side', () => {
  // From the west to a path running north, and to a destination east of its end.
  const coords = [at(0, 0), at(0, 60)];
  const ends = buildManeuvers(coords, { from: at(-20, 0), to: at(10, 60) });
  assert.equal(ends[0].turn, 'left');
  assert.equal(instructionFor('depart', ends[0]), 'Walk to the path, then turn left');
  assert.equal(ends.at(-1).side, 'right');
  assert.equal(instructionFor('arrive', ends.at(-1)), 'Destination on your right');

  // A leg shorter than the weld is no leg at all.
  const welded = buildManeuvers(coords, { from: at(-1, 0), to: at(1, 60) });
  assert.equal(welded[0].turn, undefined);
  assert.equal(welded.at(-1).side, undefined);
  assert.equal(instructionFor('depart', welded[0]), 'Start walking');
});

test('LEG_TURN_M is the router\'s weld', () => {
  assert.equal(LEG_TURN_M, SNAP_WELD_M);
});

test('without options the output is what the line alone says', () => {
  const coords = [at(0, -60), at(0, 0), at(1, 2), at(3, 3.5), at(5, 4), at(60, 4), at(60, 70)];
  assert.deepEqual(buildManeuvers(coords, {}), buildManeuvers(coords));
});

test('every step\'s distance adds up to the walk', () => {
  const coords = curve(18, 5).concat([at(40, 120), at(45, 140)]);
  const maneuvers = buildManeuvers(coords, { degreeAt: (c, i) => (i === 10 ? 3 : 2) });
  const total = cumulativeDistances(coords).at(-1) * FEET_PER_KM;
  const sum = maneuvers.reduce((s, m) => s + m.distanceFeet, 0);
  assert.ok(Math.abs(sum - total) <= 1, `${sum} ft against ${total} ft`);
});

test('two corners close together read as one sentence', () => {
  assert.equal(thenPhrase({ type: 'right' }), 'then turn right');
  assert.equal(thenPhrase({ type: 'slight-left', fork: true }), 'then keep left');
  assert.equal(thenPhrase({ type: 'arrive', side: 'left' }), 'then arrive on your left');
  assert.equal(thenPhrase({ type: 'arrive' }), 'then arrive');
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

test('a jog that steps off the width of the path is two turns', () => {
  // The second bend leaves the walk 12.5 ft to the side, past JOG_WIDTH_M, so
  // each is its own maneuver even though the two cancel.
  const types = buildManeuvers(walkOf([[0, 300], [30, 25], [0, 300]])).map((m) => m.type);
  assert.deepEqual(types, ['depart', 'slight-right', 'slight-left', 'arrive']);
});
