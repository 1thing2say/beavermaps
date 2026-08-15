// Who gets a helicopter shot.
//
// This is a judgment about my campus written as a table, and the thing that makes it
// worth testing is that its two hardest cases are invisible from the code: the
// Parking Garage and a surface car park arrive wearing the SAME `poi` disc, and
// "Baseball and Softball Field" is a directory building with a real footprint
// that is nonetheless a field. Both are separated by rules that a later edit to
// src/poi.js could quietly break without breaking anything on screen — the
// symptom would be a thirty-second orbit of a car park, which nobody sees until
// somebody taps it.
//
// Run against the real src/directory.json and src/labels.json rather than
// fixtures, so a building added to my campus's directory is a failure here if the
// hierarchy has nothing to say about it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';
import {
  tierOf, canFlyOver, framing, boxOf, footprintExtent, FLYOVER_TIER, MIN_AREA_M2, STALE_IMAGERY,
  M_PER_DEG_LAT, M_PER_DEG_LON,
} from '../src/flyover.js';
import { poiFor } from '../src/poi.js';

const buildings = load('directory').features;
const directory = buildings.map((f) => f.properties ?? f);
const labels = load('labels').features;

/** A directory row as showBuildingCard hands it to the hierarchy. */
const asCard = (row) => ({ ...row, poi: poiFor(row.name) });

test('the tiers are ordered, so >= SOLID means what it reads as', () => {
  assert.ok(FLYOVER_TIER.POINT < FLYOVER_TIER.FLAT);
  assert.ok(FLYOVER_TIER.FLAT < FLYOVER_TIER.SOLID);
});

test('every directory building is classified, and only the known cases are refused', () => {
  const refused = directory.filter((row) => !canFlyOver(asCard(row))).map((row) => row.name);
  // If this list grows, a real building stopped getting an aerial view.
  assert.deepEqual(refused.sort(), [
    'Baseball and Softball Field',      // a field, by name
    'Career Technical Education (CTE)', // stale imagery, see STALE_IMAGERY
  ]);
});

test('every stale-imagery entry names a building that actually exists', () => {
  // The whole value of that table is that it can be emptied when Google
  // reflies. An entry whose name no longer matches the directory is a refusal
  // that will never be lifted because nobody will ever notice it is dead.
  const names = new Set(directory.map((row) => row.name));
  for (const [name, reason] of STALE_IMAGERY) {
    assert.ok(names.has(name), `STALE_IMAGERY names "${name}", which is not in the directory`);
    assert.ok(reason?.length > 10, `"${name}" needs a reason worth reading`);
  }
});

test('the Parking Garage flies and a surface car park does not', () => {
  const garage = directory.find((row) => row.name === 'Parking Garage');
  assert.ok(garage, 'Parking Garage missing from the directory');

  // The whole point: identical disc, opposite answers, separated only by the
  // label kind my campus printed them with.
  assert.equal(poiFor(garage.name), 'parking');
  assert.equal(tierOf(asCard(garage)), FLYOVER_TIER.SOLID);

  for (const feature of labels.filter((f) => f.properties.kind === 'parking')) {
    const lot = { name: feature.properties.text, poi: 'parking', labelKind: 'parking' };
    assert.equal(tierOf(lot), FLYOVER_TIER.FLAT, `lot ${feature.properties.text} would fly`);
  }
});

test('no area name flies — those are my campus\'s own word for a piece of ground', () => {
  const areas = labels.filter((f) => f.properties.kind === 'area');
  assert.ok(areas.length === 5, `expected 5 area labels, found ${areas.length}`);
  for (const feature of areas) {
    const thing = { name: feature.properties.text, labelKind: 'area' };
    assert.equal(tierOf(thing), FLYOVER_TIER.FLAT, `${feature.properties.text} would fly`);
  }
});

test('a pool is refused however it is classified', () => {
  // Not on my campus's sheet today, and the rule has to hold if one is ever added —
  // it is the example the whole hierarchy was asked for.
  assert.equal(poiFor('Swimming Pool'), 'sport', 'poi.js no longer sends a pool to sport');
  assert.equal(tierOf({ name: 'Swimming Pool', poi: 'sport' }), FLYOVER_TIER.FLAT);
  // ...while the gym next to it, same disc, still flies.
  assert.equal(tierOf({ name: 'Gym', poi: 'sport', area_m2: 5403 }), FLYOVER_TIER.SOLID);
});

test('the last word decides, so a Field House is a building and a Field is not', () => {
  assert.equal(tierOf({ name: 'Field House', poi: 'sport', area_m2: 2000 }), FLYOVER_TIER.SOLID);
  assert.equal(tierOf({ name: 'Track and Field Center', poi: 'sport', area_m2: 2000 }),
    FLYOVER_TIER.SOLID);
  assert.equal(tierOf({ name: 'Softball Field', poi: 'sport', area_m2: 2000 }), FLYOVER_TIER.FLAT);
});

test('an amenity is a point and gets nothing', () => {
  for (const kind of ['defibrillator', 'bike_rack', 'emergency_phone', 'restroom']) {
    assert.equal(tierOf({ kind }), FLYOVER_TIER.POINT, `${kind} would fly`);
  }
});

