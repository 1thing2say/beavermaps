// src/locate.js — pressing Directions again after the browser said no.
//
// Mapbox's control turns itself off when the location permission is denied,
// and says so with `error` alone: it does not fire `trackuserlocationend`, the
// event `locating` is cleared by. So the app went on believing the control was
// locating, every later press asked for nothing, and Directions spun for nine
// seconds before saying "Locating timed out" — to somebody who had just allowed
// location, as the previous sentence told them to.
//
// The fake control below copies the transitions of mapbox-gl 3.23's
// GeolocateControl that matter here: trigger() from OFF opens a watch, fires
// `trackuserlocationstart` and presses the button; a code-1 error closes the
// watch, un-presses and disables the button, and fires `error` and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { point, featureCollection } from '@turf/helpers';
import { createLocate } from '../src/locate.js';
import { createEndpoints } from '../src/endpoints.js';

const ON_CAMPUS = [-121.3465, 38.6486];

function fakeButton() {
  const attrs = new Map([['aria-pressed', 'false']]);
  return {
    disabled: false,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, String(value)),
  };
}

function fakeControl(button) {
  const handlers = new Map();
  const control = {
    watching: false,
    triggers: 0,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    off(type, fn) { handlers.get(type)?.delete(fn); },
    fire(type, event) { for (const fn of [...(handlers.get(type) ?? [])]) fn(event); },
    trigger() {
      control.triggers++;
      if (control.watching) return;
      control.watching = true;
      button.setAttribute('aria-pressed', 'true');
      control.fire('trackuserlocationstart');
    },
    // Both only reach a watch that is open, as a real browser's do: with none,
    // nothing is listening for an answer and none comes.
    /** The browser refusing: Mapbox's _onError with code 1. */
    deny() {
      if (!control.watching) return;
      control.watching = false;
      button.disabled = true;
      button.setAttribute('aria-pressed', 'false');
      control.fire('error', { code: 1 });
    },
    fix(at) {
      if (!control.watching) return;
      control.fire('geolocate', { coords: { longitude: at[0], latitude: at[1] } });
    },
  };
  return control;
}

/** The control, the locate wrapper and the endpoints, wired the way main.js wires them. */
function harness() {
  const button = fakeButton();
  const control = fakeControl(button);
  const locate = createLocate({ control: () => control });
  control.on('trackuserlocationstart', () => locate.setLocating(true));
  control.on('trackuserlocationend', () => locate.setLocating(false));
  const said = [];
  const endpoints = createEndpoints({
    map: { getSource: () => undefined, flyTo() {}, getZoom: () => 17 },
    route: { clear() {}, isWalkable: false },
    nav: { end() {} },
    camera: { frame() {} },
    api: { route: async () => null },
    geolocateControl: () => control,
    networkPoints: () => featureCollection([point(ON_CAMPUS)]),
    routingEnabled: () => true,
    status: {
      setStatus: (sentence) => said.push(sentence),
      setBusy() {},
      setRouteSummary() {},
      setNavButtonsEnabled() {},
      setIdleStatus() {},
    },
    panel: { show() {}, padding: () => ({}) },
    ui: { startCoordText: { value: '' }, endCoordText: { value: '' } },
    paintLegs() {},
    clearSelection() {},
    clearSearchField() {},
    startLocating: () => locate.start(),
    plantPin: () => ({ remove() {}, setLngLat() { return this; } }),
  });
  return { button, control, locate, endpoints, said };
}

/** locate.js finds the button by its class; nothing else here needs a document. */
function withButton(button, body) {
  const had = globalThis.document;
  globalThis.document = { querySelector: () => button };
  const restore = () => {
    if (had === undefined) delete globalThis.document;
    else globalThis.document = had;
  };
  return Promise.resolve().then(body).finally(restore);
}

test('a denial leaves the next press free to ask again', () => {
  const h = harness();
  return withButton(h.button, () => {
    h.locate.start();
    assert.equal(h.control.triggers, 1);
    assert.equal(h.locate.isLocating(), true);

    h.control.deny();
    h.locate.start();
    assert.equal(h.control.triggers, 2, 'the second press asked for nothing');
    assert.equal(h.button.disabled, false, 'the button Mapbox disabled was left dead');
  });
});

test('a press while the watch is genuinely open is still a no-op', () => {
  const h = harness();
  return withButton(h.button, () => {
    h.locate.start();
    h.locate.start();
    assert.equal(h.control.triggers, 1, 'a second trigger would turn the control off');
  });
});

test('allowed after a denial, the next Directions press is answered by the fix', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  await withButton(h.button, async () => {
    const first = h.endpoints.locateStart();
    h.control.deny();
    assert.equal(await first, false);
    assert.match(h.said.at(-1), /turned off/);

    const second = h.endpoints.locateStart();
    h.control.fix(ON_CAMPUS);
    // If nothing was asked, nothing answers: run the wait out, so the failure
    // is a wrong answer rather than a hung test.
    t.mock.timers.tick(9_000);
    assert.equal(await second, true, 'the second press waited on a watch that was gone');
    assert.deepEqual(h.endpoints.start().geometry.coordinates, ON_CAMPUS);
  });
});

test('still denied, the next press says so again rather than timing out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  await withButton(h.button, async () => {
    const first = h.endpoints.locateStart();
    h.control.deny();
    await first;

    const second = h.endpoints.locateStart();
    h.control.deny();
    t.mock.timers.tick(9_000);
    assert.equal(await second, false);
    assert.match(h.said.at(-1), /turned off/);
    assert.doesNotMatch(h.said.at(-1), /timed out/i);
  });
});
