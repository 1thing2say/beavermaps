// src/navigation.js — a route set again while a walk is running on it.
//
// Navigation reads the route holder live rather than copying it at start, so
// a re-route that lands mid-walk swaps every list under the walk except its
// own step counter. Walked to the seventh of nine maneuvers and handed a route
// with four, the next fix read maneuver seven of four and threw — inside the
// locate control's listener, so it threw again on every fix after and the sign
// froze for the rest of the walk.
//
// endpoints.js now ends the walk before it swaps the route; these hold the
// backstop that ends it here for anything that does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigation } from '../src/navigation.js';
import { createRoute } from '../src/route-state.js';
import { buildManeuvers } from '../src/maneuvers.js';
import { element, withDocument } from './fake-dom.js';

/** A zig-zag of `corners` right-angle turns, each about 120 ft from the last. */
function zigzag(corners) {
  const coordinates = [[-121.3465, 38.6486]];
  for (let i = 0; i <= corners; i++) {
    const [lng, lat] = coordinates.at(-1);
    coordinates.push(i % 2 === 0 ? [lng + 0.0004, lat] : [lng, lat + 0.0003]);
  }
  return { geometry: { type: 'LineString', coordinates }, maneuvers: buildManeuvers(coordinates) };
}

const LONG = zigzag(7);   // depart, seven turns, arrive: nine maneuvers
const SHORT = zigzag(2);  // four

function signTemplate() {
  const sign = element('nav-sign');
  for (const part of ['nav-arrow', 'nav-distance', 'nav-instruction', 'nav-exit']) {
    sign.appendChild(element(part));
  }
  return { content: { firstElementChild: sign } };
}

function harness(route) {
  const log = [];
  const dot = { setLngLat() { return dot; }, addTo() { return dot; }, remove() {} };
  const nav = createNavigation({
    map: { easeTo() {}, resize() {} },
    route,
    geolocation: { fixture: null, useFixture() {} },
    dom: {
      sidePanel: element(),
      banner: element('hidden'),
      footer: element('hidden'),
      stack: element(),
      signTemplate: signTemplate(),
      remaining: element(),
      eta: element(),
    },
    buildings: { add() {}, remove() {} },
    onStart() {},
    restCamera: () => log.push('restCamera'),
    releaseCameraLock() {},
    makeUserDot: () => dot,
  });
  return { nav, log };
}

test('the routes really are the shapes the failure needed', () => {
  assert.equal(LONG.maneuvers.length, 9);
  assert.equal(SHORT.maneuvers.length, 4);
});

test('a route swapped under a running walk ends the walk instead of throwing', () => {
  withDocument(() => {
    const route = createRoute();
    route.set(LONG);
    const { nav, log } = harness(route);
    nav.start();

    // Most of the way down the long route, past maneuver seven.
    nav.moved(LONG.geometry.coordinates[7]);
    assert.ok(nav.stepIndex() >= 7, `only reached step ${nav.stepIndex()}`);

    route.set(SHORT);
    assert.doesNotThrow(() => nav.moved(SHORT.geometry.coordinates[1]));
    assert.equal(nav.isActive(), false, 'the walk carried on along a line that is gone');
    assert.ok(log.includes('restCamera'), 'the camera was left pitched over the old walk');
  });
});

test('a route cleared under a running walk ends it too', () => {
  withDocument(() => {
    const route = createRoute();
    route.set(LONG);
    const { nav } = harness(route);
    nav.start();
    route.clear();
    assert.doesNotThrow(() => nav.moved(LONG.geometry.coordinates[2]));
    assert.equal(nav.isActive(), false);
  });
});

test('the simulator stops walking a route that has been replaced', async () => {
  await withDocument(async () => {
    const route = createRoute();
    route.set(LONG);
    const { nav } = harness(route);
    try {
      nav.start({ simulate: true });
      route.set(SHORT);
      await new Promise((done) => setTimeout(done, 450));
      assert.equal(nav.isSimulating(), false, 'the interval kept walking the old line');
      assert.equal(nav.isActive(), false);
    } finally {
      nav.end();
    }
  });
});

test('the same route, still set, is walked as before', () => {
  withDocument(() => {
    const route = createRoute();
    route.set(LONG);
    const { nav } = harness(route);
    nav.start();
    nav.moved(LONG.geometry.coordinates[3]);
    assert.equal(nav.isActive(), true);
    assert.ok(nav.stepIndex() >= 3);
    nav.end();
  });
});
