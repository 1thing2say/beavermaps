// src/campus-sheet.js — the printed sheet, drawn at the size things are.
//
// `groundWidth` converts METRES ON THE GROUND into pixels at a zoom, through a
// constant that is a property of the Web Mercator projection at this campus's
// latitude. That is arithmetic with a right answer, and it was buried in the
// middle of a seven-thousand-line file where nothing could ask it anything.
//
// `sheetBands` is the third: it cuts the sheet into the bands that put the
// print's painter's order back between layers, and the tests below hold the
// data to the shape that cut assumes and evaluate the real layer filters
// against every feature — the only way to know a band neither drops a shape
// nor draws it twice without opening a browser.
//
// The route's width curves are held against the network's here too, since
// the network's are the ones the sheet's walks constrain, and `markRoofed` —
// the cut that keeps the network off the roofs over imagery, where the sheet's
// buildings are not drawn to hide it — is checked against the real footprints.
//
// `closedBearing` is the other one: it reads the grain of a shape out of a
// generated artifact, so that a rebuild which nudges the geometry cannot leave
// a hard-coded angle quietly wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  M_PER_PIXEL_AT_Z0, CLOSED_KIND, CLOSED_TEXT, CLOSED_RED, CLOSED_INK, closedBearing,
  PAVEMENT_KINDS, SHEET_LAYERS, sheetBands, bandFilters, createCampusSheet,
} from '../src/campus-sheet.js';
import { CAMPUS_STACK } from '../src/layer-order.js';
import {
  NETWORK_WIDTH, NETWORK_CASING_WIDTH, ROUTE_WIDTH, ROUTE_CASING_WIDTH, ROUTE_LEGS_WIDTH,
  markRoofed, networkFilter, createRouteLayers,
} from '../src/route-layers.js';
import { trimToCampus, ringOf, M_PER_LON, M_PER_LAT } from '../src/campus-clip.js';
import { LOOKS, SATELLITE } from '../src/palette.js';
import { load, contrast } from './helpers.js';

test('the metres-per-pixel constant is Web Mercator at this latitude, in 512 px tiles', () => {
  // 40075016.686 m of equator / 512 px at z0, times cos(38.65°). FIVE hundred
  // and twelve: Mapbox GL's zoom 0 is one 512 px tile, not the 256 px one the
  // textbook figure assumes. This test used to divide by 256 and so held the
  // constant to the value that drew every stroke at half its width.
  const equator = 40075016.686 / 512;
  const here = equator * Math.cos((38.64916 * Math.PI) / 180);
  assert.ok(Math.abs(M_PER_PIXEL_AT_Z0 - here) / here < 0.005,
    `${M_PER_PIXEL_AT_Z0} is not ${here.toFixed(0)} — the projection or the latitude moved`);
});

test('the constant agrees with the map it is drawn on', () => {
  // The measurement the 512 came from, kept as a number: on the live map,
  // map.project put 100 m at 428.8 px at z18 over this campus. A constant
  // built for the wrong tile size is out by exactly 2x and fails this by a
  // mile; the 1% allows for where on campus the 100 m was laid.
  const pxPer100m = 100 * (2 ** 18 / M_PER_PIXEL_AT_Z0);
  assert.ok(Math.abs(pxPer100m - 428.8) / 428.8 < 0.01, `${pxPer100m.toFixed(1)} px per 100 m at z18`);
});

test('a path drawn at its true width is a sane number of pixels', () => {
  // The sheet's default path is 1.65 m across. At z18 that should be a few
  // pixels — visible, not a motorway. This is the check that catches a units
  // slip in either direction.
  const metres = 1.65;
  const pixelsAt = (zoom) => metres * (2 ** zoom / M_PER_PIXEL_AT_Z0);

  // 7.1 px with the 512 px constant; it was 3.5 when it was half.
  assert.ok(pixelsAt(18) > 5 && pixelsAt(18) < 12, `${pixelsAt(18).toFixed(1)}px at z18`);
  assert.ok(pixelsAt(20) > pixelsAt(18), 'it does not grow with zoom');
  // At campus overview the true width is below a pixel, which is exactly why
  // groundWidth takes a floor.
  assert.ok(pixelsAt(14) < 1, `${pixelsAt(14).toFixed(2)}px at z14 — the floor is unused`);
});

