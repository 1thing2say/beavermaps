// src/directory.json — one entry per building, joining the footprints, what the
// printed sheet calls them, and which of my campus's destinations are inside.
//
// This file is a join of three others, so what it can get wrong is agreement:
// a building named one way on the map and another in its card, an entrance that
// is not on the graph, or an anchor that floats outside the walls it belongs to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, pointInRing, vertexKey } from './helpers.js';

const directory = load('directory').features;

const inAnyPart = (coords, feature) =>
  feature.geometry.coordinates.some(([ring]) => pointInRing(coords, ring));

test('one entry per building, none repeated', () => {
  assert.ok(directory.length > 20, `only ${directory.length} buildings`);
  const seen = new Set();
  for (const f of directory) {
    assert.ok(f.properties.officialName, 'a building has no my campus name');
    assert.ok(!seen.has(f.properties.officialName), `${f.properties.officialName} appears twice`);
    seen.add(f.properties.officialName);
    assert.equal(f.geometry.type, 'MultiPolygon');
  }
});

// The Health Education Complex is nine footprints and the Portable Village
// seven. If grouping stops working they arrive as separate buildings, each
// holding a fraction of the directory.
test('multi-footprint buildings stay whole', () => {
  const grouped = directory.filter((f) => f.properties.footprints > 1);
  assert.ok(grouped.length >= 3, `only ${grouped.length} buildings have several footprints`);
  for (const f of grouped) {
    assert.equal(f.geometry.coordinates.length, f.properties.footprints,
      `${f.properties.officialName} claims ${f.properties.footprints} footprints`);
  }
});

/**
 * The anchor is a pole of inaccessibility, and its whole reason for existing is
 * that a centroid does not have this property: my campus has L-shaped and U-shaped
 * footprints whose centroid falls on the lawn outside the walls, which would put
 * the card — and the label build-labels.mjs places the same way — next to the
 * building rather than on it.
 */
test('every anchor lies inside its own building', () => {
  for (const f of directory) {
    const { anchor, officialName } = f.properties;
    if (!anchor) continue;
    assert.ok(inAnyPart(anchor, f), `${officialName}'s anchor is outside its footprints`);
  }
});

test('every entrance is a real routing node', () => {
  const vertices = new Set();
  for (const segment of load('paths').features) {
    for (const coord of segment.geometry.coordinates) vertices.add(vertexKey(coord));
  }
  const routable = directory.filter((f) => f.properties.entrance);
  assert.ok(routable.length > 20, `only ${routable.length} buildings can be routed to`);
  for (const f of routable) {
    // The card's "Go here" sends this straight to the router. A coordinate that
    // is merely near the graph still routes, but to whatever the server snaps
    // to, which is how a destination quietly becomes the wrong building.
    assert.ok(vertices.has(vertexKey(f.properties.entrance)),
      `${f.properties.officialName}'s entrance is not on the network`);
  }
});

// Amenities are drawn as icons already. Listing them as destinations is what
// made the Gym's directory read "Defibrillator, Drink Vending Machine, Drink
// Vending Machine" — three entries, none of them somewhere you go.
test('amenities are counted apart from destinations', () => {
  const amenityNames = new Set(load('places').features
    .filter((f) => f.properties.kind === 'amenity_class')
    .map((f) => f.properties.name));

  for (const f of directory) {
    for (const entry of f.properties.contents ?? []) {
      assert.ok(!amenityNames.has(entry.name),
        `${f.properties.officialName} lists the amenity ${entry.name} as a destination`);
    }
    for (const facility of f.properties.facilities ?? []) {
      assert.ok(amenityNames.has(facility.name),
        `${f.properties.officialName} lists ${facility.name} as a facility`);
      assert.ok(facility.n === undefined || facility.n > 1, 'a count of one should be omitted');
    }
  }
});

// The card and the label are two views of the same building, and a person
// reading one and then the other should not think they are looking at two
// places. Both come from building-names.mjs for exactly this reason.
test('the card agrees with the label on the building', () => {
  const labels = load('labels').features
    .filter((f) => ['building', 'plate'].includes(f.properties.kind));

  let checked = 0;
  for (const f of directory) {
    const inside = labels.filter((l) => inAnyPart(l.geometry.coordinates, f));
    if (!inside.length) continue;
    checked += 1;
    const texts = inside.map((l) => l.properties.text);
    const { name, parts = [] } = f.properties;
    // Either the card is titled with one of them, or it names them all as parts
    // — the Gym holds Main Gym and Practice Gym and is titled neither.
    assert.ok(
      texts.includes(name) || texts.every((t) => parts.includes(t)),
      `${name} shows none of the labels printed on it: ${texts.join(', ')}`,
    );
  }
  assert.ok(checked > 10, `only ${checked} buildings carry a printed label`);
});
