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
  M_PER_DEG_LAT, M_PER_DEG_LON, MIN_SPAN_M, roofOf,
} from '../src/flyover.js';
import {
  fallen, squashed, DROP_MS, SETTLED_MS, HOLD_MS, pinHeight, dropPixels, pinIcon, pinShadowIcon,
} from '../src/flyover-pin.js';
import {
  pushPinSvg, pinShadowSvg, SHADOW_BOX, PUSH_PIN, PUSH_PIN_RED,
} from '../src/push-pin.js';
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
  const big = framing(1_000_000);
  assert.ok(small.span < big.span);
  // Both clamped, which is the part that matters: an unclamped span would orbit
  // Adaptive PE from 36 m and a square kilometre from three miles out.
  assert.equal(small.span, MIN_SPAN_M);
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
  // of ground around the building, so the square has to be wider than the
  // footprint to contain it.
  //
  // This is the area-only path — no footprint — so the building is square and
  // `sqrt(area)` is its width exactly. That used to be written as `span / 4`,
  // which was only true at one value of BOX_REACH and quietly became an
  // underestimate the moment that moved, making the lower bound easier than it
  // reads. The footprint path is checked properly in "no building is cut by its
  // own perimeter", against real geometry.
  for (const area of [173, 631, 5403, 8629, 50_000]) {
    const { span, reach } = framing(area);
    const buildingWidth = Math.sqrt(area);
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

test('a building with no footprint gets the framing its footprint would have', () => {
  // The fallback path, checked against the real one rather than against numbers
  // copied out of it. This used to assert `sqrt(area) * 4` and `span * 0.2`
  // literally, which pinned the framing to the constants of the day and failed
  // the moment BOX_REACH was retuned — a test that only ever restated the
  // implementation. What actually has to hold is that a building with no
  // measured outline is framed exactly as a SQUARE one of its area would be.
  //
  // Every real my campus building is in this range — the largest is the garage at
  // 8,629 m2 — so in practice this is the whole of the fallback.
  for (const area of [173, 631, 5403, 8629]) {
    const half = Math.sqrt(area) / 2;
    const measured = framing(area, { halfWidth: half, halfHeight: half });
    assert.equal(framing(area).span, measured.span, `${area} m2 span`);
    assert.ok(Math.abs(framing(area).reach - measured.reach) < 1e-9, `${area} m2 reach`);
  }

  // ...and the square holds a fixed share of the frame wherever the span is
  // free to follow it, which is what makes one BOX_REACH serve every building.
  const free = [1772, 5403, 8629].map((a) => framing(a)).map((f) => f.reach / f.span);
  for (const share of free) assert.ok(Math.abs(share - free[0]) < 1e-9);

  // Above the span ceiling the two DO part, and deliberately: the frame stops
  // backing off at 800 m and the square does not stop growing, because a
  // perimeter that fits the frame but not the building is the bug all of this
  // is about. Nothing at my campus is this big; the behaviour is asserted so that the
  // next campus to arrive with a square kilometre is not silently cut.
  const huge = framing(1_000_000);
  assert.equal(huge.span, 800);
  assert.ok(huge.reach > 800 * free[0], 'the square stopped growing with the building');
  assert.ok(huge.reach >= Math.sqrt(1_000_000) / 2, 'the square no longer holds the building');
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

// --- the framing floor --------------------------------------------------------

test('the framing floor stops where the imagery does, not before', () => {
  // MIN_SPAN_M is the closest the camera goes, and the claim in its comment is
  // that it is set by Google's own resolution rather than by taste. Checked
  // here because the failure it prevents is silent: a smaller number still
  // renders, it just renders enlarged blobs, and nobody reading the diff would
  // know which side of the imagery's limit they had landed on.
  const DEVICE_PX = 640; // ~320 CSS px of sidebar, drawn at 2x
  const LEAF_ERROR_M = 2.01; // finest tiles over my campus; see src/roofs.json
  const perPixel = MIN_SPAN_M / DEVICE_PX;
  const leafPx = LEAF_ERROR_M / perPixel;

  // Above SCREEN_SPACE_ERROR (8, in src/flyover-view.js), so the traversal
  // actually reaches the finest level at the tightest framing rather than
  // stopping one short of it and enlarging that.
  assert.ok(leafPx > 8, `leaves project to ${leafPx.toFixed(1)} px, under the 8 px threshold`);
  // And not so far above it that the leaves are being magnified past their own
  // detail, which is the thing a lower floor would buy.
  assert.ok(leafPx < 14, `leaves project to ${leafPx.toFixed(1)} px — the camera is too close`);
});

test('most buildings get the framing that was designed, not the floor', () => {
  // The regression this catches is the one the 230 m floor WAS: two thirds of
  // the campus framed at whatever the clamp said instead of the quarter-frame
  // the arithmetic promises, with Operations at 6.8% of the picture. A future
  // change to BOX_MARGIN, BOX_REACH or the floor that quietly re-clamps the
  // campus fails here rather than in somebody's eyes.
  const rows = directory.filter((row) => canFlyOver(asCard(row)));
  const framed = rows.map((row) => {
    const feature = buildings.find((f) => (f.properties ?? f).name === row.name);
    const extent = footprintExtent(feature?.geometry);
    const half = extent
      ? Math.max(extent.halfWidth, extent.halfHeight)
      : Math.sqrt(row.area_m2) / 2;
    return { name: row.name, frac: (2 * half) / framing(row.area_m2, extent).span };
  });

  const designed = framed.filter((f) => f.frac > 0.249).length;
  assert.ok(designed >= framed.length * 0.6,
    `only ${designed} of ${framed.length} buildings reach the designed 25% of frame`);
  // Nothing may be smaller than an eighth of the picture. Below that a building
  // is one roof among several and the shot has stopped being about it, which is
  // what the pin exists to paper over and should not have to.
  const worst = framed.reduce((a, b) => (a.frac < b.frac ? a : b));
  assert.ok(worst.frac > 0.12,
    `${worst.name} is ${(worst.frac * 100).toFixed(1)}% of the frame`);
});

// --- the pin ------------------------------------------------------------------

test('every building that flies has a measured roof to drop a pin on', () => {
  // The silent failure this exists for: a building added to the directory
  // without regenerating src/roofs.json flies perfectly well and is simply
  // never marked. Nothing errors, nothing looks broken, and the one feature
  // that says WHICH building you are looking at is missing on exactly the
  // building nobody has seen before.
  const missing = directory
    .filter((row) => canFlyOver(asCard(row)))
    .filter((row) => !roofOf(row.name))
    .map((row) => row.name);
  assert.deepEqual(missing, [],
    `no roof centre for ${missing.join(', ')} — rerun scripts/build-roofs.mjs`);
});

test('a roof centre is a point in the sky above its own building', () => {
  for (const row of directory.filter((r) => canFlyOver(asCard(r)))) {
    const roof = roofOf(row.name);
    assert.equal(roof.length, 3, `${row.name}'s roof has no height`);
    const [lon, lat, z] = roof;
    // On campus. A transposed or mis-signed coordinate lands in the Indian
    // Ocean and the flyover would orbit an empty grid with a pin in it.
    assert.ok(lon > -121.352 && lon < -121.342, `${row.name} roof longitude ${lon}`);
    assert.ok(lat > 38.644 && lat < 38.654, `${row.name} roof latitude ${lat}`);
    // my campus's ground runs about -5 to -1 m in this datum and its tallest building
    // is 14 m, so a roof outside this band is a datum mistake rather than a
    // building. Negative is normal here: the geoid sits about 32 m below the
    // ellipsoid at my campus.
    assert.ok(z > -8 && z < 30, `${row.name} roof at ${z} m is outside my campus's range`);
  }
});

test('the pin falls rather than easing, and lands exactly on the roof', () => {
  const drop = 100;
  assert.equal(fallen(0, drop), drop, 'the pin does not start in the sky');
  assert.equal(fallen(-50, drop), drop, 'a drop that has not begun is already falling');
  assert.equal(fallen(DROP_MS, drop), 0, 'the pin does not land on the roof');
  assert.equal(fallen(DROP_MS * 10, drop), 0, 'the pin keeps going after it lands');
  assert.equal(fallen(SETTLED_MS, drop), 0);

  // Monotonic, and ACCELERATING — the half-way point of a free fall is a
  // quarter of the way down, not half. An ease-out would arrive slowest exactly
  // where the motion blur has to read, so this is the property that matters
  // rather than the shape of any particular curve.
  let previous = drop;
  for (let ms = 0; ms <= DROP_MS; ms += 20) {
    const height = fallen(ms, drop);
    assert.ok(height <= previous, `the pin rose between ${ms - 20} and ${ms} ms`);
    previous = height;
  }
  // ACCELERATING, checked as acceleration rather than as a shape. The pin is
  // caught part-way down an existing fall rather than released at the first
  // frame — see PRE_FALL — so it is already moving at ms 0 and the old test for
  // that, "half the time is a quarter of the way down", is a property of the
  // other end of the same parabola. What has to hold either way is that every
  // step is longer than the one before it: an ease-out would arrive slowest
  // exactly where the motion blur has to read.
  let step = 0;
  for (let ms = 20; ms <= DROP_MS; ms += 20) {
    const next = fallen(ms - 20, drop) - fallen(ms, drop);
    assert.ok(next >= step, `the pin slowed down between ${ms - 20} and ${ms} ms`);
    step = next;
  }

  // The shutter has to outlast the fall or the trail is cut off mid-flight.
  assert.ok(SETTLED_MS > DROP_MS);
});

test('the pin starts off camera and spends most of the fall on it', () => {
  // THE TWO REQUIREMENTS THIS FILE EXISTS TO PROTECT, and they pull against
  // each other. The pin has to enter from ABOVE the window — a marker that
  // materialises in mid-air says nothing about where it came from — and it has
  // to be watchable, which it is not if it clears the top edge by so far that
  // the whole drop happens off camera. Both are facts about screen pixels.
  //
  // 85 is measured: photographed at 368x230, the Library's roof projects about
  // 85 px below the top edge. It is a property of the framing rather than of
  // the pin, so it survives every change to the pin's size.
  const ROOF_Y = 85;
  const height = 230;
  const px = pinHeight(height);
  const drop = dropPixels(ROOF_Y, height);

  // Off camera at the first frame: the pin's FOOT starts at or above the top
  // edge, which puts everything above it — the whole drawing — out of shot.
  assert.ok(drop >= ROOF_Y,
    `a ${drop.toFixed(0)} px fall leaves ${(ROOF_Y - drop).toFixed(0)} px of pin on screen`);

  // ...and BARELY above it, which is the half of this that was wrong for a
  // while. A pin extends upward from its foot, so once the foot is at the edge
  // there is nothing left to hide; asking for a whole extra pin height of
  // clearance — which the first version did — parks it 74 px higher than it has
  // to be and turns the first half of the drop into a wait with an empty frame.
  assert.ok(drop < ROOF_Y + px * 0.25,
    `the pin waits ${(drop - ROOF_Y).toFixed(0)} px above a frame it only has to clear`);

  // So nearly all of the drop is spent where it can be seen. The pin's foot
  // crosses the top edge when it has fallen to ROOF_Y, so this is the fraction
  // of the animation with some pin in frame.
  let entered = DROP_MS;
  for (let ms = 0; ms <= DROP_MS; ms += 5) {
    if (fallen(ms, drop) < ROOF_Y) { entered = ms; break; }
  }
  const onScreen = 1 - entered / DROP_MS;
  assert.ok(onScreen > 0.85,
    `only ${(onScreen * 100).toFixed(0)}% of the fall happens inside the frame`);

  // A viewport of nothing must not produce a pin of nothing: the flyover
  // measures its own element, and a card built into a hidden panel measures 0.
  assert.ok(pinHeight(0) > 0);
  assert.ok(pinHeight(4000) < 120, 'the pin grows without limit on a large screen');
  // A roof already at the top edge asks for a fall of nearly nothing, and the
  // floor is what stops that being literally nothing — the trail's spacing is
  // solved by dividing by it. There is no framing that produces this; it is the
  // projection's edge case rather than the app's.
  assert.ok(dropPixels(0, height) >= pinHeight(height, 0), 'a high roof gets no drop at all');

  // THE LANDED PIN HAS TO FIT IN THE SKY IT STANDS IN, which is a constraint the
  // off-camera start retired for the FALLING pin and left in place for this one.
  // At 63 degrees off nadir a tall building's roof rides within a pin height of
  // the top edge, and a ball cut in half by the frame is not a marker.
  for (const sky of [40, 60, 85, 140, 400]) {
    assert.ok(pinHeight(height, sky) <= Math.max(sky, pinHeight(height, 0)),
      `a ${pinHeight(height, sky)} px pin does not fit under a ${sky} px sky`);
  }
  // ...and it only ever costs size where the sky is short: given room, the
  // headroom must not be what decides.
  assert.equal(pinHeight(height, 400), pinHeight(height));
  assert.ok(pinHeight(height, 60) < pinHeight(height), 'a short sky did not shrink the pin');
});

test('the push pin marks a place with its point', () => {
  // WHERE THE POINT IS, ASKED RATHER THAN ASSUMED. This drawing puts its tip at
  // the very bottom of its box and the one before it left a sliver of padding
  // under it, so an icon anchored blindly to the box is right for one and stands
  // every pin on the campus off its roof for the other. The contract is the
  // fraction, not the number — this survives the next swap too.
  assert.ok(PUSH_PIN.tipY > 0 && PUSH_PIN.tipY <= PUSH_PIN.h);
  assert.equal(PUSH_PIN.anchor, Number((PUSH_PIN.tipY / PUSH_PIN.h).toFixed(3)));
  const icon = pinIcon(PUSH_PIN_RED, 40);
  assert.ok(Math.abs(icon.anchorY / icon.height - PUSH_PIN.anchor) < 1e-9,
    'the icon anchors to its box rather than to the pin');
  assert.ok(PUSH_PIN.aspect > 1, 'the pin is not taller than it is wide');
});

test('the push pin rasterises: intrinsic size on demand, percentages otherwise', () => {
  // The defect this catches: an SVG sized in percentages has no natural
  // dimensions, so a data: URI of one decodes at the browser's 300x150 default.
  // deck.gl loads icons exactly that way, so the pin would reach the atlas
  // squashed and blurred with nothing in the console to say so.
  const sized = pushPinSvg({ height: 128 });
  assert.match(sized, new RegExp(`width="${(128 / PUSH_PIN.aspect).toFixed(3)}" height="128"`));
  assert.ok(!sized.includes('100%'));
  assert.match(pushPinSvg(), /width="100%" height="100%"/);

  // Every gradient the drawing refers to has to exist under the key it was
  // asked for, or the browser paints the shape black and says nothing. The
  // shadow is checked the same way and for the same reason: it is one circle
  // whose entire appearance is a gradient it names.
  for (const svg of [pushPinSvg({ id: 'probe' }), pinShadowSvg({ id: 'probe' })]) {
    for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(svg.includes(`id="${ref}"`), `no gradient defined for ${ref}`);
    }
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  }
  // The shadow is rasterised the same way the pin is and needs the same
  // intrinsic size, but it is one shape at one size and never asks for another.
  assert.match(pinShadowSvg(), new RegExp(`width="${SHADOW_BOX.w}" height="${SHADOW_BOX.h}"`));
});

test('the cast shadow is anchored at the foot and declared at its own size', () => {
  // THE DEFECT THIS CATCHES, because it was shipped once and found by looking:
  // deck.gl packs an icon into the box the icon DECLARES and stretches the image
  // to fill it, so an icon that says 300 for a drawing that is 240 is silently a
  // quarter longer — and this shadow's length is what says how high the pin is.
  // Nothing in the console, nothing in the shape, just a shadow reaching past
  // the building it belongs to.
  const icon = pinShadowIcon();
  assert.equal(icon.width, SHADOW_BOX.w);
  assert.equal(icon.height, SHADOW_BOX.h);
  // Anchored at the FOOT, which is the bottom of the box: that end of a cast
  // shadow is the one point that does not move when its caster rises.
  assert.equal(icon.anchorY, SHADOW_BOX.h);
  assert.equal(icon.anchorX, SHADOW_BOX.w / 2);
  // ...and the ball's blot is out along it, not at either end.
  assert.ok(SHADOW_BOX.at > 0.5 && SHADOW_BOX.at < 1);
  // Slender, which is the whole point of drawing the pin's silhouette rather
  // than a puddle under it.
  assert.ok(SHADOW_BOX.h / SHADOW_BOX.w > 2);
});

test('the pin takes the landing on its legs, once', () => {
  // Full height for the whole fall: nothing compresses a pin in mid-air.
  for (const ms of [0, DROP_MS / 2, DROP_MS]) assert.equal(squashed(ms), 1);

  // ONE DIP AND NO BOUNCE, which is the property this replaced a decaying sine
  // to get. It compresses, it comes back, and it never goes past full height on
  // the way — an overshoot is what makes a thing read as springy, and a marker
  // standing on a roof is not.
  let lowest = 1;
  let rising = false;
  for (let ms = DROP_MS; ms <= SETTLED_MS + 200; ms += 2) {
    const at = squashed(ms);
    assert.ok(at <= 1, `the pin sprang past full height to ${at} at ${ms} ms`);
    if (at > lowest + 1e-9) rising = true;
    // Down then up, and never down again: two dips are a bounce.
    else if (rising) assert.fail(`the pin compressed a second time at ${ms} ms`);
    lowest = Math.min(lowest, at);
  }
  assert.ok(lowest > 0.6 && lowest < 0.85, `a landing that squashes to ${lowest} is a collapse`);

  // ...and it is OVER rather than merely small by the time anything asks for a
  // settled frame, which is what lets SETTLED_MS be exact.
  assert.equal(squashed(SETTLED_MS), 1);
  assert.equal(squashed(SETTLED_MS * 10), 1);
});


test('recolouring the pin spins the hue and leaves the steel alone', () => {
  const red = pushPinSvg({ colour: PUSH_PIN_RED });
  const green = pushPinSvg({ colour: '#1e8e3e' });
  assert.notEqual(red, green);
  // The needle is measured chrome and must not follow the ball: a green pin with
  // a green spike is a drawing of a different object.
  for (const steel of ['#65615a', '#524c42', '#bdb5af']) {
    assert.ok(green.includes(steel), `the needle lost ${steel} when recoloured`);
  }
  // ...while the ball did move.
  assert.ok(!green.includes(PUSH_PIN_RED));
});
