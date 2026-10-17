// src/layer-order.js — what goes under what, whatever order it arrives in.
//
// The stack is a list and the claim is that a layer finds its place from the
// list alone. These tests drive the real builders — the sheet, the network
// and the route — against a map that stacks layers the way Mapbox does, in
// each order the app can actually produce, and check the result is the list.
// The lamps and the legend's outlines live in modules that need a browser to
// import, so they are stood in for by the exact call they make.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CAMPUS_STACK, anchorFor } from '../src/layer-order.js';
import { createCampusSheet } from '../src/campus-sheet.js';
import { createRouteLayers } from '../src/route-layers.js';
import { LOOKS } from '../src/palette.js';
import { load, root } from './helpers.js';

/** A map that records layers in the order Mapbox would stack them. */
function fakeMap() {
  const order = [];
  const layers = new Map();
  const sources = new Map();
  return {
    order,
    getLayer: (id) => layers.get(id),
    getSource: (id) => sources.get(id),
    addSource: (id, source) => { sources.set(id, { ...source, setData() {} }); },
    addLayer(layer, before) {
      if (layers.has(layer.id)) throw new Error(`${layer.id} added twice`);
      if (before !== undefined && !layers.has(before)) throw new Error(`no layer ${before}`);
      layers.set(layer.id, layer);
      order.splice(before === undefined ? order.length : order.indexOf(before), 0, layer.id);
    },
    removeLayer(id) { layers.delete(id); order.splice(order.indexOf(id), 1); },
    setPaintProperty() {},
    setConfigProperty() {},
    setFilter() {},
  };
}

/** The app, reduced to the builders whose order is in question. */
function campus(map, { sheetLoaded }) {
  const basemap = load('basemap');
  let sheet = sheetLoaded ? basemap : null;
  const litPalette = () => LOOKS.classic.light;
  const sheetLayers = createCampusSheet({ map, litPalette, sheet: () => sheet });
  const route = createRouteLayers({
    map,
    litPalette,
    provider: () => 'mapbox',
    boundary: { type: 'FeatureCollection', features: [] },
    network: () => null,
    sheet: () => sheet,
    route: { feature: () => null, legs: () => null },
    from: () => undefined,
    to: () => undefined,
  });
  // The two that cannot be imported here, as the calls they make.
  const stand = (...ids) => {
    for (const id of ids) {
      if (!map.getLayer(id)) map.addLayer({ id, paint: {} }, anchorFor(map, id));
    }
  };
  const lamps = () => stand('campus-lamp-pool', 'campus-lamp-core');
  const highlight = () => stand('highlight-fill', 'highlight-line', 'highlight-points');
  // src/buildings-lighting.js, which only stands the extrusions during a walk.
  const buildings = () => stand('campus-buildings');
  // A layer this list does not order, standing in for the pins and labels
  // that addNetworkLayers puts last: the stack must never climb over them.
  const labels = () => { if (!map.getLayer('labels')) map.addLayer({ id: 'labels', paint: {} }); };

  return {
    // addNetworkLayers, in the order main.js calls it.
    styleLoad() {
      route.addMask();
      sheetLayers.add();
      highlight();
      route.addNetworkAndRoute();
      sheetLayers.addClosed();
      lamps();
      labels();
    },
    sheetArrives() {
      sheet = basemap;
      sheetLayers.add();
      sheetLayers.addClosed();
    },
    amenitiesArrive: lamps,
    walkStarts: buildings,
  };
}

/** The stacked ids, minus anything the list does not order. */
const stacked = (map) => map.order.filter((id) => CAMPUS_STACK.includes(id));

/** The list as it stands when nobody is walking: no extrusions. */
const IDLE = CAMPUS_STACK.filter((id) => id !== 'campus-buildings');

test('a warm load stacks in list order', () => {
  const map = fakeMap();
  campus(map, { sheetLoaded: true }).styleLoad();
  assert.deepEqual(stacked(map), IDLE);
  assert.equal(map.order.at(-1), 'labels', 'the stack climbed over the labels');
});