test('the closed block names itself the same way in both halves', () => {
  // One is a `kind` on the sheet, the other is the word drawn over it. They are
  // deliberately different strings, and pin-state.js needs the second to keep
  // that label out of the printed set.
  assert.equal(CLOSED_KIND, 'closed');
  assert.equal(CLOSED_TEXT, 'Closed');
});

test('the closed red is one hue, and its ink is legible on both themes', () => {
  // The wash, hatch and outline are the same hue at three opacities, so the
  // shape reads as one object. The TEXT cannot join them — it has to stay
  // legible as type.
  assert.match(CLOSED_RED, /^#[0-9a-f]{6}$/i);
  assert.ok(contrast(CLOSED_INK.light, '#ffffff') > 3.5, 'the light-theme ink is too pale');
  assert.ok(contrast(CLOSED_INK.dark, '#111111') > 3.5, 'the dark-theme ink is too dark');
});

test('the bearing is read off the real geometry', () => {
  const basemap = load('basemap');
  const shape = basemap.features.find((f) => f.properties.kind === CLOSED_KIND);
  if (!shape) return;   // the sheet no longer carries one; nothing to prove

  const angle = closedBearing(basemap);
  assert.ok(Number.isFinite(angle), `${angle}`);
  // Normalised to the half-turn that reads left to right, so the word is never
  // upside down whichever way round the ring was wound.
  assert.ok(angle > -90 && angle <= 90, `${angle}° would set the word upside down`);
});

test('the block really is on the diagonal, which is why this exists at all', () => {
  // The label was setting horizontally and crossing two of its edges.
  const basemap = load('basemap');
  if (!basemap.features.some((f) => f.properties.kind === CLOSED_KIND)) return;
  assert.notEqual(Math.round(closedBearing(basemap)), 0, 'the shape is axis-aligned now');
});

test('no closed block means no rotation, not a crash', () => {
  // A generated artifact that stops carrying one must not take the label layer
  // down with it.
  assert.equal(closedBearing(null), 0);
  assert.equal(closedBearing(undefined), 0);
  assert.equal(closedBearing({ features: [] }), 0);
  assert.equal(closedBearing({ features: [{ properties: { kind: 'closed' }, geometry: null }] }), 0);
});

test('a degenerate ring has no grain', () => {
  const twoPoints = {
    features: [{
      properties: { kind: CLOSED_KIND },
      geometry: { coordinates: [[[-121.3, 38.6], [-121.3, 38.6]]] },
    }],
  };
  assert.equal(closedBearing(twoPoints), 0);
});

test('the longest edge is the one that decides it', () => {
  // A wide, short rectangle lies east-west; the word should set flat along it.
  const flat = {
    features: [{
      properties: { kind: CLOSED_KIND },
      geometry: {
        coordinates: [[
          [-121.3500, 38.6500], [-121.3480, 38.6500],
          [-121.3480, 38.6502], [-121.3500, 38.6502], [-121.3500, 38.6500],
        ]],
      },
    }],
  };
  assert.ok(Math.abs(closedBearing(flat)) < 1, `${closedBearing(flat)}° on an east-west block`);
});

// --- the bands ----------------------------------------------------------------

/**
 * Just enough of Mapbox's expression language to run the sheet's own filters.
 *
 * Only the operators the sheet uses; an unknown one throws rather than being
 * guessed at, so a filter that grows a new operator fails here loudly instead
 * of being evaluated as something it is not.
 */
function evaluate(expr, props) {
  if (!Array.isArray(expr)) return expr;
  const [op, ...args] = expr;
  const ev = (e) => evaluate(e, props);
  switch (op) {
    case 'all': return args.every((a) => ev(a));
    case 'any': return args.some((a) => ev(a));
    case '!': return !ev(args[0]);
    case '<': return ev(args[0]) < ev(args[1]);
    case '>=': return ev(args[0]) >= ev(args[1]);
    case '==': return ev(args[0]) === ev(args[1]);
    case '!=': return ev(args[0]) !== ev(args[1]);
    case 'get': return props[args[0]];
    case 'has': return args[0] in props;
    case 'literal': return args[0];
    case 'to-boolean': return Boolean(ev(args[0]));
    case 'coalesce': return args.map(ev).find((v) => v != null) ?? null;
    case 'in': return ev(args[1]).includes(ev(args[0]));
    case 'match': {
      const input = ev(args[0]);
      for (let n = 1; n + 1 < args.length; n += 2) {
        const labels = Array.isArray(args[n]) ? args[n] : [args[n]];
        if (labels.includes(input)) return ev(args[n + 1]);
      }
      return ev(args.at(-1));
    }
    default: throw new Error(`the test evaluator does not know '${op}'`);
  }
}

/** A map that records layers in the order Mapbox would stack them. */
function fakeMap() {
  const order = [];
  const layers = new Map();
  const sources = new Map();
  return {
    order,
    layers,
    getLayer: (id) => layers.get(id),
    getSource: (id) => sources.get(id),
    addSource: (id, source) => { sources.set(id, source); },
    addLayer(layer, before) {
      if (layers.has(layer.id)) throw new Error(`${layer.id} added twice`);
      if (before !== undefined && !layers.has(before)) throw new Error(`no layer ${before}`);
      layers.set(layer.id, layer);
      order.splice(before === undefined ? order.length : order.indexOf(before), 0, layer.id);
    },
    removeLayer(id) { layers.delete(id); order.splice(order.indexOf(id), 1); },
    setPaintProperty(id, property, value) {
      const layer = layers.get(id);
      if (!layer) throw new Error(`no layer ${id}`);
      layer.paint[property] = value;
    },
  };
}

/** Which of the sheet's layers draw this feature, given the layers as added. */
function layersDrawing(feature, map) {
  return SHEET_LAYERS
    .filter((id) => id !== 'campus-rake')
    .filter((id) => evaluate(map.getLayer(id).filter, feature.properties));
}

const sheetOnMap = () => {
  const basemap = load('basemap');
  const map = fakeMap();
  createCampusSheet({ map, litPalette: () => LOOKS.classic.light, sheet: () => basemap }).add();
  return { basemap, map };
};

test('the cuts are read off the sheet, and the sheet is the shape they assume', () => {
  const basemap = load('basemap');
  const { canopy, upper } = sheetBands(basemap);
  const features = basemap.features.map((f) => f.properties);

  const trees = features.filter((p) => p.kind === 'tree' && p.fill);
  const buildings = features.filter((p) => ['building', CLOSED_KIND].includes(p.kind) && p.fill);
  assert.equal(canopy, Math.min(...trees.map((p) => p.i)), 'the canopy starts at the first tree');
  assert.equal(upper, Math.min(...buildings.map((p) => p.i)), 'the buildings start at the first building');
  assert.ok(canopy < upper, `canopy ${canopy} is not before the buildings at ${upper}`);

  // Between the cuts there is canopy and nothing else. A stroke in there would
  // be drawn over the network; a fill that is not a tree would be drawn under it.
  const between = features.filter((p) => p.i >= canopy && p.i < upper);
  assert.deepEqual([...new Set(between.map((p) => p.kind))], ['tree']);
  assert.equal(between.filter((p) => p.stroke).length, 0, 'a stroke between the cuts');
});

test('every shape the sheet draws is in exactly one band', () => {
  const { basemap, map } = sheetOnMap();
  const fills = ['campus-sheet-fill', 'campus-sheet-canopy', 'campus-sheet-upper-fill'];
  const lines = ['campus-sheet-line', 'campus-sheet-upper-line'];
  let drawn = 0;
  for (const feature of basemap.features) {
    const hits = layersDrawing(feature, map);
    // At most one fill layer and at most one line layer: a feature with both a
    // fill and a stroke is drawn once as each, never twice as either.
    assert.ok(hits.filter((id) => fills.includes(id)).length <= 1, `${feature.properties.i} in ${hits}`);
    assert.ok(hits.filter((id) => lines.includes(id)).length <= 1, `${feature.properties.i} in ${hits}`);
    if (hits.length) drawn += 1;
  }
  // And the bands lose nothing the single pair of layers drew: the old two
  // filters, with no band clause, select exactly the same features.
  const old = (p) => {
    const layer = (id) => map.getLayer(id).filter.slice(0, -1);
    return evaluate(layer('campus-sheet-fill'), p) || evaluate(layer('campus-sheet-line'), p);
  };
  assert.equal(drawn, basemap.features.filter((f) => old(f.properties)).length);
});

test('the print\'s order holds between layers: no pavement over a building', () => {
  // The defect this replaced: one fill layer under one line layer put all
  // 449 m of pavement my campus ran under its roofs on TOP of them.
  const { basemap, map } = sheetOnMap();
  const rank = (id) => CAMPUS_STACK.indexOf(id);
  const where = (kinds, paint) => basemap.features
    .filter((f) => kinds.includes(f.properties.kind) && f.properties[paint])
    .flatMap((f) => layersDrawing(f, map));

  const pavement = where(PAVEMENT_KINDS, 'stroke');
  const roofs = where(['building', CLOSED_KIND], 'fill');
  const network = rank('network-casing');
  assert.ok(pavement.length > 100 && roofs.length > 90);
  for (const id of pavement) assert.ok(rank(id) < network, `pavement drawn by ${id}, over the network`);
  for (const id of roofs) assert.ok(rank(id) > network, `a building drawn by ${id}, under the network`);
  // ...and the trees between: over the walkways, as the print has them, and
  // under the network, so a path under a canopy is still a path on the map.
  for (const id of where(['tree'], 'fill')) {
    assert.equal(id, 'campus-sheet-canopy');
    assert.ok(rank(id) > rank('campus-sheet-line') && rank(id) < network);
  }
});

test('the sheet stacks itself in list order, and recolours or removes all of itself', () => {
  const { map } = sheetOnMap();
  assert.deepEqual(map.order, CAMPUS_STACK.filter((id) => map.getLayer(id)));
  assert.deepEqual([...map.order].sort(), [...SHEET_LAYERS].sort());

  // A theme change repaints every band in place rather than only the first.
  const sheet = createCampusSheet({ map, litPalette: () => LOOKS.classic.dark, sheet: () => load('basemap') });
  sheet.add();
  for (const id of map.order) {
    const paint = map.getLayer(id).paint;
    const colour = JSON.stringify(paint['fill-color'] ?? paint['line-color']);
    assert.ok(colour.includes(LOOKS.classic.dark.land.lawn) || id === 'campus-rake' || id.endsWith('line'),
      `${id} kept the light palette`);
  }
  // Over imagery there is no sheet at all — every band of it goes.
  createCampusSheet({ map, litPalette: () => ({}), sheet: () => load('basemap') }).add();
  assert.deepEqual(map.order, []);
});

test('a sheet with nothing standing on it is all ground', () => {
  const flat = { features: [{ properties: { i: 1, kind: 'lawn', fill: '#0f0' } }] };
  const { canopy, upper } = sheetBands(flat);
  assert.ok(Number.isFinite(canopy) && Number.isFinite(upper), 'a style is JSON; it has no Infinity');
  const bands = bandFilters({ canopy, upper });
  assert.equal(evaluate(bands.ground, flat.features[0].properties), true);
  assert.equal(evaluate(bands.canopy, flat.features[0].properties), false);
  assert.equal(sheetBands(null).upper, upper);
});

// --- the ribbon on the pavement ----------------------------------------------

/** A zoom-only `interpolate` curve, evaluated the way Mapbox does. */
function atZoom([, [kind, base], , ...stops], zoom) {
  assert.equal(kind, 'exponential');
  for (let n = 0; n + 3 < stops.length; n += 2) {
    const [z0, v0, z1, v1] = stops.slice(n, n + 4);
    if (zoom > z1) continue;
    const t = base === 1 ? (zoom - z0) / (z1 - z0) : (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1);
    return v0 + (v1 - v0) * Math.max(0, t);
  }
  return stops.at(-1);
}

test('the network rides inside the narrowest pavement once that is drawn true', () => {
  // The walks are drawn at their real width now, so the ribbon traced along
  // them has a real width to fit in: 3.3 m, the narrowest pavement there is
  // bar the one walk the sheet gives no width.
  // From where the pixel curve hands over, neither the core nor the casing may
  // be wider than that — wider, and the network spills off its own path onto
  // the lawn either side.
  const metres = (px, zoom) => px * (M_PER_PIXEL_AT_Z0 / 2 ** zoom);
  for (let zoom = 17.5; zoom <= 22; zoom += 0.25) {
    const casing = metres(atZoom(NETWORK_CASING_WIDTH, zoom), zoom);
    const core = metres(atZoom(NETWORK_WIDTH, zoom), zoom);
    assert.ok(casing < 3.3, `casing ${casing.toFixed(2)} m at z${zoom}`);
    assert.ok(core < casing, `core wider than its casing at z${zoom}`);
  }
  // ...and from z18 it holds its ground width rather than thinning to a
  // centre stripe down a path that keeps getting wider on screen.
  const at18 = metres(atZoom(NETWORK_WIDTH, 18), 18);
  for (const zoom of [19, 20, 21, 22]) {
    assert.ok(Math.abs(metres(atZoom(NETWORK_WIDTH, zoom), zoom) - at18) < 0.01, `z${zoom}`);
  }
});

test('...and inside the walk as the sheet actually DRAWS it, to the zoom ceiling', () => {
  // The test above holds the ribbon to a constant 3.3 m, which is only the
  // truth if the sheet's own stroke is drawn at 3.3 m at that zoom. It was not:
  // its width curve stopped at z20 and Mapbox clamps past the last stop, so
  // from there the walk froze at 57 px while the ribbon kept doubling, and at
  // z22 a 176 px casing sat on a 57 px walk. So evaluate the real layer's
  // line-width for a real 3.3 m walkway, in pixels, against the ribbon in
  // pixels — the comparison the screen makes.
  const map = fakeMap();
  createCampusSheet({ map, litPalette: () => LOOKS.classic.light, sheet: () => load('basemap') }).add();
  const width = map.getLayer('campus-sheet-line').paint['line-width'];
  const walk = { kind: 'walkway', width: 3.3 };
  // groundWidth's stops are ['max', floor, ['*', SHEET_WIDTH, k]]; resolve
  // each for this one feature, then interpolate as Mapbox would.
  const resolve = (e) => {
    if (!Array.isArray(e)) return e;
    if (e[0] === 'max') return Math.max(...e.slice(1).map(resolve));
    if (e[0] === '*') return e.slice(1).map(resolve).reduce((a, b) => a * b, 1);
    if (e[0] === 'case') return e[1][2] === walk.kind ? e[2] : resolve(e[3]);
    if (e[0] === 'coalesce') return walk.width;
    throw new Error(`unexpected ${e[0]}`);
  };
  const [head, curve, input, ...stops] = width;
  const sheetPx = [head, curve, input, ...stops.map((s, n) => (n % 2 ? resolve(s) : s))];
  for (let zoom = 17.5; zoom <= 22; zoom += 0.25) {
    const walkPx = atZoom(sheetPx, zoom);
    const truePx = 3.3 * (2 ** zoom / M_PER_PIXEL_AT_Z0);
    assert.ok(Math.abs(walkPx - truePx) / truePx < 0.001,
      `the 3.3 m walk is drawn ${walkPx.toFixed(1)} px at z${zoom}, its true width is ${truePx.toFixed(1)}`);
    assert.ok(atZoom(NETWORK_CASING_WIDTH, zoom) < walkPx,
      `casing ${atZoom(NETWORK_CASING_WIDTH, zoom).toFixed(1)} px on a ${walkPx.toFixed(1)} px walk at z${zoom}`);
  }
});

// --- the route over the ribbon -----------------------------------------------

test('the route stays over the network ribbon at every zoom', () => {
  // The ribbon is a ground width from z18 and doubles with every zoom; a route
  // left in pixels became a thin thread inside it — a 12 px casing on a 176 px
  // ribbon at z22. Evaluated as Mapbox would, every quarter zoom from overview
  // to the ceiling: the route's casing at least as wide as the network's, so
  // where a route runs the ribbon under it is covered edge to edge.
  for (let zoom = 14; zoom <= 22; zoom += 0.25) {
    const routeCasing = atZoom(ROUTE_CASING_WIDTH, zoom);
    const routeLine = atZoom(ROUTE_WIDTH, zoom);
    const networkCasing = atZoom(NETWORK_CASING_WIDTH, zoom);
    assert.ok(routeCasing >= networkCasing,
      `route casing ${routeCasing.toFixed(1)} px under a ${networkCasing.toFixed(1)} px ribbon at z${zoom}`);
    assert.ok(routeLine < routeCasing, `the line overflows its casing at z${zoom}`);
    assert.ok(atZoom(ROUTE_LEGS_WIDTH, zoom) <= routeLine, `the legs outweigh the line at z${zoom}`);
    // ...and once both are ground widths, the blue clears the white core too,
    // so no white shows either side of it.
    if (zoom >= 19) {
      const core = atZoom(NETWORK_WIDTH, zoom);
      assert.ok(routeLine > core, `route line ${routeLine.toFixed(1)} px inside a ${core.toFixed(1)} px core at z${zoom}`);
    }
  }
});

test('...without changing below z18, or swamping the walk above it', () => {
  // The look the route has always had, at every zoom it has always been seen.
  for (const zoom of [14, 15, 16, 17, 18]) {
    assert.equal(atZoom(ROUTE_CASING_WIDTH, zoom), 12, `casing at z${zoom}`);
    assert.equal(atZoom(ROUTE_WIDTH, zoom), 6, `line at z${zoom}`);
    assert.equal(atZoom(ROUTE_LEGS_WIDTH, zoom), 5, `legs at z${zoom}`);
  }
  // From z19 the casing holds the narrowest pavement's 3.3 m and no more: wide
  // enough to cover the ribbon, not so wide that a route along a wall eats
  // into the roof beside it.
  const metres = (px, zoom) => px * (M_PER_PIXEL_AT_Z0 / 2 ** zoom);
  for (let zoom = 19; zoom <= 22; zoom += 0.25) {
    const casing = metres(atZoom(ROUTE_CASING_WIDTH, zoom), zoom);
    assert.ok(Math.abs(casing - 3.3) < 0.01, `casing ${casing.toFixed(2)} m at z${zoom}`);
  }
});

// --- the network over imagery ------------------------------------------------

/** Flat metres along a line. */
const lengthOf = (c) => c.slice(1)
  .reduce((sum, p, n) => sum + Math.hypot((p[0] - c[n][0]) * M_PER_LON, (p[1] - c[n][1]) * M_PER_LAT), 0);

test('markRoofed cuts a line at the walls and marks only the piece under the roof', () => {
  // A 10 m square with a 4 m courtyard, and a line straight through both.
  const d = 1e-5;
  const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const sheet = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { kind: 'building', i: 2000 },
      geometry: { type: 'Polygon', coordinates: [square(0, 0, 10 * d, 10 * d), square(3 * d, 3 * d, 7 * d, 7 * d)] },
    }, {
      // A lawn is not a roof, whatever it covers.
      type: 'Feature',
      properties: { kind: 'lawn', i: 3 },
      geometry: { type: 'Polygon', coordinates: [square(-50 * d, -50 * d, 50 * d, 50 * d)] },
    }],
  };
  const line = (coordinates, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } });
  const network = {
    type: 'FeatureCollection',
    features: [
      line([[-5 * d, 5 * d], [15 * d, 5 * d]], { from: 'a' }),
      line([[-5 * d, 20 * d], [15 * d, 20 * d]]),
    ],
  };
  const out = markRoofed(network, sheet);
  const through = out.features.filter((f) => f.properties.from === 'a');
  // Outside, wall, courtyard, wall, outside: five pieces, two of them roofed.
  assert.deepEqual(through.map((f) => f.properties.roofed), [false, true, false, true, false]);
  const xs = through.map((f) => f.geometry.coordinates.map(([x]) => Math.round(x / d)));
  assert.deepEqual(xs, [[-5, 0], [0, 3], [3, 7], [7, 10], [10, 15]]);
  // The line clear of the building comes back as it went in.
  const clear = out.features.at(-1);
  assert.equal(clear.properties.roofed, false);
  assert.equal(clear.geometry, network.features[1].geometry);
  // No sheet yet: nothing is marked, everything is still drawn.
  assert.ok(markRoofed(network, null).features.every((f) => f.properties.roofed === false));
  assert.equal(markRoofed(null, sheet), null);
});

