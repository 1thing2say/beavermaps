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
