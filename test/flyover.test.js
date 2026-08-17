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
  tierOf, canFlyOver, framing, campusBox, footprintExtent, FLYOVER_TIER, MIN_AREA_M2, STALE_IMAGERY,
  M_PER_DEG_LAT, M_PER_DEG_LON, MIN_SPAN_M, roofOf,
} from '../src/flyover.js';
import {
  fallen, squashed, DROP_MS, SETTLED_MS, HOLD_MS, pinHeight, dropPixels, pinIcon, pinShadowIcon,
  warmPinIcons,
} from '../src/flyover-pin.js';
import {
  pushPinSvg, pinShadowSvg, SHADOW_BOX, PUSH_PIN, PUSH_PIN_RED,
} from '../src/push-pin.js';
import { highlightLayers, HIGHLIGHT_MS, HIGHLIGHT_UP_MS } from '../src/flyover-cage.js';
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
  // If this list grows, a real building stopped getting an aerial view. It used
  // to hold "Baseball and Softball Field" as well, refused on the word its name
  // ends with — and src/roofs.json measured 4.5 m of built structure standing
  // there, so the name was wrong about it and a traced footprint now outranks
  // one. Only bad imagery refuses a directory row today.
  assert.deepEqual(refused.sort(), [
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

test('the last word decides, but only where nothing better is known', () => {
  // The name rule is now the WEAKEST evidence rather than the strongest, so
  // this is about the case it was left for: something tapped with a disc class
  // and nothing else — no footprint, no printed label kind.
  assert.equal(tierOf({ name: 'Field House', poi: 'sport' }), FLYOVER_TIER.SOLID);
  assert.equal(tierOf({ name: 'Track and Field Center', poi: 'sport' }), FLYOVER_TIER.SOLID);
  assert.equal(tierOf({ name: 'Softball Field', poi: 'sport' }), FLYOVER_TIER.FLAT);

  // ...and a traced footprint overrules it, which is the change. my campus's own
  // Baseball and Softball Field is 483 m2 of directory row with 4.5 m of
  // structure measured on it, and refusing that on the word "Field" was the
  // rule being confidently wrong about a real building.
  assert.equal(tierOf({ name: 'Softball Field', poi: 'sport', area_m2: 2000 }), FLYOVER_TIER.SOLID);
  // As does a name my campus printed on its own sheet as a building.
  assert.equal(tierOf({ name: 'Pool', labelKind: 'building' }), FLYOVER_TIER.SOLID);
  // But never an AREA name, which is my campus's own word for a piece of ground.
  assert.equal(tierOf({ name: 'SOFTBALL FIELD', labelKind: 'area' }), FLYOVER_TIER.FLAT);
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
    assert.ok(Math.abs(framing(area).maxTileSpan - measured.maxTileSpan) < 1e-9, `${area} m2 tiles`);
  }

  // ...and the square holds a fixed share of the frame wherever the span is
  // free to follow it, which is what makes one BOX_REACH serve every building.
  const free = [1772, 5403, 8629].map((a) => framing(a)).map((f) => f.maxTileSpan / f.span);
  for (const share of free) assert.ok(Math.abs(share - free[0]) < 1e-9);

  // Above the span ceiling the two DO part, and deliberately: the frame stops
  // backing off at 800 m and the square does not stop growing, because a
  // perimeter that fits the frame but not the building is the bug all of this
  // is about. Nothing at my campus is this big; the behaviour is asserted so that the
  // next campus to arrive with a square kilometre is not silently cut.
  const huge = framing(1_000_000);
  assert.equal(huge.span, 800);
  assert.ok(huge.maxTileSpan > 800 * free[0],
    'the coarse-tile limit stopped growing with the building');
});

test('the highlight is a box around the building, and it goes away', () => {
  // Fakes, because what is worth testing is the GEOMETRY handed to deck.gl
  // rather than deck.gl.
  const library = buildings.find((f) => f.properties.name === 'Library');
  const mass = { ground: -1.4, top: 14.1 };
  const roof = [-121.3466, 38.6489, 11.2];
  const draw = (ms, opts = {}) => {
    const made = [];
    const Layer = class { constructor(props) { made.push(props); } };
    const tools = { PathLayer: Layer, SolidPolygonLayer: Layer, LineLayer: Layer };
    const out = highlightLayers(tools, {
      footprint: library.geometry, mass, roof, ms, ...opts,
    });
    return { out, made, by: (id) => made.find((m) => m.id === id) };
  };

  // Nothing before the pin has landed, and nothing at all once it is over.
  assert.deepEqual(draw(0).out, []);
  assert.deepEqual(draw(DROP_MS).out, []);
  assert.deepEqual(draw(DROP_MS + HIGHLIGHT_MS).out, []);
  assert.deepEqual(draw(DROP_MS + HIGHLIGHT_MS * 4).out, []);

  const up = draw(DROP_MS + HIGHLIGHT_UP_MS);
  const volume = up.by('flyover-highlight-volume');
  const posts = up.by('flyover-highlight-post');
  const roofRing = up.by('flyover-highlight');
  const baseRing = up.by('flyover-highlight-base');

  // A VOLUME, not a lid: extruded from the measured ground to the measured
  // roof, which is the whole of this mark's claim about the building.
  assert.ok(volume, 'there is no extruded volume');
  assert.equal(volume.extruded, true);
  assert.equal(volume.getElevation, roof[2] - mass.ground);
  for (const polygon of volume.data) {
    for (const ring of polygon) for (const p of ring) assert.equal(p[2], mass.ground);
  }

  // Two rings, one at each end of it.
  for (const p of roofRing.data[0]) assert.equal(p[2], roof[2]);
  for (const p of baseRing.data[0]) assert.equal(p[2], mass.ground);

  // Uprights, at CORNERS rather than at vertices — a post at each of a curved
  // wall's forty points is a fence. The Library is a rectangle with a stepped
  // west end, so this is a handful and nowhere near its vertex count.
  const outer = library.geometry.type === 'MultiPolygon'
    ? library.geometry.coordinates[0][0] : library.geometry.coordinates[0];
  assert.ok(posts.data.length >= 4, 'a box with no uprights is still a lid');
  assert.ok(posts.data.length < outer.length * 0.6,
    `${posts.data.length} posts on a ${outer.length}-point ring is a fence`);
  // Vertical, which is the one thing PathLayer could not have drawn.
  for (const d of posts.data) {
    assert.deepEqual([d.from[0], d.from[1]], [d.to[0], d.to[1]]);
    assert.equal(d.from[2], mass.ground);
    assert.equal(d.to[2], roof[2]);
  }

  // The glazing is a glazing and not paint: a line of sight through a box
  // crosses two faces, so it has to be weaker than the lines that bound it.
  assert.ok(volume.getFillColor[3] < roofRing.getColor[3] / 8,
    'the fill is as strong as the outline, which makes the box milk');

  // Cased, because a white line on a white roof is invisible.
  const casing = up.by('flyover-highlight-case');
  assert.ok(casing.getWidth > roofRing.getWidth);
  assert.deepEqual(roofRing.getColor.slice(0, 3), [255, 255, 255]);

  // Drawn THROUGH the building: the far side is the half that says which mass
  // this is when a neighbour stands in front of it.
  for (const props of up.made) assert.equal(props.parameters.depthCompare, 'always');

  // UP, HELD, THEN AWAY. Sampled across the life: climbing, full, then falling.
  const alpha = (ms) => draw(ms).by('flyover-highlight')?.getColor[3] ?? 0;
  const full = alpha(DROP_MS + HIGHLIGHT_UP_MS);
  assert.ok(alpha(DROP_MS + HIGHLIGHT_UP_MS * 0.55) < full, 'it did not fade in');
  assert.equal(alpha(DROP_MS + HIGHLIGHT_UP_MS + 500), full, 'it did not hold');
  assert.ok(alpha(DROP_MS + HIGHLIGHT_MS - 200) < full, 'it did not fade out');
  assert.ok(HIGHLIGHT_MS - HIGHLIGHT_UP_MS >= 1000, 'it holds for less than the second asked for');

  // The peak is the fallback, so a building with a footprint and no measured
  // centre is still boxed.
  const noRoof = draw(DROP_MS + HIGHLIGHT_UP_MS, { roof: null });
  assert.equal(noRoof.by('flyover-highlight-volume').getElevation, mass.top - mass.ground);

  // Nothing to trace is not an error: a place that flies with no directory
  // footprint behind it gets a flyover without a highlight rather than a crash
  // or empty layers that cost draw calls.
  const anyTime = DROP_MS + HIGHLIGHT_UP_MS;
  const tools = { PathLayer: class {}, SolidPolygonLayer: class {}, LineLayer: class {} };
  assert.deepEqual(highlightLayers(tools, { footprint: null, mass, roof, ms: anyTime }), []);
  assert.deepEqual(
    highlightLayers(tools, { footprint: library.geometry, mass: null, roof, ms: anyTime }), [],
  );
  // A building with no height measured is a plane, not a mass.
  assert.deepEqual(highlightLayers(tools, {
    footprint: library.geometry, mass: { ground: 3, top: 3 }, roof, ms: anyTime,
  }), []);
});

test('the landing pin gets shorter without getting narrower', () => {
  // deck.gl draws an icon `getSize` tall and takes its WIDTH from the icon's own
  // aspect. So a pin squashed by handing the layer a smaller size loses height
  // and width together, which is a pin moving away from the camera rather than
  // one hitting a roof. The compression is baked into the icon's box instead,
  // and this is the arithmetic that says the two cancel.
  const px = 60;
  const drawn = (squash) => {
    const icon = pinIcon(PUSH_PIN_RED, px, squash);
    // Exactly what pinLayers passes, derived from the icon so the quantised box
    // and the size cannot disagree.
    const size = icon.height / 2;
    return { w: size * (icon.width / icon.height), h: size, icon };
  };

  const rest = drawn(1);
  // Across the whole range the squash actually reaches — 1 down to 1 - SQUASH.
  for (const squash of [1, 0.95, 0.9, 0.85, 0.8, 0.75]) {
    const now = drawn(squash);
    assert.ok(Math.abs(now.w - rest.w) < 1e-9,
      `at squash ${squash} the pin is ${now.w.toFixed(2)}px wide, not ${rest.w.toFixed(2)}`);
    assert.ok(now.h <= rest.h + 1e-9, 'a squashed pin got taller');
  }
  // ...and it really does get shorter, or the test above passes on a pin that
  // never moves.
  assert.ok(drawn(0.75).h < rest.h * 0.8);

  // The point stays on the roof: the anchor is a fraction of the box, so it
  // travels down with the box instead of the pin sinking into the building.
  assert.ok(drawn(0.75).icon.anchorY < rest.icon.anchorY);

  // The drawing follows the shortened box rather than letterboxing inside it,
  // which is the difference between a squash and a gap under a small pin.
  assert.match(decodeURIComponent(drawn(0.75).icon.url), /preserveAspectRatio="none"/);
  assert.doesNotMatch(decodeURIComponent(rest.icon.url), /preserveAspectRatio/);

  // Quantised, because deck.gl repacks its atlas the first time it sees an id
  // and the landing is the one moment that must not hitch.
  const ids = new Set();
  for (let i = 0; i <= 100; i += 1) ids.add(pinIcon(PUSH_PIN_RED, px, 1 - (i / 100) * 0.26).id);
  assert.ok(ids.size <= 14, `${ids.size} distinct icons across the squash is an atlas repack a frame`);
  // And warming is a no-op rather than a throw where there is no Image.
  assert.doesNotThrow(() => warmPinIcons(PUSH_PIN_RED, px));
});

test('the campus box holds the campus, with room for a building on its edge', () => {
  // The walk network's own extent, which is what main.js hands over. Restating
  // it here would be a second opinion about where my campus is; this checks the
  // MARGIN, which is the part that is a judgment.
  const bounds = [[-121.350452, 38.644706], [-121.342319, 38.653606]];
  const { min, max } = campusBox(bounds);

  // Every corner of the campus is inside, or a building on the edge is bounded
  // by a box that has already cut the ground it stands on.
  assert.ok(min[0] < bounds[0][0] && min[1] < bounds[0][1]);
  assert.ok(max[0] > bounds[1][0] && max[1] > bounds[1][1]);

  // The margin is real ground rather than a rounding error, and it is roughly
  // square ON THE GROUND — a degree of longitude at my campus is about 0.78 of a
  // degree of latitude, so a margin that was equal in DEGREES would be visibly
  // oblong and short on one axis.
  const east = (min[0] - (bounds[0][0] - 0)) * -M_PER_DEG_LON;
  const north = (min[1] - (bounds[0][1] - 0)) * -M_PER_DEG_LAT;
  assert.ok(Math.abs(east - north) < 1, `margin is ${east.toFixed(0)} m by ${north.toFixed(0)} m`);
  assert.ok(east > 80 && east < 400, `a ${east.toFixed(0)} m margin is not a frame's worth`);

  // ...and it is well OUTSIDE any single building's shot, which is the whole
  // difference from the per-building square this replaced: that one was drawn
  // across the picture, this one is off camera for everything but the edge.
  const widest = Math.max(...[173, 1772, 8629].map((a) => framing(a).span));
  assert.ok((max[0] - min[0]) * M_PER_DEG_LON > widest,
    'the campus is narrower than a single flyover frame');
});

test('the coarse-tile limit rejects a planet-scale slab and keeps the campus', () => {
  // ALL THAT IS LEFT OF THE BOX, and the half that was doing invisible work.
  // The square that clipped the imagery is gone — a hard edge across a
  // photograph reads as a crop of the picture rather than an edge of the world
  // — but the size test it carried is what stops Tile3DLayer drawing the
  // ancestor slabs, which is how this viewport rendered global bathymetry once.
  //
  // Measured off the live tileset over my campus: leaves are about 60 m, their
  // parents 953 m, and the ancestors run to 30 km.
  for (const area of [173, 1772, 8629]) {
    const { maxTileSpan, span } = framing(area);
    assert.ok(maxTileSpan > span, 'a tile the size of the shot is not a slab');
    assert.ok(60 <= maxTileSpan, 'a leaf tile would be rejected');
    assert.ok(3812 > maxTileSpan, 'a 3.8 km tile would be drawn');
    assert.ok(30_630 > maxTileSpan, 'the 30 km slab would be drawn');
  }
  // It has to grow with the shot, or a big building is framed at a span whose
  // own tiles are rejected as too coarse for it.
  assert.ok(framing(8629).maxTileSpan > framing(173).maxTileSpan);
});

test('every building that flies fits in the frame it is given', () => {
  // WHAT THE DELETED PERIMETER TESTS WERE REALLY PROTECTING. The clip square is
  // gone, so nothing can slice the east end off the Parking Garage any more —
  // but the framing that sized that square still sizes the CAMERA, and a
  // building wider than its own shot is the same bug wearing different clothes.
  //
  // The longer axis, because the camera goes all the way round and spends half
  // its orbit looking down the length of a long building.
  for (const feature of buildings) {
    const props = feature.properties;
    if (!canFlyOver(asCard(props))) continue;
    const extent = footprintExtent(feature.geometry);
    assert.ok(extent, `${props.name} has no readable footprint`);
    const { span } = framing(props.area_m2, extent);
    const width = Math.max(extent.halfWidth, extent.halfHeight) * 2;
    assert.ok(width < span * 0.6,
      `${props.name} is ${((width / span) * 100).toFixed(0)}% of its own frame`);
    assert.ok(width > span * 0.08,
      `${props.name} is ${((width / span) * 100).toFixed(0)}% of its frame — a speck`);
  }
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
