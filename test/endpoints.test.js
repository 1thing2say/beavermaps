// src/endpoints.js — asking the phone where it is, and not being undone by it.
//
// Two failures, both of them waits that ended with the wrong thing on screen.
//
// Outside the map's fence the locate control fires `outofmaxbounds` instead of
// `geolocate`, and nothing listened for it: Directions spun for nine seconds
// and then said "Locating timed out" to a phone that had answered at once.
//
// And a fix that took its time could land after the person had pressed Clear
// or Close, and put back the start — or the red pin, or a timeout sentence —
// that they had just taken away.
//
// Driven through a fake control rather than Mapbox's, because the control is
// the one collaborator here whose events ARE the behaviour, and a fake is the
// only way to fire `outofmaxbounds` at a moment of the test's choosing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { point, featureCollection } from '@turf/helpers';
import { createEndpoints, OUTSIDE_FENCE } from '../src/endpoints.js';

/** On a campus path — the one vertex in the fake graph. */
const ON_CAMPUS = [-121.3465, 38.6486];
/** About ten miles off, which the fence turns away. */
const AT_HOME = [-121.5, 38.7];

/** Just the event surface of a GeolocateControl. */
function fakeControl() {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    off(type, fn) { handlers.get(type)?.delete(fn); },
    fire(type, event) { for (const fn of [...(handlers.get(type) ?? [])]) fn(event); },
    listening() { return [...handlers.values()].reduce((n, set) => n + set.size, 0); },
  };
}

function harness({ lastPosition } = {}) {
  const control = fakeControl();
  const said = [];
  const routed = [];
  const endpoints = createEndpoints({
    map: { getSource: () => null, flyTo() {}, getZoom: () => 17 },
    route: { clear() {} },
    nav: { end() {} },
    camera: { frame() {} },
    api: { route: async (...ends) => { routed.push(ends); return null; } },
    geolocateControl: () => control,
    lastPosition,
    networkPoints: () => featureCollection([point(ON_CAMPUS)]),
    routingEnabled: () => true,
    status: {
      setStatus: (sentence, isError) => said.push({ sentence, isError: Boolean(isError) }),
      setBusy() {},
      setRouteSummary() {},
      setNavButtonsEnabled() {},
      setIdleStatus: () => said.push({ sentence: 'idle', isError: false }),
    },
    panel: { show() {}, padding: () => ({}) },
    ui: { startCoordText: { value: '' }, endCoordText: { value: '' } },
    paintLegs() {},
    clearSelection() {},
    clearSearchField() {},
    startLocating() {},
  });
  return { endpoints, control, said, routed, last: () => said.at(-1) };
}

/**
 * What Mapbox actually hands an `outofmaxbounds` listener: the position's own
 * properties copied onto an event. A real GeolocationPosition's `coords` is a
 * getter on its prototype, so the copy carries none.
 */
class GetterPosition {
  #at;
  constructor(at) { this.#at = at; }
  get coords() { return { longitude: this.#at[0], latitude: this.#at[1] }; }
}
const outOfBoundsEvent = (position) => ({ type: 'outofmaxbounds', ...position });

test('the fence answers at once, with the position the seam recorded', async () => {
  const { endpoints, control } = harness({ lastPosition: () => ({ at: AT_HOME, when: Date.now() }) });
  const asked = endpoints.currentPosition();
  control.fire('outofmaxbounds', outOfBoundsEvent(new GetterPosition(AT_HOME)));
  assert.deepEqual(await asked, AT_HOME);
  assert.equal(control.listening(), 0, 'listeners were left on the control');
});

test('a phone outside the fence is told how far away it is, not that it timed out', async () => {
  const { endpoints, control, last } = harness({ lastPosition: () => ({ at: AT_HOME, when: Date.now() }) });
  const located = endpoints.locateStart();
  control.fire('outofmaxbounds', outOfBoundsEvent(new GetterPosition(AT_HOME)));
  assert.equal(await located, false);
  assert.equal(last().isError, true);
  assert.match(last().sentence, /too far/);
  assert.doesNotMatch(last().sentence, /timed out/i);
  assert.equal(endpoints.start(), null);
});

test('with nothing recorded, the fence is its own sentence', async () => {
  const { endpoints, control, last } = harness({ lastPosition: () => null });
  const asked = endpoints.currentPosition();
  control.fire('outofmaxbounds', outOfBoundsEvent(new GetterPosition(AT_HOME)));
  await assert.rejects(asked, (error) => error.code === 'outside');

  const located = endpoints.locateStart();
  control.fire('outofmaxbounds', {});
  assert.equal(await located, false);
  assert.equal(last().sentence, OUTSIDE_FENCE);
  assert.match(OUTSIDE_FENCE, /press and hold/i, 'the refusal names no way forward');
});

test('coords on the event itself are used when a Mapbox passes them through', async () => {
  const { endpoints, control } = harness({ lastPosition: () => null });
  const asked = endpoints.currentPosition();
  control.fire('outofmaxbounds', { coords: { longitude: AT_HOME[0], latitude: AT_HOME[1] } });
  assert.deepEqual(await asked, AT_HOME);
});

test('a fix on campus still becomes the start', async () => {
  const { endpoints, control } = harness();
  const located = endpoints.locateStart();
  control.fire('geolocate', { coords: { longitude: ON_CAMPUS[0], latitude: ON_CAMPUS[1] } });
  assert.equal(await located, true);
  assert.deepEqual(endpoints.start().geometry.coordinates, ON_CAMPUS);
});

// --- Clear and Close while the GPS is being asked --------------------------

test('Clear during "Finding your location…" is not undone by the fix', async () => {
  const { endpoints, control, routed, last } = harness();
  const going = endpoints.setDestination([-121.3455, 38.6486], 'Library');
  endpoints.reset();
  control.fire('geolocate', { coords: { longitude: ON_CAMPUS[0], latitude: ON_CAMPUS[1] } });
  await going;

  assert.equal(endpoints.start(), null, 'the start came back after Clear');
  assert.equal(endpoints.hasRoute(), false);
  assert.equal(endpoints.takeParked(), null, 'the destination was parked after Clear');
  assert.equal(routed.length, 0, 'a route was asked for after Clear');
  assert.equal(last().sentence, 'idle', 'the idle line Clear put up was written over');
});

test('Close during locating is not followed by a failure sentence', async () => {
  // The other half: a fix that FAILS after the reset used to write
  // "Location is turned off…" over the idle line, and park the red pin again.
  const { endpoints, control, last } = harness();
  const going = endpoints.setDestination([-121.3455, 38.6486], 'Library');
  endpoints.reset();
  control.fire('error', { code: 1 });
  await going;

  assert.equal(last().sentence, 'idle');
  assert.equal(endpoints.takeParked(), null);
});

test('locateStart on its own drops a fix that arrives after a reset', async () => {
  // The start field's "Your location" calls this directly, without
  // setDestination around it, so the guard has to be inside it too.
  const { endpoints, control } = harness();
  const located = endpoints.locateStart();
  endpoints.reset();
  control.fire('geolocate', { coords: { longitude: ON_CAMPUS[0], latitude: ON_CAMPUS[1] } });
  assert.equal(await located, false);
  assert.equal(endpoints.start(), null);
});
