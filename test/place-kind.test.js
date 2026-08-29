// src/place-kind.js — which mark a list row wears.
//
// The join between three files that were written apart: my campus's directory, my campus's
// printed key, and this map's own classification of a building name. Every one
// of the five sources it consults is a spelling agreement between two files,
// which is exactly the kind of thing that is right on the day it is written and
// quietly wrong after an import. So the tests are mostly about coverage over
// the real data rather than about the function's shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';
import { placeIndex, FALLBACK_KIND } from '../src/place-kind.js';
import { GLYPH_KINDS, pinColour, glyphInk, glyphSvg } from '../src/map-images.js';
import { poiFor } from '../src/poi.js';

const directory = load('directory');
const amenities = load('amenities');
const places = load('places');
const kindOf = placeIndex({ directory, amenities });

const names = [...new Set(places.features.map((f) => f.properties.name))];

test('every kind it can return is a pictogram map-images.js can draw', () => {
  const drawable = new Set(GLYPH_KINDS);
  for (const name of names) {
    const kind = kindOf(name);
    assert.ok(drawable.has(kind), `${name} -> ${kind}, which nothing draws`);
    assert.notEqual(glyphSvg(kind), '', `${kind} has no markup`);
  }
  assert.ok(drawable.has(FALLBACK_KIND));
});

test('every directory building is classified as poi.js classifies it', () => {
  // The map draws a disc beside each of these names from poiFor; the sheet
  // draws a squircle beside the same names from here. A row and the disc over
  // its own footprint disagreeing is the one failure worth a test of its own.
  for (const feature of directory.features) {
    const { name } = feature.properties;
    if (!name) continue;
    assert.equal(kindOf(name), poiFor(name), `${name}`);
  }
});

test('a building answers to every name it has', () => {
  for (const feature of directory.features) {
    const { name, officialName, parts } = feature.properties;
    const want = kindOf(name);
    for (const alias of [officialName, ...(parts ?? [])]) {
      if (!alias) continue;
      assert.equal(kindOf(alias), want, `${alias} is part of ${name}`);
    }
  }
});

test('a legend symbol keeps its own pictogram, in either number', () => {
  // "Emergency telephones" is how the Parking Garage's row counts them and
  // "Emergency telephone" is how the key names the symbol. The plural used to
  // miss, fall through to the building holding it, and come out a blue P.
  assert.equal(kindOf('Emergency telephone'), 'emergency_phone');
  assert.equal(kindOf('Emergency telephones'), 'emergency_phone');
  assert.equal(kindOf('Defibrillator'), 'defibrillator');
  assert.equal(kindOf('All Gender Restroom'), 'restroom');
});

test("a row's own name beats the building it sits in", () => {
  // The cafeteria is inside the Student Center, which is a general campus
  // building; the cafeteria is food wherever it is.
  assert.equal(kindOf('Cafeteria (servery open M-Th 8am-2:30pm Fr 8am-2pm)'), 'food');
  // ...and a room with nothing in its own name takes its building's class.
  assert.equal(kindOf('Design Hub'), kindOf('Career Technical Education (CTE)'));
});

test('the things my campus lists that are not buildings', () => {
  assert.equal(kindOf('Myrtle Parking Lot East'), 'parking');
  assert.equal(kindOf('Stadium Parking Lot'), 'parking');
  assert.equal(kindOf('Bus 82 Heading South'), 'bus_stop');
  assert.equal(kindOf('Para Transit'), 'bus_stop');
  assert.equal(kindOf('Student Drop-off and Pick-up North'), 'drop_off');
  assert.equal(kindOf('Tennis Courts'), 'sport');
  // Arts HomeBase is a HomeBase, and the word Arts in it is not the answer —
  // which is why the homebase rule is first.
  assert.equal(kindOf('Arts HomeBase'), 'homebase');
});

test('Rec. is Receiving, and Receiving is not recreation', () => {
  // my campus's directory spells this building Receiving: 519 m2 of loading dock in
  // the service corner. poi.js used to carry a \brec\b in its sport rule and
  // painted it green on the map.
  assert.equal(poiFor('Rec.'), 'works');
  assert.equal(kindOf('Rec.'), 'works');
  assert.equal(kindOf('Receiving'), 'works');
});

test('nothing in my campus\'s directory falls all the way through by accident', () => {
  // The fallback is a true statement — a name this map has never heard of on
  // this campus is a building — but it is also where a broken join would land
  // silently. This is the count on the day it was written; a change to it is a
  // change worth looking at rather than a failure.
  const fell = names.filter((name) => kindOf(name) === FALLBACK_KIND);
  assert.ok(
    fell.length <= 60,
    `${fell.length} of ${names.length} rows are unclassified:\n  ${fell.join('\n  ')}`,
  );
  // ...and most of the list is not the default.
  assert.ok(fell.length < names.length * 0.55, `${fell.length}/${names.length}`);
});

test('an empty index still answers, and answers sensibly', () => {
  // The lists render before the overlays land. Every source is missing here
  // except poi.js's own rules, which need no data file.
  const cold = placeIndex();
  assert.equal(cold('Library'), 'library');
  assert.equal(cold('Kaneko Art Gallery'), 'arts');
  assert.equal(cold('Something Nobody Has Heard Of'), FALLBACK_KIND);
  assert.equal(cold(''), FALLBACK_KIND);
  assert.equal(cold(null), FALLBACK_KIND);
});

test('every mark has ink that can be seen on it', () => {
  // glyphInk picks white or the map's near-black by WCAG contrast. The test is
  // that the choice is actually being made for every hue a row can wear, since
  // exactly one of them — the emergency yellow — fails white.
  const kinds = new Set(names.map(kindOf));
  for (const kind of kinds) {
    const tint = pinColour(kind);
    const ink = glyphInk(tint);
    assert.match(ink, /^#[0-9a-f]{6}$/i, kind);
    assert.notEqual(ink.toLowerCase(), tint.toLowerCase(), kind);
  }
});
