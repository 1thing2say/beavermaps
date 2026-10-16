// src/draw-gate.js — what an overlay handler may do to a map with no style.
//
// The handlers in src/main.js store what arrived and then draw it. When the
// drawing threw — a setStyle in flight, so "Style is not done loading" — the
// rest of the handler was skipped and its promise rejected, and the labels,
// which wait on the sheet's promise, were never stored at all. These hold the
// gate to the two things that fixed it: no drawing without a style, and no
// throw out of a draw.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawGate } from '../src/draw-gate.js';

/** A map whose addSource throws until a style has loaded, as mapbox-gl's does. */
function fakeMap() {
  const map = { loaded: false, sources: [] };
  map.addSource = (id) => {
    if (!map.loaded) throw new Error('Style is not done loading');
    map.sources.push(id);
  };
  return map;
}

test('nothing is drawn while there is no style, and nothing throws', () => {
  const map = fakeMap();
  const draw = createDrawGate(() => map.loaded);
  assert.doesNotThrow(() => draw(() => map.addSource('campus-basemap')));
  assert.deepEqual(map.sources, []);
  map.loaded = true;
  draw(() => map.addSource('campus-basemap'));
  assert.deepEqual(map.sources, ['campus-basemap']);
});

test('a builder that throws costs its own layer, not the handler around it', async () => {
  // The shape of the old failure: a handler that draws, then sets state that
  // a later chain reads. The draw throwing must not reject the promise.
  const map = fakeMap();
  const errors = [];
  const draw = createDrawGate(() => true, (e) => errors.push(e.message));
  let labels = null;
  const basemapReady = Promise.resolve('sheet').then(() => {
    draw(() => map.addSource('campus-basemap'), () => map.sources.push('after'));
  });
  await basemapReady.then(() => { labels = 'stored'; });
  assert.equal(labels, 'stored', 'the labels chain never ran');
  assert.deepEqual(errors, ['Style is not done loading']);
  assert.deepEqual(map.sources, ['after'], 'one throw skipped the builders after it');
});
