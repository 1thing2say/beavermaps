// The credits on screen — who the map says it came from.
//
// Attribution is a licence term for every supplier this app draws: Google's
// tiles, OpenStreetMap's data and Mapbox's SDK. None of it is visible to a
// test that only looks at pixels on the happy path, and every one of these
// went missing at some point without anything else breaking: OSM's credit was
// simply absent under Google, the 3D flyover listed its sources in whatever
// order tiles happened to load, and Mapbox's wordmark was hidden by a rule in
// the stylesheet whenever Google drew the ground.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tileCredits } from '../src/google-tiles.js';
import { createRouteLayers, OSM_ATTRIBUTION } from '../src/route-layers.js';
import { LOOKS } from '../src/palette.js';
import { root } from './helpers.js';

// --- the 3D flyover's credit line -----------------------------------------

test('the flyover credits each source once per tile, most frequent first', () => {
  const line = tileCredits([
    'Google;Data SIO, NOAA, U.S. Navy, NGA, GEBCO;IBCAO',
    'Google;Landsat / Copernicus',
    'Google;Landsat / Copernicus',
    'Google',
  ]);
  // Google is on all four tiles, Landsat on two, the bathymetry on one each.
  assert.equal(line, 'Google; Landsat / Copernicus; Data SIO, NOAA, U.S. Navy, NGA, GEBCO; IBCAO');
});

test('a source named twice by one tile still counts for that tile once', () => {
  // Two tiles say Airbus; one tile says Maxar three times. Counted per mention,
  // Maxar would lead with 3 to 2 — but it covers half the ground Airbus does.
  const line = tileCredits(['Maxar;Maxar;Maxar', 'Airbus', 'Airbus']);
  assert.equal(line, 'Airbus; Maxar');
});

test('equal counts keep the order the tiles named them in', () => {
  // Stable, so two repaints of the same view never swap a pair of names.
  assert.equal(tileCredits(['B;A', 'A;B']), 'B; A');
});

test('tiles that say nothing leave the line empty for the caller to fill', () => {
  assert.equal(tileCredits([]), '');
  assert.equal(tileCredits([undefined, null, '', ' ; ']), '');
  // ...and whitespace around a source is not a different source.
  assert.equal(tileCredits(['Google ; Maxar', ' Google;Maxar ']), 'Google; Maxar');
});

// --- OpenStreetMap, on the sources drawn from it ------------------------------

/** Just enough of a map to record what each source was added with. */
function fakeMap() {
  const layers = new Map();
  const sources = new Map();
  return {
    sources,
    getLayer: (id) => layers.get(id),
    getSource: (id) => sources.get(id),
    addSource: (id, source) => { sources.set(id, { ...source, setData() {} }); },
    addLayer(layer) { layers.set(layer.id, layer); },
    removeLayer(id) { layers.delete(id); },
    setPaintProperty() {},
    setConfigProperty() {},
    setFilter() {},
  };
}

function build(provider, look) {
  const map = fakeMap();
  const route = createRouteLayers({
    map,
    litPalette: () => look,
    provider: () => provider,
    boundary: { type: 'FeatureCollection', features: [] },
    network: () => null,
    sheet: () => null,
    route: { feature: () => null, legs: () => null },
    from: () => undefined,
    to: () => undefined,
  });
  route.addMask();
  route.addNetworkAndRoute();
  return map;
}

test('under Google, the OSM-derived sources carry OpenStreetMap\'s credit', () => {
  // The campus boundary is OSM's college way; the route leaves the campus
  // along OSM's streets. Mapbox lists a source's attribution whenever a layer
  // is drawing from it, so this is what puts the credit on screen.
  const map = build('google', LOOKS.classic.light);
  assert.equal(map.sources.get('campus-boundary').attribution, OSM_ATTRIBUTION);
  assert.equal(map.sources.get('calculated-route').attribution, OSM_ATTRIBUTION);
});

test('under Mapbox they carry none, because the style already credits OSM', () => {
  const map = build('mapbox', LOOKS.classic.light);
  assert.equal(map.sources.get('campus-boundary').attribution, undefined);
  assert.equal(map.sources.get('calculated-route').attribution, undefined);
});

test('the OSM credit links to OSM\'s copyright page', () => {
  // The link is what OSM's guidelines require of the short form.
  assert.match(OSM_ATTRIBUTION, /href="https:\/\/www\.openstreetmap\.org\/copyright"/);
  assert.match(OSM_ATTRIBUTION, /© OpenStreetMap/);
  assert.match(OSM_ATTRIBUTION, /rel="noopener"/);
});

// --- Mapbox's wordmark --------------------------------------------------------

const css = readFileSync(path.join(root, 'src', 'input.css'), 'utf8');
/** The stylesheet's rules, with comments taken out so prose cannot match. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('nothing in the stylesheet hides the Mapbox wordmark', () => {
  // Mapbox's terms want the wordmark on any map their SDK draws, whoever's
  // data is on it, and the SDK licence ends when those terms are broken. This
  // was hidden under Google by two rules — the mark, and the wrapper it sits
  // in — and either one alone takes it off screen.
  for (const block of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = block;
    if (!/mapboxgl-ctrl-logo/.test(selector)) continue;
    assert.doesNotMatch(body, /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])/,
      `a rule hides the wordmark: ${selector.trim()}`);
    // Nor restyled: it is their artwork.
    assert.doesNotMatch(body, /filter\s*:|background-image\s*:/,
      `a rule repaints the wordmark: ${selector.trim()}`);
  }
});

test('on a phone the notice narrows beside the wordmark rather than dropping under it', () => {
  // A flex item wraps to the next line on its max-content width, and Google's
  // notice — the mark, the copyright, OSM's link — is 315px against the 264
  // beside the wordmark at 390, so at its natural basis the corner stacked
  // into a 63px block over the sheet. A zero basis keeps it on the row and
  // lets its own words wrap inside the pill.
  const phone = rules.slice(rules.indexOf('@media (max-width: 640px)'));
  const rule = phone.match(/\.mapboxgl-ctrl-bottom-left\s*>\s*\.mapboxgl-ctrl-attrib\s*\{([^}]*)\}/);
  assert.ok(rule, 'no phone rule sizes the notice inside the credit row');
  assert.match(rule[1], /flex\s*:\s*1\s+1\s+0(px|%)?\s*;/);
  // ...and never shrinks it past its own longest run, which would clip it.
  assert.doesNotMatch(rule[1], /min-width|overflow\s*:\s*hidden|text-overflow/);
});

test('Google\'s mark in the 2D credit is "Google Maps", not the G', () => {
  assert.match(rules, /\.mapboxgl-ctrl-attrib-inner::before\s*\{[^}]*content:\s*"Google Maps"/);
  assert.doesNotMatch(rules, /google-g\.svg/);
});
