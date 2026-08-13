// src/basemap.json — my campus's printed campus map, translated element for element.
//
// The faults this guards against are the ones that already happened once while
// it was being built: elements silently never read, phantom full-page shapes,
// and a compound path whose rings were summed instead of subtracted, which
// promoted letterforms into buildings.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  load, CAMPUS, eachPosition, polygonsOf, signedArea, pointInRing, ringAreaM2,
} from './helpers.js';

const basemap = load('basemap');
const features = basemap.features;

/**
 * Every class scripts/build-basemap.mjs is allowed to emit. A kind arriving
 * that is not listed here means the LAYERS table changed, and since src/main.js
 * colours by kind, an unlisted one silently renders in my campus's print palette
 * instead of the theme's.
 */
const KINDS = new Set([
  'lawn', 'tree', 'shrub', 'paving', 'parking', 'parking_stripe', 'sport',
  'tennis', 'tennis_apron', 'track', 'pool', 'closed', 'building', 'walkway', 'driveway', 'offsite_road',
  'crossing', 'parking_marker', 'bike_marker', 'label_plate', 'badge', 'north_arrow', 'bus_stop', 'bleachers',
  'emergency_phone', 'defibrillator', 'restroom', 'permit_machine',
]);

test('is a non-empty FeatureCollection', () => {
  assert.equal(basemap.type, 'FeatureCollection');
  assert.ok(features.length > 2000, `only ${features.length} features`);
});

test('every feature carries a known kind and a geometry', () => {
  for (const f of features) {
    assert.ok(f.geometry, `feature ${f.properties?.i} has no geometry`);
    assert.ok(KINDS.has(f.properties.kind), `unknown kind ${f.properties.kind}`);
    assert.equal(typeof f.properties.i, 'number');
    assert.equal(typeof f.properties.layer, 'number');
  }
});

// Draw order is the whole reason `i` exists. A flat vector map is a painter's
// algorithm — striping over tarmac, trees over lawn — and src/main.js rebuilds
// it with fill-sort-key. If the file stops being sorted, the sort key still
// works, but anything reading the file in order gets the campus inside out.
test('features are in strictly increasing draw order', () => {
  for (let n = 1; n < features.length; n++) {
    assert.ok(
      features[n].properties.i > features[n - 1].properties.i,
      `draw order breaks at feature ${n}`,
    );
  }
});

test('every coordinate is finite and on campus', () => {
  for (const f of features) {
    eachPosition(f.geometry, ([lon, lat]) => {
      assert.ok(Number.isFinite(lon) && Number.isFinite(lat), `non-finite in ${f.properties.i}`);
      assert.ok(
        lon > CAMPUS.west && lon < CAMPUS.east && lat > CAMPUS.south && lat < CAMPUS.north,
        `feature ${f.properties.i} at ${lon},${lat} is off campus`,
      );
    });
  }
});

test('every polygon ring is closed and has enough positions', () => {
  for (const f of features) {
    for (const rings of polygonsOf(f.geometry)) {
      for (const ring of rings) {
        assert.ok(ring.length >= 4, `ring of ${f.properties.i} has ${ring.length} positions`);
        assert.deepEqual(ring[0], ring.at(-1), `ring of ${f.properties.i} is not closed`);
      }
    }
  }
});

// RFC 7946: exteriors counter-clockwise, holes clockwise. Mapbox tolerates the
// wrong winding, so this would never show up as a rendering bug — it shows up
// when the file is handed to anything that follows the spec.
test('ring winding follows the right-hand rule', () => {
  for (const f of features) {
    for (const rings of polygonsOf(f.geometry)) {
      rings.forEach((ring, n) => {
        const area = signedArea(ring);
        if (Math.abs(area) < 1e-14) return; // degenerate slivers have no meaningful winding
        const wound = n === 0 ? area > 0 : area < 0;
        assert.ok(wound, `${n === 0 ? 'exterior' : 'hole'} of ${f.properties.i} is wound backwards`);
      });
    }
  }
});

