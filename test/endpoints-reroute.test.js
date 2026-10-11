// src/endpoints.js — what a re-route leaves on screen while it is out, and
// after it comes back as something other than a walk.
//
// Three ways it went wrong, all on the path the start field takes: retype the
// start, and the walk is asked for again to the same destination.
//
// A refusal (a start inside the building you are going to is "the same
// place") or a dead server left the PREVIOUS walk drawn with Start enabled,
// and dropped the destination the end field still named — so the next start
// had nowhere to route to and did nothing.
//
// Start stayed enabled while the replacement was out, and a walk begun in that
// window had its route swapped from under it when the answer landed.
//
// And an answer that landed while the map style was being replaced threw on
// the missing source and left the panel on "Calculating route…".
//
// Driven with the real route holder, so "is there a route" is the app's own
// answer rather than the fake's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { point, featureCollection } from '@turf/helpers';
import { createEndpoints } from '../src/endpoints.js';
import { createRoute } from '../src/route-state.js';
import { buildManeuvers } from '../src/maneuvers.js';

const LIBRARY = [-121.3465, 38.6486];
const CTE = [-121.3445, 38.6486];
const DESIGN_HUB = [-121.3446, 38.6487];

/** What /api/route answers with for a walk from `from` to `to`. */
function walk(from, to) {
  const coordinates = [from, [(from[0] + to[0]) / 2, from[1] + 0.0002], to];
  return {
    geometry: { type: 'LineString', coordinates },
    maneuvers: buildManeuvers(coordinates),
    distanceFeet: 600,
  };
}

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
  };
}

/**
 * @param {Function} answer  (from, to) => what api.route resolves or throws
 */
function harness(answer) {
  const route = createRoute();
  const control = fakeControl();
  const log = [];
  const said = [];
  const asked = [];
  const sources = new Map([['calculated-route', []], ['route-legs', []]]);
  let styleSwapped = false;
  const map = {
    getSource: (id) => (styleSwapped || !sources.has(id)
      ? undefined
      : { setData: (data) => sources.get(id).push(data) }),
    flyTo() {},
    getZoom: () => 17,
  };
  const pins = [];
  let active = false;
  const nav = {
    isActive: () => active,
    start: () => { active = route.isWalkable; },
    end: () => { log.push('nav.end'); active = false; },
  };
  const realSet = route.set.bind(route);
  route.set = (result) => { log.push('route.set'); return realSet(result); };
  const ui = { startCoordText: { value: '' }, endCoordText: { value: '' } };
  const buttons = [];
  const endpoints = createEndpoints({
    map,
    route,
    nav,
    camera: { frame() {} },
    api: {
      route: async (from, to) => {
        asked.push({ from, to });
        log.push('api.route');
        return answer(from, to);
      },
    },
    geolocateControl: () => control,
    networkPoints: () => featureCollection([LIBRARY, CTE, DESIGN_HUB].map((c) => point(c))),
    routingEnabled: () => true,
    status: {
      setStatus: (sentence, isError) => said.push({ sentence, isError: Boolean(isError) }),
      setBusy() {},
      setRouteSummary() {},
      setNavButtonsEnabled: (on) => { buttons.push(on); log.push(`buttons:${on}`); },
      setIdleStatus() {},
    },
    panel: { show() {}, padding: () => ({}) },
    ui,
    paintLegs() {},
    clearSelection() {},
    clearSearchField() {},
    startLocating() {},
    plantPin: (colour, title, at) => {
      const pin = { title, at, removed: false };
      pin.remove = () => { pin.removed = true; };
      pin.setLngLat = (next) => { pin.at = next; return pin; };
      pins.push(pin);
      return pin;
    },
  });
  return {
    endpoints, route, nav, control, ui, log, said, asked, sources, pins,
    buttons: () => buttons.at(-1),
    last: () => said.at(-1),
    swapStyle: () => { styleSwapped = true; },
    destinationPin: () => pins.filter((p) => p.title === 'Destination' && !p.removed),
  };
}

const EMPTY = { type: 'FeatureCollection', features: [] };

const SAME_PLACE = 'Start and destination are the same place — pick a destination further off.';

/** Routes everywhere, except from inside CTE to CTE. */
const refuseInsideCte = (from, to) => (from === DESIGN_HUB && to === CTE
  ? { refused: SAME_PLACE }
  : walk(from, to));

test('a refused re-route takes the old walk down', async () => {
  const h = harness(refuseInsideCte);
  h.endpoints.placeStart(LIBRARY, 'Library');
  await h.endpoints.placeEnd(CTE, 'Career Technical Education (CTE)');
  assert.equal(h.route.isWalkable, true);
  assert.equal(h.buttons(), true);

  // The start field: pick a place inside the destination.
  h.endpoints.placeStart(DESIGN_HUB, 'Design Hub');
  await h.endpoints.rerouteFromStart();

  assert.equal(h.last().sentence, SAME_PLACE);
  assert.equal(h.route.isSet, false, 'the walk from the old start is still set');
  assert.equal(h.buttons(), false, 'Start still offers to walk it');
  assert.deepEqual(h.sources.get('calculated-route').at(-1), EMPTY, 'the ribbon is still drawn');
  assert.deepEqual(h.sources.get('route-legs').at(-1), EMPTY);
});

