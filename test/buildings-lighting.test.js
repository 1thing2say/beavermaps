// src/buildings-lighting.js — what the extrusions leave behind.
//
// A campus repaint that found no style to draw on was still recorded as done,
// so the daylight timer saw nothing left to do and the campus stayed painted
// for day beside a city at dusk.

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