test('over imagery the network leaves out what runs under a roof, and only there', () => {
  // On the shipped data, through the same trim main.js applies. Not a fixed
  // number of metres — paths.json is rebuilt by the walk-network script — but
  // the properties that make the drawing right: nothing lost, nothing added,
  // and the marked pieces exactly the ones under a building.
  const ring = ringOf(load('campus-boundary'));
  const network = trimToCampus(load('paths'), ring);
  const sheet = trimToCampus(load('basemap'), ring);
  const out = markRoofed(network, sheet);
  const total = (features) => features.reduce((sum, f) => sum + lengthOf(f.geometry.coordinates), 0);
  assert.ok(Math.abs(total(out.features) - total(network.features)) < 0.01, 'the cut changed the length of the network');

  const roofs = sheet.features.filter((f) => ['building', 'closed'].includes(f.properties.kind));
  const inRing = ([x, y], r) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) {
      if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    }
    return inside;
  };
  const underRoof = (p) => roofs.some(({ geometry: g }) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)
    .some(([outer, ...yards]) => inRing(p, outer) && !yards.some((y) => inRing(p, y))));
  for (const f of out.features) {
    const c = f.geometry.coordinates;
    for (let n = 1; n < c.length; n += 1) {
      const mid = [(c[n - 1][0] + c[n][0]) / 2, (c[n - 1][1] + c[n][1]) / 2];
      assert.equal(underRoof(mid), f.properties.roofed, `a piece of ${f.properties.from}-${f.properties.to} is marked wrong`);
    }
  }
  // The walls stage keeps some passages under roofs; if it ever keeps none,
  // this whole mechanism is idle and the test above proves nothing.
  assert.ok(out.features.some((f) => f.properties.roofed), 'nothing under a roof to hide');

  // The filter: drawn whole over the sheet, roofed pieces out over imagery.
  for (const look of [LOOKS.classic.light, LOOKS.classic.dark, LOOKS.apple.light, LOOKS.apple.dark]) {
    assert.equal(networkFilter(look), null);
  }
  const imagery = networkFilter(SATELLITE);
  assert.equal(evaluate(imagery, { roofed: true }), false);
  assert.equal(evaluate(imagery, { roofed: false }), true);
});