test('a refused re-route keeps the destination, so the next start routes to it', async () => {
  const h = harness(refuseInsideCte);
  h.endpoints.placeStart(LIBRARY, 'Library');
  await h.endpoints.placeEnd(CTE, 'Career Technical Education (CTE)');
  h.endpoints.placeStart(DESIGN_HUB, 'Design Hub');
  await h.endpoints.rerouteFromStart();

  // Still on the map and still in the field, which is what it says it is.
  assert.equal(h.destinationPin().length, 1, 'the red pin went with the walk');
  assert.equal(h.ui.endCoordText.value, 'Career Technical Education (CTE)');

  h.asked.length = 0;
  h.endpoints.placeStart(LIBRARY, 'Library');
  await h.endpoints.rerouteFromStart();
  assert.equal(h.asked.length, 1, 'a corrected start asked for nothing');
  assert.deepEqual(h.asked[0].to, CTE);
  assert.equal(h.route.isWalkable, true);
  assert.equal(h.buttons(), true);
  assert.equal(h.endpoints.end() !== null, true);
});

test('an unreachable server on a re-route leaves the same state as a refusal', async (t) => {
  let up = true;
  const h = harness((from, to) => {
    if (!up) throw new Error('fetch failed');
    return walk(from, to);
  });
  t.mock.method(console, 'error', () => {});
  h.endpoints.placeStart(LIBRARY, 'Library');
  await h.endpoints.placeEnd(CTE, 'CTE');
  up = false;
  h.endpoints.placeStart(DESIGN_HUB, 'Design Hub');
  await h.endpoints.rerouteFromStart();

  assert.equal(h.last().isError, true);
  assert.equal(h.route.isSet, false);
  assert.equal(h.buttons(), false);

  up = true;
  await h.endpoints.rerouteFromStart();
  assert.equal(h.route.isWalkable, true, 'trying again had nothing to route to');
  assert.deepEqual(h.asked.at(-1).to, CTE);
});

test('a destination routed after one was parked is not routed to again later', async () => {
  // pendingEnd is cleared by any placeEnd, not only by the one that took it.
  const h = harness(refuseInsideCte);
  h.endpoints.placeStart(DESIGN_HUB, 'Design Hub');
  await h.endpoints.placeEnd(CTE, 'CTE');                // refused, parked
  await h.endpoints.placeEnd(LIBRARY, 'Library');        // routed
  assert.equal(h.endpoints.takeParked(), null);
});

test('Start is off while a replacement route is out', async () => {
  let release;
  const h = harness((from, to) => (to === CTE && from === DESIGN_HUB
    ? new Promise((resolve) => { release = () => resolve(walk(from, to)); })
    : walk(from, to)));
  h.endpoints.placeStart(LIBRARY, 'Library');
  await h.endpoints.placeEnd(CTE, 'CTE');
  assert.equal(h.buttons(), true);

  h.endpoints.placeStart(DESIGN_HUB, 'Design Hub');
  const landing = h.endpoints.rerouteFromStart();
  await Promise.resolve();
  assert.equal(h.buttons(), false, 'the route being replaced can still be started');
  release();
  await landing;
  assert.equal(h.buttons(), true);
});

test('an answer that lands under a running walk ends the walk before swapping the route', async () => {
  let release;
  const h = harness((from, to) => (from === DESIGN_HUB
    ? new Promise((resolve) => { release = () => resolve(walk(from, to)); })
    : walk(from, to)));
  h.endpoints.placeStart(LIBRARY, 'Library');
  await h.endpoints.placeEnd(CTE, 'CTE');
  h.endpoints.placeStart(DESIGN_HUB, 'Design Hub');
  const landing = h.endpoints.rerouteFromStart();
  await Promise.resolve();

  // However the walk got started — this is the case the disabled buttons are
  // there to prevent, and the swap must still be safe if one gets through.
  h.nav.start();
  assert.equal(h.nav.isActive(), true);
  h.log.length = 0;
  release();
  await landing;

  assert.equal(h.nav.isActive(), false);
  assert.ok(h.log.indexOf('nav.end') !== -1, 'the walk was left running');
  assert.ok(h.log.indexOf('nav.end') < h.log.indexOf('route.set'), 'the route was swapped first');
});

test('"Your location" in the start field holds Start off until the fix is in', async () => {
  const h = harness(walk);
  h.endpoints.placeStart(LIBRARY, 'Library');
  await h.endpoints.placeEnd(CTE, 'CTE');
  assert.equal(h.buttons(), true);

  const locating = h.endpoints.locateStart();
  assert.equal(h.buttons(), false, 'Start was live through the nine-second wait');
  h.control.fire('geolocate', { coords: { longitude: DESIGN_HUB[0], latitude: DESIGN_HUB[1] } });
  assert.equal(await locating, true);
  assert.equal(h.buttons(), false, 'the old walk was offered again before its re-route');

  await h.endpoints.rerouteFromStart();
  assert.equal(h.buttons(), true);
});

test('a location that never comes gives the old walk its Start back', async () => {
  const h = harness(walk);
  h.endpoints.placeStart(LIBRARY, 'Library');
  await h.endpoints.placeEnd(CTE, 'CTE');

  const locating = h.endpoints.locateStart();
  h.control.fire('error', { code: 1 });
  assert.equal(await locating, false);
  // The start never moved, so the walk on screen is still the right one.
  assert.equal(h.route.isWalkable, true);
  assert.equal(h.buttons(), true);
});

test('an answer that lands during a style swap still finishes the panel', async () => {
  let release;
  const h = harness((from, to) => new Promise((resolve) => {
    release = () => resolve(walk(from, to));
  }));
  h.endpoints.placeStart(LIBRARY, 'Library');
  const landing = h.endpoints.placeEnd(CTE, 'CTE');
  await Promise.resolve();
  // A basemap, theme or skin change: the style is replaced, and its sources
  // are gone until style.load puts them back.
  h.swapStyle();
  release();
  await assert.doesNotReject(landing);

  assert.match(h.last().sentence, /^Route calculated/);
  assert.equal(h.buttons(), true);
  assert.equal(h.route.isWalkable, true, 'style.load has no route to draw from');
});
