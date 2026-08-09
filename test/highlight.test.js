// src/highlight.js — the join behind the live legend.
//
// This decides which shapes light up when a legend row is pointed at, and every
// way it can be wrong is quiet. Claim a footprint twice and one building is
// painted at double strength. Widen the reach that lets a directory row attach
// to the shape it names and bike racks start being reported as indoors. Return
// nothing at all and the row simply looks like it does not work.
//
// So the numbers below are asserted rather than described. They were measured
// against the committed artifacts, and a change to any of the five files this
// reads should have to come past them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, pointInRing } from './helpers.js';
import {
  buildAreas, highlightFor, areaAt, areaCollection, pointCollection, extentOf,
  metresToArea, PLACE_REACH_M,
} from '../src/highlight.js';
import { CATEGORIES, CATEGORY_BY_ID } from '../src/categories.js';

const directory = load('directory');
const buildings = load('buildings');
const basemap = load('basemap');
const amenities = load('amenities');
const places = {
  type: 'FeatureCollection',
  // Same filter main.js applies on the way in: 14 of my campus's rows have no room
  // and therefore no geometry.
  features: load('places').features.filter((f) => f.geometry),
};

const zoneKinds = CATEGORIES.map((c) => c.zones).filter(Boolean);
const areas = buildAreas({ directory, buildings, basemap, zoneKinds });
const of = (id) => highlightFor(CATEGORY_BY_ID.get(id), { areas, amenities, places });

test('every footprint is an area, and none of them twice', () => {
  const zones = areas.filter((a) => a.kind === 'zone');
  const buildingAreas = areas.filter((a) => a.kind === 'building');

  // 96 footprints, 58 of them grouped into the directory's 30 named buildings.
  // If the identity test in buildAreas ever stops matching, this becomes 126
  // and the Health Education Complex gets outlined nine times over.
  assert.equal(buildingAreas.length, 30 + (96 - 58));
  assert.equal(
    buildingAreas.reduce((n, a) => n + a.polygons.length, 0),
    buildings.features.length,
    'every footprint should appear exactly once across the building areas',
  );

  // The sheet's car parks, minus the two `parking` LineStrings — aisle
  // markings, which have no inside to outline.
  assert.equal(zones.length, 22);
  assert.ok(zones.every((a) => a.sheet === 'parking'));
});

test('the buildings are searched before the car parks', () => {
  // The garage stands inside the sheet's parking surface, so a point in both
  // has to come back as the building or the outline lands on the tarmac.
  const garage = areas.findIndex((a) => a.name === 'Parking Garage');
  assert.ok(garage >= 0, 'the directory should name the garage');
  assert.ok(areas.slice(0, garage).every((a) => a.kind !== 'zone'));

  const inside = directory.features.find((f) => f.properties.name === 'Parking Garage');
  assert.equal(areaAt(inside.properties.anchor, areas), garage);
});

test('every legend row has something to show', () => {
  for (const category of CATEGORIES) {
    const { indices, points, counts } = of(category.id);
    assert.ok(
      indices.length + points.length > 0,
      `"${category.legend}" would light up nothing at all`,
    );
    assert.equal(counts.buildings + counts.zones, indices.length);
    assert.equal(counts.outside, points.length);
  }
});

test('the defibrillators are in six buildings and none outdoors', () => {
  // The row the whole feature was asked for. Six defibrillators, six buildings
  // — five my campus names and one it does not, which is the reason buildAreas keeps
  // the footprints the directory did not claim.
  const { indices, counts } = of('defibrillator');
  assert.deepEqual(counts, { buildings: 6, zones: 0, outside: 0 });
  assert.equal(indices.filter((i) => areas[i].name === null).length, 1);

  // And they are the buildings the points are actually in.
  const found = amenities.features
    .filter((f) => f.properties.kind === 'defibrillator')
    .map((f) => areaAt(f.geometry.coordinates, areas));
  assert.deepEqual([...new Set(found)].sort((a, b) => a - b), indices);
});

test('parking paints the ground, not the nine points my campus lists', () => {
  // Every car park on the sheet plus the garage, which is a building. Without
  // `zones` this row would outline the seven lots that happen to hold one of
  // my campus's destination nodes and leave fifteen car parks unmarked.
  const { counts } = of('parking');
  assert.deepEqual(counts, { buildings: 1, zones: 22, outside: 0 });
});

const gapTo = (coords) => Math.min(...areas.map((a) => metresToArea(coords, a)));