test('the area floor sits in a gap rather than through a cluster', () => {
  // The claim made in the comment on MIN_AREA_M2, checked against the file: if
  // a smaller building is ever added, the floor stops being free.
  const areas = directory.map((row) => row.area_m2).sort((a, b) => a - b);
  assert.ok(areas[0] > MIN_AREA_M2,
    `smallest building is ${areas[0]} m2, at or under the ${MIN_AREA_M2} floor`);
});

test('framing pulls in for a small building and stops short for a large one', () => {
  const small = framing(200);
  const big = framing(50_000);
  assert.ok(small.span < big.span);
  // Both clamped, which is the part that matters: an unclamped span would orbit
  // Adaptive PE from 36 m and the Parking Garage from a quarter of a mile.
  assert.equal(small.span, 230);
  assert.equal(big.span, 800);
  // A missing footprint must still produce a usable camera rather than NaN.
  assert.ok(Number.isFinite(framing(undefined).span));
  assert.ok(framing().pitch > 0 && framing().pitch < 90);
});

test('the perimeter fits inside the frame and still holds the building', () => {
  // Two bounds, and the perimeter is only useful between them.
  //
  // Too wide and it never appears: at 0.5 spans of reach the square is exactly
  // the frame's width, so nothing is left over to draw grid in and the clip is
  // invisible. That is the bug this pair of assertions exists to catch — it
  // shipped once at 0.55 and read as a feature that did not work.
  //
  // Too narrow and it cuts the subject. `framing` holds BOX_MARGIN half-extents
  // of ground around the building, which puts a square one at four times its
  // width, so the square has to be wider than the footprint to contain it.
  //
  // This is the area-only path — no footprint — so `span / 4` is the building's
  // width by construction. The footprint path is checked properly in "no
  // building is cut by its own perimeter", against real geometry.
  for (const area of [173, 631, 5403, 8629, 50_000]) {
    const { span, reach } = framing(area);
    const buildingWidth = span / 4;
    assert.ok(reach * 2 < span * 0.8,
      `the square is ${((reach * 2) / span).toFixed(2)} spans — no room left for grid`);
    assert.ok(reach * 2 > buildingWidth * 1.2,
      `the square is ${((reach * 2) / buildingWidth).toFixed(2)}x the footprint — too tight`);
  }
});

test('no building is cut by its own perimeter', () => {
  // The regression this exists for, photographed before it was fixed: the clip
  // square was sized from sqrt(area) and centred on `anchor`, so it sliced the
  // east end off the Parking Garage — and off eight other buildings. Both
  // errors pushed the same way, which is why it read as one bug.
  //
  // Every corner of every footprint, against the square that building actually
  // gets. Corners rather than the bounding box because the square is axis
  // aligned and so is the test: if a corner is outside, a wall is missing.
  for (const feature of buildings) {
    const props = feature.properties;
    if (!canFlyOver(asCard(props))) continue;

    const extent = footprintExtent(feature.geometry);
    assert.ok(extent, `${props.name} has no readable footprint`);

    const { reach } = framing(props.area_m2, extent);
    const { min, max } = boxOf(extent.centre, reach);

    const walk = (node) => {
      if (typeof node[0] === 'number') {
        assert.ok(node[0] >= min[0] && node[0] <= max[0],
          `${props.name} runs ${((Math.max(min[0] - node[0], node[0] - max[0])) * M_PER_DEG_LON).toFixed(1)} m past the east/west edge of its perimeter`);
        assert.ok(node[1] >= min[1] && node[1] <= max[1],
          `${props.name} runs ${((Math.max(min[1] - node[1], node[1] - max[1])) * M_PER_DEG_LAT).toFixed(1)} m past the north/south edge of its perimeter`);
        return;
      }
      for (const child of node) walk(child);
    };
    walk(feature.geometry.coordinates);
  }
});

test('the perimeter still leaves grid around the building it holds', () => {
  // The other half of the same trade, and the reason this cannot be fixed by
  // simply enlarging the square: a perimeter wider than the frame is invisible,
  // which is the bug that shipped once at BOX_REACH 0.55. Growing the square to
  // fit a long building has to grow the frame with it.
  for (const feature of buildings) {
    const props = feature.properties;
    if (!canFlyOver(asCard(props))) continue;
    const extent = footprintExtent(feature.geometry);
    const { span, reach } = framing(props.area_m2, extent);
    assert.ok(reach * 2 < span * 0.8,
      `${props.name}'s square is ${((reach * 2) / span).toFixed(2)} spans — no room left for grid`);
  }
});

