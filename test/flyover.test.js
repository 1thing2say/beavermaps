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
  tierOf, canFlyOver, framing, boxOf, FLYOVER_TIER, MIN_AREA_M2, STALE_IMAGERY,
} from '../src/flyover.js';
import { poiFor } from '../src/poi.js';

const directory = load('directory').features.map((f) => f.properties ?? f);
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
  assert.equal(small.span, 150);
  assert.equal(big.span, 520);
  // A missing footprint must still produce a usable camera rather than NaN.
  assert.ok(Number.isFinite(framing(undefined).span));
  assert.ok(framing().pitch > 0 && framing().pitch < 90);
});

test('the tile box is tight enough to actually bind', () => {
  // The measured crossover: deck.gl's own far plane already stops about 0.62
  // spans past the target, so a box wider than that would never be consulted.
  // This is the assertion that keeps `reach` an actual budget rather than a
  // comment about one — see BOX_REACH.
  for (const area of [173, 631, 5403, 8629, 50_000]) {
    const { span, reach } = framing(area);
    assert.ok(reach / span < 0.62,
      `reach is ${(reach / span).toFixed(2)} spans — wider than deck.gl's own far plane`);
    assert.ok(reach / span > 0.4, 'a box this tight cuts into the building\'s own ground');
  }
});

test('the box surrounds its centre and is the right size on the ground', () => {
  const centre = [-121.3475, 38.6479];
  const [[west, south], [east, north]] = boxOf(centre, 120);
  assert.ok(west < centre[0] && east > centre[0]);
  assert.ok(south < centre[1] && north > centre[1]);
  // 120 m of reach is a 240 m box. Checked in metres, because a degree of
  // longitude at my campus is about 0.78 of a degree of latitude and a box that was
  // square in DEGREES would be visibly oblong on the ground.
  const wide = (east - west) * 86_900;
  const tall = (north - south) * 111_132;
  assert.ok(Math.abs(wide - 240) < 1, `box is ${wide.toFixed(0)} m wide, expected 240`);
  assert.ok(Math.abs(tall - 240) < 1, `box is ${tall.toFixed(0)} m tall, expected 240`);
});