test('a rack in the open says so instead of being pulled into a wall', () => {
  const { points, counts } = of('bike');
  assert.equal(counts.outside, 13);

  // This is why amenity points get containment and nothing else. Those thirteen
  // racks stand between 1.8 m and 24.7 m from the nearest shape — a continuous
  // spread with no gap in it to cut at. PLACE_REACH_M's 5 m would already claim
  // one of them for a building it is merely bolted outside, and a reach wide
  // enough to catch the rest would claim nearly all of them.
  const gaps = points.map(gapTo).sort((a, b) => a - b);
  assert.ok(gaps[0] > 1 && gaps[0] < 2, `closest loose rack is ${gaps[0].toFixed(1)} m out`);
  assert.ok(gaps.at(-1) > 20, `furthest is only ${gaps.at(-1).toFixed(1)} m out`);
  assert.equal(gaps.filter((g) => g <= PLACE_REACH_M).length, 1);
  assert.ok(gaps.filter((g) => g <= 10).length > 8, 'the spread has a gap to cut at after all');
});

test('a directory row attaches to the shape it was placed against', () => {
  // These are routing nodes — my campus binds each destination to a vertex of the
  // walk network, which sits at the kerb rather than inside the lot.
  const lots = places.features.filter((f) => CATEGORY_BY_ID.get('parking').match(f.properties.name));
  assert.equal(lots.length, 9);

  const strays = lots.filter((f) => areaAt(f.geometry.coordinates, areas) === null);
  assert.equal(strays.length, 3, 'three of the nine sit just outside their shape');
  for (const stray of strays) {
    const gap = gapTo(stray.geometry.coordinates);
    assert.ok(gap < PLACE_REACH_M, `${stray.properties.name} is ${gap.toFixed(1)} m from anything`);
  }

  // The garage's node is one of the three, and the reach has to put it on the
  // garage rather than on the tarmac the garage stands in. Without it this row
  // outlines no building at all.
  const { indices, counts } = of('parking');
  assert.equal(counts.outside, 0);
  const [onlyBuilding] = indices.filter((i) => areas[i].kind === 'building');
  assert.equal(areas[onlyBuilding].name, 'Parking Garage');
});

test('the drawn shapes are the ones that were asked for', () => {
  const highlight = of('restrooms');
  const collection = areaCollection(areas, highlight.indices);

  assert.equal(collection.features.length, highlight.indices.length);
  assert.ok(collection.features.every((f) => f.geometry.type === 'MultiPolygon'));
  assert.ok(collection.features.every((f) => ['building', 'zone'].includes(f.properties.kind)));

  // Every restroom is indoors, so this row draws no loose points at all.
  assert.equal(pointCollection(highlight.points).features.length, 0);

  // Each outlined building really does contain one.
  const restrooms = amenities.features.filter((f) => f.properties.kind === 'restroom');
  for (const feature of collection.features) {
    const holds = restrooms.some((r) => feature.geometry.coordinates
      .some((rings) => pointInRing(r.geometry.coordinates, rings[0])));
    assert.ok(holds, `${feature.properties.name} was outlined with no restroom in it`);
  }
});

test('the extent covers the loose points as well as the shapes', () => {
  // The three bus stops are the case this exists for: two zones on campus and
  // a stop 84 m outside the nearest of them, so an extent taken from the
  // outlines alone would frame the map with a highlighted point off screen.
  const bus = of('bus');
  const [[west, south], [east, north]] = extentOf(areas, bus);

  for (const [lon, lat] of bus.points) {
    assert.ok(lon >= west && lon <= east && lat >= south && lat <= north);
  }
  assert.ok(east > west && north > south);
  assert.deepEqual(extentOf(areas, { indices: [], points: [] }), []);
});

test('a missing overlay costs its own areas and nothing else', () => {
  // Every collection is optional, the same bargain the rest of the overlays
  // make: a failed fetch is one layer lost, not a broken legend.
  const noSheet = buildAreas({ directory, buildings, zoneKinds });
  assert.ok(noSheet.every((a) => a.kind === 'building'));
  assert.equal(highlightFor(CATEGORY_BY_ID.get('parking'), {
    areas: noSheet, amenities, places,
  }).counts.zones, 0);

  const noDirectory = buildAreas({ buildings, basemap, zoneKinds });
  assert.equal(noDirectory.filter((a) => a.kind === 'building').length, 96);

  assert.deepEqual(buildAreas(), []);
  assert.deepEqual(highlightFor(CATEGORY_BY_ID.get('bike')), {
    indices: [], points: [], counts: { buildings: 0, zones: 0, outside: 0 },
  });
});
