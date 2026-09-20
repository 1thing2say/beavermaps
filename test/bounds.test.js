// The fence around the camera, held to the data it claims to describe.
//
// ROUTABLE_BOUNDS and CAMPUS_BOUNDS are hardcoded corners, and they have to be:
// maxBounds is wanted when the map is constructed, which is before
// /api/vertices has landed. CAMPUS_BOUNDS has carried a "regenerate paths.json
// and update this" comment since it was written.
//
// A constant answerable to a file nobody re-checks is a constant that goes
// quietly wrong. Same arrangement as REACH_M in test/directions.test.js: the
// number lives where it is needed and this is what keeps it honest.
//
// Both were consts in src/main.js, which has no exports and loads mapbox-gl and
// the DOM on import — so the first version of this file parsed them out of the
// source with a regex. They live in src/campus-bounds.js now and this imports
// them like anything else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMPUS_BOUNDS, ROUTABLE_BOUNDS } from '../src/campus-bounds.js';
import { load } from './helpers.js';

/** [[w, s], [e, n]] as named sides, which is how the assertions read. */
const sides = ([[west, south], [east, north]]) => ({ west, south, east, north });

const ROUTABLE = sides(ROUTABLE_BOUNDS);
const CAMPUS = sides(CAMPUS_BOUNDS);

function bboxOf(features) {
  const box = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  for (const feature of features) {
    for (const [lon, lat] of feature.geometry.coordinates) {
      box.west = Math.min(box.west, lon);
      box.east = Math.max(box.east, lon);
      box.south = Math.min(box.south, lat);
      box.north = Math.max(box.north, lat);
    }
  }
  return box;
}

const graphBox = bboxOf([...load('paths').features, ...load('approach-paths').features]);

const contains = (outer, inner) =>
  outer.west <= inner.west && outer.east >= inner.east
  && outer.south <= inner.south && outer.north >= inner.north;

test('the fence contains everything the router can route over', () => {
  // The failure this prevents is specific: a route that legitimately starts on
  // the pavement outside and runs in through a gate must be FRAMEABLE. Fenced
  // any tighter, the map cannot show the first half of a walk it just
  // calculated.
  assert.ok(contains(ROUTABLE, graphBox),
    `graph runs to [${graphBox.west}, ${graphBox.south}, ${graphBox.east}, ${graphBox.north}], `
    + `fence is [${ROUTABLE.west}, ${ROUTABLE.south}, ${ROUTABLE.east}, ${ROUTABLE.north}]`);
});

test('the fence contains the campus it opens on', () => {
  // fitBounds(CAMPUS_BOUNDS) against a maxBounds that did not contain it would
  // fight itself on the first frame.
  assert.ok(contains(ROUTABLE, CAMPUS));
});

test('the fence leaves framing margin around the routable area', () => {
  // frame() fits with padding, so a route touching the edge of the graph needs
  // somewhere for that padding to go. ~150 m is comfortably more than
  // FIT_MARGIN at any zoom this map uses.
  const METRES_PER_DEGREE_LAT = 111_320;
  const COS_LAT = Math.cos((38.6547 * Math.PI) / 180);
  const margins = {
    west: (graphBox.west - ROUTABLE.west) * METRES_PER_DEGREE_LAT * COS_LAT,
    east: (ROUTABLE.east - graphBox.east) * METRES_PER_DEGREE_LAT * COS_LAT,
    south: (graphBox.south - ROUTABLE.south) * METRES_PER_DEGREE_LAT,
    north: (ROUTABLE.north - graphBox.north) * METRES_PER_DEGREE_LAT,
  };
  for (const [side, metres] of Object.entries(margins)) {
    assert.ok(metres >= 150, `${side} margin is ${metres.toFixed(0)} m`);
  }
});

test('the fence is still a fence — it is one campus, not a city', () => {
  // The whole argument for maxTileCacheSize: 60 is that there is no long pan to
  // refetch. If this box ever grows to the size of Sacramento that argument is
  // gone and the tile bill is the thing that says so.
  const KM_PER_DEGREE = 111.32;
  const width = (ROUTABLE.east - ROUTABLE.west) * KM_PER_DEGREE * Math.cos((38.65 * Math.PI) / 180);
  const height = (ROUTABLE.north - ROUTABLE.south) * KM_PER_DEGREE;
  assert.ok(width < 6 && height < 6, `fence is ${width.toFixed(1)} x ${height.toFixed(1)} km`);
});

test('CAMPUS_BOUNDS is still the campus network it says it is', () => {
  // The comment on it says "Printed by scripts/build-walk-network.mjs —
  // regenerate paths.json and update this", which is a rule nothing enforced.
  const campusBox = bboxOf(load('paths').features);
  for (const side of ['west', 'south', 'east', 'north']) {
    assert.ok(Math.abs(CAMPUS[side] - campusBox[side]) < 1e-6,
      `CAMPUS_BOUNDS.${side} is ${CAMPUS[side]}, paths.json says ${campusBox[side]}`);
  }
});