test('footprintExtent measures the footprint, not the properties', () => {
  const garage = buildings.find((f) => f.properties.name === 'Parking Garage');
  const extent = footprintExtent(garage.geometry);
  // The measurements quoted in the comments on `footprintExtent` and `framing`, which
  // is the whole case for having either.
  assert.ok(Math.abs(extent.halfWidth * 2 - 118) < 2, `garage is ${(extent.halfWidth * 2).toFixed(0)} m wide, expected 118`);
  assert.ok(Math.abs(extent.halfHeight * 2 - 73) < 2, `garage is ${(extent.halfHeight * 2).toFixed(0)} m deep, expected 73`);

  // ...and the anchor is NOT the middle, which was the larger of the two errors.
  const off = Math.abs(garage.properties.anchor[0] - extent.centre[0]) * M_PER_DEG_LON;
  assert.ok(off > 15, `the anchor is ${off.toFixed(0)} m off centre — if this is now small, the fix is untestable here`);

  // Degenerate input is a null rather than a throw: the caller falls back to
  // the anchor, which is what it did before any of this existed.
  assert.equal(footprintExtent(undefined), null);
  assert.equal(footprintExtent({ coordinates: [] }), null);
});

test('a building with no footprint still gets the framing it always had', () => {
  // The fallback path, which is the one thing here that must not have changed:
  // for a square building the new arithmetic has to reproduce the old numbers
  // exactly, or every constant measured at that framing is now measured at
  // something else. See BOX_MARGIN.
  //
  // Every real my campus building is in this range — the largest is the garage at
  // 8,629 m2 — so in practice this is the whole of the fallback.
  for (const area of [173, 631, 5403, 8629]) {
    const expected = Math.max(230, Math.min(800, Math.sqrt(area) * 4));
    assert.equal(framing(area).span, expected);
    assert.ok(Math.abs(framing(area).reach - expected * 0.2) < 1e-9);
  }

  // Above the span ceiling the two DO part, and deliberately: the frame stops
  // backing off at 800 m and the square does not stop growing, because a
  // perimeter that fits the frame but not the building is the bug all of this
  // is about. Nothing at my campus is this big; the behaviour is asserted so that the
  // next campus to arrive with a 50,000 m2 building is not silently cut.
  const huge = framing(50_000);
  assert.equal(huge.span, 800);
  assert.ok(huge.reach > 800 * 0.2, 'the square stopped growing with the building');
  assert.ok(huge.reach >= Math.sqrt(50_000) / 2, 'the square no longer holds the building');
  assert.ok(huge.reach * 2 < huge.span * 0.8, 'the square outgrew the frame');
});

test('the box surrounds its centre and is the right size on the ground', () => {
  const centre = [-121.3475, 38.6479];
  const { min, max } = boxOf(centre, 120);
  assert.ok(min[0] < centre[0] && max[0] > centre[0]);
  assert.ok(min[1] < centre[1] && max[1] > centre[1]);
  // 120 m of reach is a 240 m box. Checked in metres, because a degree of
  // longitude at my campus is about 0.78 of a degree of latitude and a box that was
  // square in DEGREES would be visibly oblong on the ground.
  const wide = (max[0] - min[0]) * M_PER_DEG_LON;
  const tall = (max[1] - min[1]) * M_PER_DEG_LAT;
  assert.ok(Math.abs(wide - 240) < 1, `box is ${wide.toFixed(0)} m wide, expected 240`);
  assert.ok(Math.abs(tall - 240) < 1, `box is ${tall.toFixed(0)} m tall, expected 240`);
});

test('the box is a volume, not a column', () => {
  // The defect this replaced: two corners of a lon/lat rectangle, which over a
  // tileset whose coarse levels are kilometres tall is a bound in name only.
  const { min, max } = boxOf([-121.3475, 38.6479], 120);
  assert.equal(min.length, 3, 'the box has no floor');
  assert.equal(max.length, 3, 'the box has no ceiling');
  assert.ok(Number.isFinite(min[2]) && Number.isFinite(max[2]));
  assert.ok(min[2] < max[2], 'the box is inside out');
});

test('the vertical band clears every tile Google actually serves over my campus', () => {
  // Measured off the live tileset at the Parking Garage — see BOX_FLOOR_M.
  // Each row is [geometricError, minAlt, maxAlt] in metres ellipsoidal.
  const measured = [
    [4.01, -6.4, 13.8], [8.03, -8.8, 13.8], [16.05, -10.7, 30.5],
    [32.10, -16.8, 32.2], [64.20, -24.4, 36.9],
  ];
  const { min, max } = boxOf([-121.3475, 38.6479], 120);
  for (const [err, lo, hi] of measured) {
    assert.ok(lo > min[2], `the ${err} m level starts at ${lo} m, below the box floor ${min[2]}`);
    assert.ok(hi < max[2], `the ${err} m level reaches ${hi} m, above the box ceiling ${max[2]}`);
  }
});

test('the size bound rejects a planet-scale slab and keeps a building-scale tile', () => {
  const { maxTileSpan, span } = boxOf([-121.3475, 38.6479], 120);
  assert.equal(span, 240);
  // Four box-widths. A 60 m leaf and a 953 m tile are in; the 30 km slab that
  // covers half of California is not.
  assert.equal(maxTileSpan, 960);
  assert.ok(60 <= maxTileSpan);
  assert.ok(953 <= maxTileSpan);
  assert.ok(3812 > maxTileSpan);
  assert.ok(30_630 > maxTileSpan);
});
