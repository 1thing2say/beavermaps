// src/route-state.js — the four variables that were always a set.
//
// `routeCoords`, `routeLine`, `cumulative` and `maneuvers` lived in startApp()
// as four independent `let`s, written together in placeEnd and nulled together
// in resetMap. Nothing enforced that pairing, and every reader picked its own
// one to test against: routeFeature asked `!routeCoords`, onUserMoved asked
// `!routeLine`, legsFeature asked `routeCoords.length < 2`, startNavigation
// asked both. Four questions, one fact.
//
// These tests hold the fact: there is one way in, one way out, and no sequence
// of calls produces a route that is half there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoute, LEG_MIN_FEET } from '../src/route-state.js';
import { FEET_PER_KM } from '../src/maneuvers.js';
import { metresBetween } from './helpers.js';

/** A short walk across the middle of campus. */
const WALK = {
  geometry: {
    type: 'LineString',
    coordinates: [
      [-121.3465, 38.6486],
      [-121.3460, 38.6486],
      [-121.3460, 38.6492],
      [-121.3452, 38.6492],
    ],
  },
  maneuvers: [
    { index: 0, type: 'depart' },
    { index: 1, type: 'right' },
    { index: 2, type: 'left' },
    { index: 3, type: 'arrive' },
  ],
};

const ACCESSORS = ['coords', 'line', 'cumulative', 'maneuvers'];

test('a fresh route is empty, and says so through every accessor', () => {
  const route = createRoute();
  assert.equal(route.isSet, false);
  assert.equal(route.isWalkable, false);
  for (const key of ACCESSORS) assert.equal(route[key], null, key);
  assert.equal(route.totalKm, 0);
});

test('set() derives the line and the distances from the coordinates', () => {
  const route = createRoute();
  route.set(WALK);

  assert.equal(route.isSet, true);
  assert.equal(route.isWalkable, true);
  assert.deepEqual(route.coords, WALK.geometry.coordinates);
  assert.equal(route.line.geometry.type, 'LineString');
  // One cumulative distance per vertex, starting at zero and never going back.
  assert.equal(route.cumulative.length, route.coords.length);
  assert.equal(route.cumulative[0], 0);
  for (let i = 1; i < route.cumulative.length; i++) {
    assert.ok(route.cumulative[i] > route.cumulative[i - 1], `vertex ${i} went backwards`);
  }
});

test('totalKm is the last cumulative distance, and is a plausible campus walk', () => {
  const route = createRoute();
  route.set(WALK);
  assert.equal(route.totalKm, route.cumulative[route.cumulative.length - 1]);
  // Three legs of a few dozen metres each. If this ever reads in the hundreds
  // of km the units have been confused somewhere, which is the failure mode
  // that put a 7,520 ft walk on a Paris request.
  assert.ok(route.totalKm > 0.05 && route.totalKm < 1, `${route.totalKm} km`);
});

test('maneuverKm maps a step to its distance along the walk', () => {
  const route = createRoute();
  route.set(WALK);
  // The first maneuver is at the start and the last is at the end; the two in
  // between are in order. This is what the camera aims with and what the
  // countdown subtracts from, so an off-by-one here is a banner that counts
  // down to the wrong corner.
  assert.equal(route.maneuverKm(0), 0);
  assert.equal(route.maneuverKm(3), route.totalKm);
  assert.ok(route.maneuverKm(1) < route.maneuverKm(2));
});

test('clear() empties all four together — there is no half-set route', () => {
  const route = createRoute();
  route.set(WALK);
  route.clear();

  assert.equal(route.isSet, false);
  assert.equal(route.isWalkable, false);
  for (const key of ACCESSORS) assert.equal(route[key], null, `${key} survived clear()`);
  assert.equal(route.totalKm, 0);
});

test('a one-coordinate route is set but not walkable', () => {
  // startNavigation used to ask `routeCoords.length < 2` itself. It is the
  // route's question, and a degenerate answer from the server should not
  // produce a walk with no direction to face.
  const route = createRoute();
  route.set({
    geometry: { type: 'LineString', coordinates: [[-121.3465, 38.6486]] },
    maneuvers: [{ index: 0, type: 'arrive' }],
  });
  assert.equal(route.isSet, true);
  assert.equal(route.isWalkable, false);
});

test('feature() is a bare Feature, which is what the source was built for', () => {
  const route = createRoute();
  assert.equal(route.feature().type, 'FeatureCollection');
  assert.deepEqual(route.feature().features, []);

  route.set(WALK);
  const drawn = route.feature();
  assert.equal(drawn.type, 'Feature');
  assert.equal(drawn.geometry.type, 'LineString');
  assert.deepEqual(drawn.geometry.coordinates, WALK.geometry.coordinates);
});

test('legs() draws the walk from the path to the door', () => {
  const route = createRoute();
  route.set(WALK);

  // Both pins a good way off the ends of the path — a pictogram inside a
  // building, which is where half of them are.
  const from = [-121.3467, 38.6484];
  const to = [-121.3450, 38.6494];
  const legs = route.legs(from, to);

  assert.equal(legs.features.length, 2);
  assert.deepEqual(legs.features[0].geometry.coordinates, [from, WALK.geometry.coordinates[0]]);
  assert.deepEqual(legs.features[1].geometry.coordinates, [WALK.geometry.coordinates[3], to]);
});

test('a leg shorter than LEG_MIN_FEET is a nub and is left undrawn', () => {
  const route = createRoute();
  route.set(WALK);

  const [lon, lat] = WALK.geometry.coordinates[0];
  const nub = [lon, lat + 0.000005];          // about half a metre
  assert.ok(metresBetween([lon, lat], nub) * (FEET_PER_KM / 1000) < LEG_MIN_FEET);

  assert.equal(route.legs(nub, null).features.length, 0);
});

test('legs() skips an end that has no pin rather than drawing to nowhere', () => {
  // resetMap clears the pins before the route, and a style rebuild in between
  // repaints the legs. Reading `undefined.geometry` there is the null crash
  // this arrangement is meant to make unreachable.
  const route = createRoute();
  route.set(WALK);

  assert.equal(route.legs(null, [-121.3450, 38.6494]).features.length, 1);
  assert.equal(route.legs([-121.3467, 38.6484], undefined).features.length, 1);
  assert.equal(route.legs(null, null).features.length, 0);
});

test('legs() on an empty route is an empty collection, not a throw', () => {
  const route = createRoute();
  const legs = route.legs([-121.3467, 38.6484], [-121.3450, 38.6494]);
  assert.equal(legs.type, 'FeatureCollection');
  assert.deepEqual(legs.features, []);
});

test('each call returns its own empty collection', () => {
  // The old code handed the same shared `EMPTY` object to every source that had
  // nothing to draw. Nothing mutates it today, which is the only reason that
  // was safe.
  const route = createRoute();
  assert.notEqual(route.feature(), route.feature());
  assert.notEqual(route.legs(null, null), route.legs(null, null));
});