test('holes lie inside their exterior', () => {
  let holes = 0;
  for (const f of features) {
    for (const rings of polygonsOf(f.geometry)) {
      for (const hole of rings.slice(1)) {
        holes += 1;
        assert.ok(pointInRing(hole[0], rings[0]), `hole of ${f.properties.i} is outside its shell`);
      }
    }
  }
  // The stadium track is one path holding an outer and an inner oval. If holes
  // stop being detected it becomes a filled lozenge, which is the exact bug
  // toPolygons exists to prevent — so at least one must survive.
  assert.ok(holes >= 1, 'no polygon holes at all — compound paths are being flattened');
});

/**
 * The kinds src/main.js fills from the palette whatever the sheet says, listed
 * in the campus-sheet-fill filter there.
 *
 * They are the shapes my campus drew as something other than a surface: nineteen
 * pitches and twelve courts carried as stroke-only touchlines, the apron under
 * the courts, and the stadium field, which the sheet does not draw at all —
 * it is the hole in the track, promoted to a feature by build-basemap.mjs and
 * so the one thing in this file with no ink of its own by construction.
 */
const FILLED_BY_KIND = new Set(['sport', 'tennis', 'tennis_apron']);

test('nothing is invisible', () => {
  for (const f of features) {
    const { fill, stroke, i, kind } = f.properties;
    assert.ok(
      fill || stroke || FILLED_BY_KIND.has(kind),
      `feature ${i} (${kind}) has neither fill nor stroke`,
    );
  }
});

test('stroke widths are plausible ground metres', () => {
  const widths = features.map((f) => f.properties.width).filter((w) => w !== undefined);
  assert.ok(widths.length > 100, `only ${widths.length} features carry a width`);
  for (const w of widths) {
    // Narrowest is a 0.78 m painted line, widest the 26.4 m entry road.
    assert.ok(w > 0.3 && w < 40, `implausible stroke width ${w} m`);
  }
});

// The bay striping is 1,004 near-identical 0.99 x 7.90 m bars. It is also the
// single biggest class in the file, so if the classifier ever starts pulling
// something else into it the mistake is large and worth catching by size.
test('parking bay striping is uniform', () => {
  const stripes = features.filter((f) => f.properties.kind === 'parking_stripe');
  assert.ok(stripes.length > 900, `only ${stripes.length} bay stripes`);
  for (const s of stripes) {
    const area = ringAreaM2(polygonsOf(s.geometry)[0][0]);
    assert.ok(area > 2 && area < 90, `bay stripe ${s.properties.i} covers ${area.toFixed(1)} m2`);
  }
});

// Letterforms are dropped on purpose; the text lives in src/labels.json as
// strings. Counting small shapes cannot check this — the sheet is full of
// legitimately small things, 44 shrubs and 42 emergency-phone pieces among them
// — so this tests the mask where it actually acts, on the layers that carry
// text. Layer 7 is nothing but public street names and must vanish entirely;
// layer 18 is the label layer and only its plates and a few icon fragments
// should survive its 609 elements.
test('the text mask empties the text layers', () => {
  const inLayer = (n) => features.filter((f) => f.properties.layer === n).length;
  assert.equal(inLayer(7), 0, 'the street-name layer still has features');
  assert.ok(inLayer(18) < 30, `${inLayer(18)} features survive the label layer`);
});

// The failure this guards is specific and has happened: summing a compound
// path's rings instead of subtracting them put the letter "O" at 83 m2, over
// the glyph ceiling, and promoted chunks of STADIUM and TENNIS COURTS into
// buildings. A building smaller than a parking space is that bug returning.
test('no building is letterform-sized', () => {
  // Three footprints are drawn as unclosed stroked outlines and have no area to
  // measure, which is the artwork's business rather than a fault.
  const areas = features
    .filter((f) => f.properties.kind === 'building')
    .map((f) => [f.properties.i, polygonsOf(f.geometry)])
    .filter(([, polys]) => polys.length);
  assert.ok(areas.length > 100, `only ${areas.length} buildings have an area`);
  for (const [i, polys] of areas) {
    const area = ringAreaM2(polys[0][0]);
    assert.ok(area > 15, `building ${i} covers only ${area.toFixed(1)} m2`);
  }
});

test('the parts the app draws itself are marked hidden', () => {
  const plates = features.filter((f) => f.properties.kind === 'label_plate');
  assert.ok(plates.length > 0);
  for (const p of plates) {
    assert.equal(p.properties.hidden, true, `label plate ${p.properties.i} is not hidden`);
  }
});
