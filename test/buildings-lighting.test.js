// src/buildings-lighting.js — what the extrusions leave behind.
//
// Two bugs that only showed on the map hours later. A campus repaint that found
// no style to draw on was still recorded as done, so the daylight timer saw
// nothing left to do and the campus stayed painted for day beside a city at
// dusk. And ending a walk took the extrusions down but left the app's own sun
// lighting the whole city in place of Standard's preset lights.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildingsLighting } from '../src/buildings-lighting.js';

const STANDARD = [
  { id: 'ambient', type: 'ambient', properties: { intensity: 'STANDARD' } },
  { id: 'directional', type: 'directional', properties: { intensity: 'STANDARD' } },
];

function stubMap() {
  const layers = new Set();
  const lights = [];
  return {
    layers,
    lights,
    getLayer: (id) => layers.has(id),
    getSource: () => true,
    addSource() {},
    addLayer: (layer) => layers.add(layer.id),
    removeLayer: (id) => layers.delete(id),
    setPaintProperty() {},
    easeTo() {},
    setLights: (next) => lights.push(next),
  };
}

function lightingOn(map, overrides = {}) {
  const state = { navigating: false, preset: 'day', repaints: 0, repaintResult: true };
  const lighting = createBuildingsLighting({
    map,
    centre: [-121.34638, 38.64916],
    litPalette: () => ({ building: '#ccc', lightPreset: 'day' }),
    navigating: () => state.navigating,
    clockPreset: () => state.preset,
    theme: () => 'dark',
    footprints: () => ({ type: 'FeatureCollection', features: [] }),
    isStyleBuilt: () => true,
    bench: () => null,
    standardLights: () => STANDARD,
    setConfig() {},
    paintLamps() {},
    repaintCampus: () => { state.repaints += 1; return state.repaintResult; },
    ...overrides,
  });
  return { lighting, state };
}

test('a campus repaint that did not happen is asked for again', () => {
  const { lighting, state } = lightingOn(stubMap());
  state.repaintResult = false;
  lighting.applyLighting();
  assert.equal(state.repaints, 1);

  // The daylight timer, same preset, once the map can be drawn on.
  state.repaintResult = true;
  lighting.applyLighting();
  assert.equal(state.repaints, 2);

  // And once it has happened, not again until the preset moves.
  lighting.applyLighting();
  assert.equal(state.repaints, 2);
  state.preset = 'dusk';
  lighting.applyLighting();
  assert.equal(state.repaints, 3);
});

test('ending a walk puts Standard\'s own lights back', () => {
  const map = stubMap();
  const { lighting, state } = lightingOn(map);

  state.navigating = true;
  lighting.add();
  assert.ok(map.getLayer('campus-buildings'));
  const walking = map.lights.at(-1);
  assert.notEqual(walking[0].properties.intensity, 'STANDARD', 'the app\'s sun while standing');

  // navigation.js stops navigating before it asks for the layer back.
  state.navigating = false;
  lighting.remove();
  assert.equal(map.getLayer('campus-buildings'), false);
  const after = map.lights.at(-1);
  assert.deepEqual(after.map((l) => l.id), ['ambient', 'directional']);
  assert.equal(after.find((l) => l.id === 'directional').properties.intensity, 'STANDARD');
});

test('remove with nothing standing leaves the lights alone', () => {
  const map = stubMap();
  const { lighting } = lightingOn(map);
  lighting.remove();
  assert.equal(map.lights.length, 0);
});