test('a cold load, with the sheet landing last, stacks the same', () => {
  // The case that broke the legend once: the sheet arrives from the server
  // after the outlines are already standing, and has to go UNDER them — and,
  // now, half of it under the network and half over.
  const map = fakeMap();
  const app = campus(map, { sheetLoaded: false });
  app.styleLoad();
  app.sheetArrives();
  app.amenitiesArrive();
  assert.deepEqual(stacked(map), IDLE);
  assert.equal(map.order.at(-1), 'labels');
});

test('the extruded buildings stand between the legs and the route line, and stay inside the stack', () => {
  // They used to be inserted under `route-casing` by name while the list said
  // they were above all of it. Threaded into the middle unlisted, they broke
  // the list's own premise: a stack layer anchored past them would land on
  // the wrong side. Stood up at the start of a walk, before the sheet has
  // even landed, and after it — the list must come out whole either way.
  for (const early of [true, false]) {
    const map = fakeMap();
    const app = campus(map, { sheetLoaded: false });
    app.styleLoad();
    if (early) app.walkStarts();
    app.sheetArrives();
    app.amenitiesArrive();
    if (!early) app.walkStarts();
    assert.deepEqual(stacked(map), CAMPUS_STACK, `early ${early}`);
    assert.equal(map.order.at(-1), 'labels', 'the extrusions climbed over the labels');
  }
});

test('the lamps go under the network whichever of them is added first', () => {
  // The lamps anchored to `campus-paths`, which did not exist, and so stood
  // at the top of the slot over the paths and the route.
  for (const lampsFirst of [true, false]) {
    const map = fakeMap();
    const app = campus(map, { sheetLoaded: false });
    if (lampsFirst) app.amenitiesArrive();
    app.styleLoad();
    app.sheetArrives();
    const at = (id) => map.order.indexOf(id);
    assert.ok(at('campus-lamp-core') < at('network-casing'), `lamps over the network (lampsFirst ${lampsFirst})`);
    assert.ok(at('campus-lamp-pool') > at('campus-sheet-canopy'), 'lamps under the trees');
    assert.ok(at('campus-lamp-pool') < at('route-line'));
  }
});

test('the network is under the buildings and the route is over everything', () => {
  const map = fakeMap();
  campus(map, { sheetLoaded: true }).styleLoad();
  const at = (id) => map.order.indexOf(id);
  assert.ok(at('campus-sheet-line') < at('network-casing'), 'pavement over the network');
  assert.ok(at('network-lines') < at('campus-sheet-upper-fill'), 'the network over the buildings');
  assert.ok(at('campus-sheet-upper-line') < at('highlight-fill'), 'buildings over the legend outlines');
  assert.ok(at('campus-closed-fill') > at('campus-sheet-upper-fill'), 'the red wash under its own grey');
  for (const id of IDLE.slice(0, IDLE.indexOf('route-legs'))) assert.ok(at(id) < at('route-legs'), `${id} over the route`);
});

test('an id the list does not know is an error, not the top of the slot', () => {
  // Answering `undefined` is how a stale anchor fails silently.
  assert.throws(() => anchorFor({ getLayer: () => true }, 'campus-paths'), /campus-paths/);
});

test('every anchor named in the source is in the list', () => {
  // anchorFor throws on an unknown id, but only once that line runs in a
  // browser. Reading the calls out of the source catches a typo here.
  const dir = path.join(root, 'src');
  const named = readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .flatMap((name) => [...readFileSync(path.join(dir, name), 'utf8')
      .matchAll(/anchorFor\(map, '([^']+)'\)/g)].map((m) => [name, m[1]]));
  assert.ok(named.length >= 10, `only ${named.length} anchored layers found`);
  for (const [file, id] of named) assert.ok(CAMPUS_STACK.includes(id), `${file}: ${id}`);
});

test('the list names each layer once', () => {
  assert.equal(new Set(CAMPUS_STACK).size, CAMPUS_STACK.length);
});
