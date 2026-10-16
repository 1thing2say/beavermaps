// src/ground.js — the same-style restyle, and what gates it.
//
// Under Mapbox light and dark (and every daylight preset) are one style key, so
// a theme change never swaps the style: `sync` re-runs the builders instead.
// That path used to be gated on `map.isStyleLoaded()`, which answers whether
// the style is IDLE and is false whenever a tile, an image or a pending setData
// is still in flight. A visitor who tapped Dark mid-pan got dark chrome over a
// light map, and nothing ever retried. These pin the gate to "a style exists".

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from '../src/ground.js';

globalThis.window ??= { location: { origin: 'https://example.test' } };

/** A map that is never idle — tiles are always still loading — after style.load. */
function busyMap() {
  const handlers = new Map();
  const map = {
    on(event, fn) { handlers.set(event, fn); },
    fire(event) { handlers.get(event)?.(); },
    isStyleLoaded: () => false,
    getLights: () => [],
    getLayer: () => false,
    setStyleCalls: 0,
    setStyle() { map.setStyleCalls += 1; },
  };
  return map;
}

function groundOn(map, overrides = {}) {
  const state = { key: null, built: false, theme: 'light', rebuilds: [] };
  const ground = createGround({
    map,
    googleKey: '',
    provider: () => 'mapbox',
    basemap: () => 'map',
    theme: () => state.theme,
    skin: () => 'apple',
    appliedStyleKey: () => state.key,
    setAppliedStyleKey: (key) => { state.key = key; },
    setStyleBuilt: (on) => { state.built = on; },
    isStyleBuilt: () => state.built,
    litPalette: () => ({ style: 'mapbox://styles/mapbox/standard' }),
    setStatus() {},
    setNotice() {},
    rebuild: () => { state.rebuilds.push(state.theme); },
    clearHover() {},
    standBuildings() {},
    providerControl: () => null,
    setProvider() {},
    captureStyleLights() {},
    ...overrides,
  });
  return { ground, state };
}

test('a theme change while tiles are still loading still recolours the map', () => {
  const map = busyMap();
  const { ground, state } = groundOn(map);

  ground.sync();
  assert.equal(map.setStyleCalls, 1);
  map.fire('style.load');
  assert.deepEqual(state.rebuilds, ['light']);

  state.theme = 'dark';
  assert.equal(ground.sync(), true);
  assert.deepEqual(state.rebuilds, ['light', 'dark']);
  assert.equal(map.setStyleCalls, 1, 'one style key for both themes: no swap');
});

test('sync before the first style exists does nothing, and says so', () => {
  const map = busyMap();
  const { ground, state } = groundOn(map);
  ground.sync();
  // The toggles publish their initial state before style.load; there is
  // nothing to rebuild and the caller must not record the look as painted.
  assert.equal(ground.sync(), false);
  assert.deepEqual(state.rebuilds, []);
});

test('a rebuild that asks for a repaint does not rebuild a second time', () => {
  const map = busyMap();
  let ground;
  let nested;
  const built = groundOn(map, {
    // What applyLighting does at the end of every rebuild on a preset change.
    rebuild: () => { built.state.rebuilds.push('outer'); nested = ground.sync(); },
  });
  ground = built.ground;

  ground.sync();
  map.fire('style.load');
  assert.deepEqual(built.state.rebuilds, ['outer']);
  assert.equal(nested, true, 'the running rebuild counts as the repaint');

  built.state.rebuilds.length = 0;
  ground.sync();
  assert.deepEqual(built.state.rebuilds, ['outer']);
});
