// src/basemap.json — my campus's printed campus map, translated element for element.
//
// The faults this guards against are the ones that already happened once while
// it was being built: elements silently never read, phantom full-page shapes,
// and a compound path whose rings were summed instead of subtracted, which
// promoted letterforms into buildings.

import test from 'node:test';
import { sunAt, lightPresetAt, nextCheckMs, HORIZON_DEG, CHECK_MIN_MS, CHECK_MAX_MS } from '../src/daylight.js';
import { underPreset, THEMES } from '../src/palette.js';
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

test('the lighting follows the sun rather than the clock or the theme', () => {
  const LON = -121.3466;
  const LAT = 38.6489;
  const at = (iso) => new Date(iso);

  // Sacramento's published solstice times, which is the check that matters: a
  // table of hours cannot do this. Sunset moves by three and a half hours
  // between these two dates.
  const crossing = (day, from, to) => {
    let last = null;
    for (let m = 0; m < 1440; m += 1) {
      const t = new Date(Date.parse(`${day}T00:00:00Z`) + m * 60_000);
      const e = sunAt(t, LON, LAT).elevation;
      if (last !== null && ((from === 'up' && last <= HORIZON_DEG && e > HORIZON_DEG)
        || (from === 'down' && last > HORIZON_DEG && e <= HORIZON_DEG))) return t;
      last = e;
    }
    return null;
  };
  // June solstice: published sunrise 05:42, sunset 20:32 PDT (UTC-7).
  const utcHm = (t, offset) => {
    const local = new Date(t.getTime() + offset * 3_600_000);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
  };
  const near = (got, want, slack, what) => assert.ok(Math.abs(got - want) <= slack,
    `${what}: ${Math.floor(got / 60)}:${String(got % 60).padStart(2, '0')} is more than `
    + `${slack} min from ${Math.floor(want / 60)}:${String(want % 60).padStart(2, '0')}`);
  near(utcHm(crossing('2026-06-21', 'up'), -7), 5 * 60 + 42, 8, 'june sunrise');
  near(utcHm(crossing('2026-06-21', 'down'), -7), 20 * 60 + 32, 8, 'june sunset');
  near(utcHm(crossing('2026-12-21', 'down'), -8), 16 * 60 + 50, 8, 'december sunset');

  // The four presets, and that dawn and dusk are told apart by direction rather
  // than by height — they are the same few degrees of sky.
  assert.equal(lightPresetAt(at('2026-06-21T19:00:00Z'), LON, LAT), 'day');      // noon PDT
  assert.equal(lightPresetAt(at('2026-06-22T07:00:00Z'), LON, LAT), 'night');    // midnight
  assert.equal(lightPresetAt(at('2026-06-21T13:00:00Z'), LON, LAT), 'dawn');     // 06:00
  assert.equal(lightPresetAt(at('2026-06-22T03:00:00Z'), LON, LAT), 'dusk');     // 20:00
  const dawn = sunAt(at('2026-06-21T13:00:00Z'), LON, LAT);
  const dusk = sunAt(at('2026-06-22T03:00:00Z'), LON, LAT);
  assert.ok(dawn.rising && !dusk.rising, 'dawn and dusk are not distinguished by direction');

  // The poll backs off away from a boundary and tightens near one.
  const noon = nextCheckMs(at('2026-06-21T19:00:00Z'), LON, LAT);
  const edge = nextCheckMs(at('2026-06-22T03:10:00Z'), LON, LAT);
  assert.equal(noon, CHECK_MAX_MS, 'the poll does not back off in the middle of the day');
  assert.ok(edge < noon, 'the poll does not tighten near a boundary');
  assert.ok(edge >= CHECK_MIN_MS);
});

