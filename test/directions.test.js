// The route summary's arithmetic, and the one constant it refuses on.
//
// Worth testing for a reason the rest of the routing is not: everything here is
// a claim about the physical world — how fast a person walks, what time they
// arrive, how far away is too far — and every one of them is printed on the card
// as a fact. A wrong turn is visible on the map. "12 min" is not checkable by
// anybody reading it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, metresBetween } from './helpers.js';
import {
  WALK_M_PER_S, REACH_M,
  walkSeconds, walkLabel, arrivalLabel, routeSummary,
  reachProblem, locationProblem,
} from '../src/directions.js';
import { FEET_PER_KM } from '../src/maneuvers.js';

test('a walk takes as long as walking it', () => {
  // One kilometre at the stated speed, from the other end: if the constant and
  // the conversion disagree this is where it shows.
  const km = FEET_PER_KM;
  const seconds = walkSeconds(km);
  assert.ok(Math.abs(seconds - 1000 / WALK_M_PER_S) < 0.5,
    `1 km came out as ${seconds.toFixed(1)} s, not ${(1000 / WALK_M_PER_S).toFixed(1)}`);

  // And it is linear, which is the property the summary relies on when it
  // derives three numbers from one distance.
  assert.ok(Math.abs(walkSeconds(2 * km) - 2 * seconds) < 0.5);
});

test('a duration is said the way a person says it', () => {
  // Never zero. A card announcing a walk you have already finished is worse
  // than one rounding a few seconds up.
  assert.equal(walkLabel(0), '1 min');
  assert.equal(walkLabel(1), '1 min');
  assert.equal(walkLabel(60), '1 min');
  // Rounded UP, so the time on the card is never optimistic.
  assert.equal(walkLabel(61), '2 min');
  assert.equal(walkLabel(59 * 60), '59 min');
  // The hour boundary, where "60 min" would be right and nobody says it.
  assert.equal(walkLabel(60 * 60), '1 hr');
  assert.equal(walkLabel(61 * 60), '1 hr 1 min');
  assert.equal(walkLabel(71 * 60), '1 hr 11 min');
  // Exactly on the hour drops the minutes rather than printing "2 hr 0 min".
  assert.equal(walkLabel(120 * 60), '2 hr');
});

test('the arrival time is now plus the walk, on the reader own clock', () => {
  const now = new Date('2026-08-17T20:08:00');
  // Local time on purpose — this is the one place in the app where a wall clock
  // is the right unit, because it is compared against the clock on the phone
  // holding it. src/daylight.js refuses timezones for the opposite reason.
  const expected = new Date(now.getTime() + 71 * 60 * 1000)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(arrivalLabel(now, 71 * 60), expected);

  // It moves with the duration rather than being a formatted "now".
  assert.notEqual(arrivalLabel(now, 0), arrivalLabel(now, 71 * 60));
});

test('the three numbers on the card describe the same walk', () => {
  const now = new Date('2026-08-17T20:00:00');
  const feet = 2400;
  const { time, arrival, distance, seconds } = routeSummary(feet, now);

  assert.equal(time, walkLabel(seconds));
  assert.equal(arrival, arrivalLabel(now, seconds));
  assert.match(distance, /\d/);

  // The arrival really is the walk away, to the minute the label rounds to.
  const arrivedAt = new Date(now.getTime() + seconds * 1000);
  assert.equal(arrival, arrivedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));

  // A longer walk is a later arrival. Cheap, and it is the one way round the
  // sign of the addition can be wrong.
  const far = routeSummary(feet * 4, now);
  assert.ok(far.seconds > seconds);
});

