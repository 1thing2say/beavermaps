// src/directory.json — one entry per building, joining the footprints, what the
// printed sheet calls them, and which of my campus's destinations are inside.
//
// This file is a join of three others, so what it can get wrong is agreement:
// a building named one way on the map and another in its card, an entrance that
// is not on the graph, or an anchor that floats outside the walls it belongs to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, pointInRing, vertexKey, metresBetween } from './helpers.js';

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

test('an entrance is a door where the building has one under its anchor', () => {
  // The walls stage records where each approach path drawn into a building met
  // its wall (src/doors.json). Where the footprint the card stands on has one,
  // the card's Directions goes there, and to the one nearest the anchor; it
  // used to go to whichever node lay nearest a wall corner, which put the
  // Library's entrance 31 m round the building from its one drawn path.
  const doors = load('doors').features;
  let atDoor = 0;
  for (const f of directory) {
    const { anchor, entrance, officialName } = f.properties;
    if (!anchor || !entrance) continue;
    const under = doors.filter((d) => pointInRing(anchor, d.geometry.coordinates[0])
      && f.geometry.coordinates.some(([ring]) => vertexKey(ring[0]) === vertexKey(d.geometry.coordinates[0][0])
        || pointInRing(anchor, ring)));
    const known = under.flatMap((d) => d.properties.stubs.flatMap((s) => s.doors));
    if (!known.length) continue;
    assert.ok(known.some((d) => vertexKey(d) === vertexKey(entrance)),
      `${officialName}'s entrance is not one of the doors of the footprint its card stands on`);
    const nearest = Math.min(...known.map((d) => metresBetween(anchor, d)));
    assert.ok(metresBetween(anchor, entrance) <= nearest + 1e-6,
      `${officialName}'s entrance is not the door nearest its anchor`);
    // And every door of that footprint, entrance first: the router takes any
    // of them as the end of a walk to the building. Where the walls come
    // nearest the network follows them (see the next test), never ahead.
    const listed = f.properties.doors ?? [];
    const drawn = new Set(known.map(vertexKey));
    assert.equal(vertexKey(listed[0] ?? []), vertexKey(entrance), `${officialName}'s doors do not lead with its entrance`);
    assert.deepEqual(new Set(listed.slice(0, drawn.size).map(vertexKey)), drawn,
      `${officialName}'s list does not start with the doors of the footprint its card stands on`);
    atDoor += 1;
  }
  assert.ok(atDoor >= 8, `only ${atDoor} buildings have their entrance at a door`);
});

test('every door drawn into any footprint of a building is one of its ways in', () => {
  // A building drawn as several footprints has a door wherever the sheet runs
  // an approach path into any of them, not only into the one its card stands
  // on. The directory used to list only that one's: Science & Engineering's
  // doors into its north wings and the Science annexe, and the CTE's into its
  // north wing, 4.7 m from the main building and 90 m from the anchor, were
  // listed nowhere, and walks to the building went round to the main door.
  // Joined the way build-directory.mjs joins them: by the outline both files
  // carry, at six decimals.
  const ringKey = (ring) => JSON.stringify(ring.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]));
  const owner = new Map();
  for (const f of directory) for (const [ring] of f.geometry.coordinates) owner.set(ringKey(ring), f);
  let checked = 0;
  for (const d of load('doors').features) {
    const f = owner.get(ringKey(d.geometry.coordinates[0]));
    if (!f) continue;
    const listed = new Set((f.properties.doors ?? []).map(vertexKey));
    for (const door of d.properties.stubs.flatMap((s) => s.doors)) {
      assert.ok(listed.has(vertexKey(door)), `${f.properties.officialName}'s door ${door} on sheet ${d.properties.i} is not among its ways in`);
      checked += 1;
    }
  }
  assert.ok(checked >= 30, `only ${checked} drawn doors checked`);
});

test('no way in lies inside another building', () => {
  // Where one building's walls come nearest the network can be inside another
  // building's footprint: the Pool's and Adaptive PE's were inside the Gym,
  // on a driveway the Gym is painted over, and a walk from the Gym to the Pool
  // was 2.4 m. Measured against the directory's own footprints.
  for (const f of directory) {
    for (const door of f.properties.doors ?? []) {
      const inside = directory.filter((g) => g !== f && inAnyPart(door, g) && !inAnyPart(door, f));
      assert.equal(inside.length, 0, `${f.properties.officialName}'s way in ${door} is inside ${inside.map((g) => g.properties.officialName).join(', ')}`);
    }
  }
});

test('every building is offered where its walls come nearest the network', () => {
  // A door the sheet does not draw is most likely where the network passes
  // closest to the building, and every walk this map gave before the walls
  // stage ended there. That point is on an edge, not necessarily at a vertex,
  // and the directory used to take the nearest VERTEX to a corner instead —
  // so when the build collapsed a straight run of vertices into one edge, the
  // Learning Resource Center's entrance jumped 53 m to the next corner whose
  // vertex survived, with the network still 0.3 m from where it had been.
  // Measured here on the edges, independently of the build's own helper: the
  // building's ways in must include a node within a weld of that point.
  const segments = load('paths').features.map((f) => f.geometry.coordinates);
  const nearestOn = (p) => {
    let best = null;
    for (const [a, b] of segments) {
      for (let k = 0; k <= 40; k += 1) {
        const q = [a[0] + (k / 40) * (b[0] - a[0]), a[1] + (k / 40) * (b[1] - a[1])];
        const d = metresBetween(p, q);
        if (!best || d < best.d) best = { d, q };
      }
    }
    return best;
  };
  const ends = new Map();
  for (const seg of segments) for (const c of seg) ends.set(String(c), (ends.get(String(c)) ?? 0) + 1);
  const degree = (d) => ends.get(String(d)) ?? 0;
  let offered = 0;
  for (const f of directory) {
    const { officialName, doors = [] } = f.properties;
    const corners = f.geometry.coordinates.flatMap((polygon) => polygon.flat());
    let wall = null;
    for (const corner of corners) {
      const near = nearestOn(corner);
      if (!wall || near.d < wall.d) wall = near;
    }
    if (!wall) continue;
    const by = Math.min(...doors.map((d) => metresBetween(d, wall.q)));
    // Bar a point on a drawn door's own approach: within APPROACH_M of a door
    // that ends a dead end, the door stands for it (build-directory.mjs), so
    // a walk is not ended a few steps short of the door it is walking to. The
    // Health Education Complex's walkway, cut at portable 1998's wall, passes
    // 0.6 m from the portable 6 m before it gets there.
    const approach = doors.some((d) => degree(d) === 1 && metresBetween(d, wall.q) <= 10);
    assert.ok(by <= 2.5 || approach, `${officialName}'s nearest way in is ${by.toFixed(1)} m from where its walls `
      + `come nearest the network, at ${wall.q.map((n) => n.toFixed(7))}`);
    offered += 1;
  }
  assert.ok(offered > 20, `only ${offered} buildings checked`);
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