test('the imagery filter lands on both network layers and never on the route', () => {
  const map = fakeMap();
  const filters = new Map();
  map.setFilter = (id, filter) => {
    if (!map.getLayer(id)) throw new Error(`no layer ${id}`);
    filters.set(id, filter);
  };
  let colors = LOOKS.classic.light;
  const layers = createRouteLayers({
    map,
    litPalette: () => colors,
    provider: () => 'mapbox',
    boundary: { type: 'FeatureCollection', features: [] },
    network: () => null,
    sheet: () => null,
    route: { feature: () => ({ type: 'FeatureCollection', features: [] }), legs: () => ({ type: 'FeatureCollection', features: [] }) },
    from: () => undefined,
    to: () => undefined,
  });
  layers.addNetworkAndRoute();
  assert.equal(filters.get('network-casing'), null);
  assert.equal(filters.get('network-lines'), null);
  // A swap to imagery that does not reload the style re-runs the builder over
  // standing layers; the filter has to follow it there too.
  colors = SATELLITE;
  layers.addNetworkAndRoute();
  assert.deepEqual(filters.get('network-casing'), networkFilter(SATELLITE));
  assert.deepEqual(filters.get('network-lines'), networkFilter(SATELLITE));
  for (const id of ['route-legs', 'route-casing', 'route-line']) {
    assert.ok(!filters.has(id), `${id} was filtered`);
    assert.equal(map.getLayer(id).filter, undefined, `${id} carries a filter`);
  }
});