test('the campus and the city agree about the time of day', () => {
  // The bug this closes: everything drawn over the campus is emissive, so
  // lighting cannot touch it — at dusk the city went navy around a college
  // still sitting in a summer afternoon.
  const day = underPreset(THEMES.light, 'day');
  assert.deepEqual(day, THEMES.light, 'day is the palette as authored');

  const night = underPreset(THEMES.light, 'night');
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722;
  };
  // The campus comes DOWN...
  for (const key of ['mask', 'building', 'buildingLine']) {
    assert.ok(lum(night[key]) < lum(THEMES.light[key]) - 8,
      `${key} did not darken with the sky`);
  }
  for (const [kind, colour] of Object.entries(night.land)) {
    assert.ok(lum(colour) <= lum(THEMES.light.land[kind]),
      `land.${kind} did not darken with the sky`);
  }
  // ...and the city comes UP, because Standard's own lighting takes it down
  // again and an unlifted night city is more contrast than a map can carry.
  assert.ok(lum(night.basemapConfig.colorLand) > lum(THEMES.light.basemapConfig.colorLand),
    'the city was not lifted to meet the campus');

  // AND IT IS THE RIGHT COLOUR, not just the right lightness. This is the
  // regression this test exists for: the first version mixed toward black,
  // which takes light away and adds nothing, so a campus set to Dawn went GREY
  // beside a city Standard had just turned amber. A low sun is a warmer light,
  // not a weaker one, and the absence of it is a cooler one.
  const warmth = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) - (n & 255);      // red minus blue
  };
  const flat = warmth(THEMES.light.mask);
  assert.ok(warmth(underPreset(THEMES.light, 'dawn').mask) > flat,
    'the campus is not warmer at dawn than at noon');
  assert.ok(warmth(underPreset(THEMES.light, 'dusk').mask) > flat,
    'the campus is not warmer at dusk than at noon');
  assert.ok(warmth(underPreset(THEMES.light, 'night').mask) < 0,
    'the campus is not cooler than neutral at night');
  // Dusk is lower and redder than dawn, so it is both warmer and darker.
  assert.ok(warmth(underPreset(THEMES.light, 'dusk').mask)
    > warmth(underPreset(THEMES.light, 'dawn').mask), 'dusk is not warmer than dawn');
  assert.ok(lum(underPreset(THEMES.light, 'dusk').mask)
    < lum(underPreset(THEMES.light, 'dawn').mask), 'dusk is not darker than dawn');

  // NO STEP AT THE CAMPUS BOUNDARY, which is what all of the above is for. The
  // lawn inside the campus and Standard's greenspace across the creek are one
  // field of grass in the world; if the two halves are moved by different
  // amounts, the boundary draws itself as a line. Daylight and the two low-sun
  // presets have to match closely — night is allowed to diverge, because there
  // the campus genuinely is unlit ground and the city is not.
  for (const preset of ['day', 'dawn', 'dusk']) {
    const c = underPreset(THEMES.light, preset);
    const gap = Math.abs(lum(c.land.lawn) - lum(c.basemapConfig.colorGreenspace));
    assert.ok(gap <= 8, `at ${preset} the campus lawn is ${gap.toFixed(0)} off the grass beside it`);
  }

  // Type is excluded on purpose: a halo that dims with its own label cancels
  // itself out, and the ground is moving under both.
  for (const key of ['label', 'labelHalo', 'pinRing']) {
    assert.equal(night[key], THEMES.light[key], `${key} should not follow the sky`);
  }
  // ...and the dark theme's own night is the authored one, not a doubling.
  assert.equal(underPreset(THEMES.dark, 'day'), THEMES.dark);
});

test('the sun is where the sun is, and it sets in the west', () => {
  // The directional light's direction is derived from this, and a light that
  // points the wrong way is a campus whose shadows fall east in the morning.
  // Checked against the four positions anybody can verify from a window.
  const LON = -121.347025;
  const LAT = 38.649511;

  // Local solar noon on the December solstice: due south, and low.
  const noon = sunAt(new Date('2026-12-21T20:00:00Z'), LON, LAT);
  assert.ok(Math.abs(noon.azimuth - 180) < 3,
    `midwinter noon put the sun at ${noon.azimuth.toFixed(1)} deg, not due south`);
  // 90 - latitude - obliquity, which is the whole of why winter is dark here.
  assert.ok(Math.abs(noon.elevation - (90 - LAT - 23.44)) < 1,
    `midwinter noon elevation ${noon.elevation.toFixed(1)} is not 90 - lat - obliquity`);

  // Midsummer sunrise is NORTH of due east and sunset north of due west — the
  // thing a fixed light direction can never express, and the reason the shadows
  // swing across a year as well as across a day.
  const dawn = sunAt(new Date('2026-06-21T13:00:00Z'), LON, LAT);
  assert.ok(dawn.azimuth > 45 && dawn.azimuth < 90,
    `midsummer sunrise came out at ${dawn.azimuth.toFixed(1)} deg, not north of east`);
  assert.ok(dawn.rising, 'the morning sun is not rising');

  const dusk = sunAt(new Date('2026-06-22T02:30:00Z'), LON, LAT);
  assert.ok(dusk.azimuth > 270 && dusk.azimuth < 330,
    `midsummer sunset came out at ${dusk.azimuth.toFixed(1)} deg, not north of west`);
  assert.ok(!dusk.rising, 'the evening sun is not setting');

  // Morning and afternoon are not mirror images. acos alone cannot tell them
  // apart — the sun is at the same elevation either side of noon — so this is
  // the assertion that catches the hour-angle flip going missing.
  // Solar noon is found rather than assumed: it is a quarter-hour from clock
  // noon at this longitude and wanders across the year with the equation of
  // time, so a hard-coded pair of timestamps would be testing the calendar.
  let noonAt = null;
  for (let m = 0; m < 1440; m += 1) {
    const when = new Date(Date.UTC(2026, 2, 20, 0, m));
    const { hourAngle } = sunAt(when, LON, LAT);
    if (Math.abs(hourAngle) < 0.13) { noonAt = when; break; }  // 0.13 deg ~ 30 s
  }
  assert.ok(noonAt, 'no solar noon found in the day');
  const before = sunAt(new Date(noonAt.getTime() - 2 * 3600_000), LON, LAT);
  const after = sunAt(new Date(noonAt.getTime() + 2 * 3600_000), LON, LAT);
  assert.ok(Math.abs(before.elevation - after.elevation) < 1,
    `two hours either side of solar noon gave elevations `
    + `${before.elevation.toFixed(2)} and ${after.elevation.toFixed(2)}`);
  assert.ok(before.azimuth < 180 && after.azimuth > 180,
    `two hours either side of noon gave ${before.azimuth.toFixed(0)} and `
    + `${after.azimuth.toFixed(0)} — the afternoon is a mirror of the morning`);
});
