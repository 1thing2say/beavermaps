// src/label-layers.js — the outline on the building whose card is open.
//
// The selection used to live only in the two highlight layers' filters, and a
// style swap throws those layers away. addDirectory rebuilt them filtered to
// nothing, so pressing Satellite — or, under Google, Light or Dark — with a
// building card open took the outline off the building the card was about.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabelLayers, NOTHING_SELECTED } from '../src/label-layers.js';

function stubMap() {
  const layers = new Map();
  const sources = new Set();
  return {
    layers,
    getLayer: (id) => layers.get(id),
    addLayer: (layer) => layers.set(layer.id, { ...layer }),
    getSource: (id) => sources.has(id),
    addSource: (id) => sources.add(id),
    setFilter: (id, filter) => { layers.get(id).filter = filter; },
    setPaintProperty() {},
    /** What setStyle does to everything this module added. */
    swapStyle() { layers.clear(); sources.clear(); },
  };
}

function labelsOn(map) {
  return createLabelLayers({
    map,
    litPalette: () => ({ route: '#2f7cf6' }),
    mapFont: () => ['Inter'],
    skin: () => 'apple',
    printed: () => null,
    directory: () => ({ type: 'FeatureCollection', features: [] }),
    sheet: () => null,
    pinRing: () => '#fff',
    labelFilter: () => true,
    inkFor: () => '#000',
    theme: () => 'light',
  });
}

const KERR = ['==', ['get', 'officialName'], 'Kerr Admin'];

test('a selection survives a style swap', () => {
  const map = stubMap();
  const labels = labelsOn(map);
  labels.addDirectory();
  labels.select('Kerr Admin');
  assert.deepEqual(map.getLayer('campus-directory-line').filter, KERR);

  map.swapStyle();
  labels.addDirectory();
  assert.deepEqual(map.getLayer('campus-directory-fill').filter, KERR);
  assert.deepEqual(map.getLayer('campus-directory-line').filter, KERR);
});

test('closing the card clears it, before and after a swap', () => {
  const map = stubMap();
  const labels = labelsOn(map);
  labels.addDirectory();
  labels.select('Kerr Admin');
  labels.select(null);
  assert.deepEqual(map.getLayer('campus-directory-fill').filter, NOTHING_SELECTED);

  map.swapStyle();
  labels.addDirectory();
  assert.deepEqual(map.getLayer('campus-directory-line').filter, NOTHING_SELECTED);
});

test('a selection made before the layers exist is not lost', () => {
  const map = stubMap();
  const labels = labelsOn(map);
  labels.select('Kerr Admin');
  labels.addDirectory();
  assert.deepEqual(map.getLayer('campus-directory-line').filter, KERR);
});