test('the reach limit clears the routing graph it is meant to cover', () => {
  // THE CONSTANT IS ANSWERABLE TO THE DATA. REACH_M exists to separate "you are
  // somewhere this graph covers" from "you are two suburbs away", and the only
  // way it can be wrong is by being tighter than the graph's own sparsest
  // corner — which would refuse a real visitor standing on a real path.
  //
  // So the graph is sampled rather than trusted: a grid over its bounding box,
  // and the worst distance from any of those points to the nearest vertex. If
  // regenerating paths.json ever thins the network out past this, this fails
  // instead of the app quietly refusing to route somebody.
  const vertices = [];
  const seen = new Set();
  for (const name of ['paths', 'approach-paths']) {
    for (const feature of load(name).features) {
      for (const coord of feature.geometry.coordinates) {
        const key = `${coord[0]},${coord[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        vertices.push(coord);
      }
    }
  }
  assert.ok(vertices.length > 1000, `only ${vertices.length} vertices — did a network fail to load?`);

  const xs = vertices.map((v) => v[0]);
  const ys = vertices.map((v) => v[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

  const nearest = (p) => {
    let best = Infinity;
    for (const v of vertices) best = Math.min(best, metresBetween(p, v));
    return best;
  };

  let worst = 0;
  let worstAt = null;
  const N = 40;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const p = [
        box[0] + (box[2] - box[0]) * ((i + 0.5) / N),
        box[1] + (box[3] - box[1]) * ((j + 0.5) / N),
      ];
      const d = nearest(p);
      if (d > worst) { worst = d; worstAt = p; }
    }
  }

  assert.ok(worst < REACH_M,
    `standing at ${worstAt} inside the routed area is ${worst.toFixed(0)} m from the `
    + `nearest vertex, which REACH_M (${REACH_M} m) would refuse to route from`);
  // ...and not so loose that it has stopped saying anything. A limit twice the
  // width of the graph would accept the whole county.
  assert.ok(REACH_M < 1000, `REACH_M is ${REACH_M} m, which no longer excludes anywhere`);
});

test('every building on this campus can be walked to from its own doorstep', () => {
  // The other side of the same constant. Every card's Directions button routes
  // to a directory entrance, and a route the router snaps somewhere else is the
  // failure this catches — an entrance that is not on the graph is a building
  // whose one useful button lies about where it is sending you.
  const directory = load('directory');
  const vertices = [];
  for (const name of ['paths', 'approach-paths']) {
    for (const feature of load(name).features) vertices.push(...feature.geometry.coordinates);
  }

  const strays = [];
  for (const feature of directory.features) {
    const at = feature.properties?.entrance;
    if (!at) continue;
    let best = Infinity;
    for (const v of vertices) best = Math.min(best, metresBetween(at, v));
    if (reachProblem(best)) strays.push(`${feature.properties.name} (${best.toFixed(0)} m)`);
  }
  assert.equal(strays.length, 0, `entrances off the routing graph: ${strays.join(', ')}`);
});

test('a fix that is nowhere near campus is refused rather than snapped', () => {
  assert.equal(reachProblem(0), null);
  assert.equal(reachProblem(REACH_M), null);
  assert.ok(reachProblem(REACH_M + 1));

  // Downtown Sacramento, which is the actual failure this guards: the router
  // snaps a start to the NEAREST vertex with no notion of "too far", so without
  // this the app would draw a confident walking route from the edge of the
  // approach network and call it yours.
  const away = metresBetween([-121.4934, 38.5816], [-121.347025, 38.649511]);
  const said = reachProblem(away);
  assert.ok(said, `${(away / 1000).toFixed(1)} km away was accepted as walkable`);
  assert.match(said, /\d/, 'the refusal does not say how far away you are');

  // Every refusal names a way forward. A dead end that only says "no" is the
  // one thing this app must not do to somebody standing outside with a phone.
  assert.match(said, /press and hold/i);
});

test('every way the browser can refuse a location gets its own sentence', () => {
  // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT, and whatever else
  // arrives. Distinct, because "something went wrong" three times over is the
  // version of this that sends somebody to the settings app for a timeout.
  const said = [1, 2, 3, undefined].map((code) => locationProblem({ code }));
  for (const sentence of said) {
    assert.ok(sentence && sentence.length > 20, `a refusal came back as "${sentence}"`);
    assert.match(sentence, /press and hold/i, `"${sentence}" offers nothing to do next`);
  }
  // Denial is the one that is actionable in the browser rather than on the map,
  // and it has to say so or people retry the button forever.
  assert.match(said[0], /allow|turned off|settings/i);
  assert.notEqual(said[0], said[1]);
  assert.notEqual(said[1], said[2]);
  assert.equal(locationProblem(null), said[3], 'no error at all should not throw');
});
