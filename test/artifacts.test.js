// The remaining committed artifacts, and the joins between them.
//
// The cross-file checks are the point. Each generator is correct on its own
// terms; what breaks silently is agreement — an amenity class with no icon
// registered for it, or a label kind the style has no colour for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, CAMPUS, ringAreaM2, pointInRing } from './helpers.js';

import { AMENITY_KINDS } from '../src/map-images.js';

// build-labels.mjs reduces my campus's database names the same way; this repeats the
// two mechanical rules so the join can be checked without importing the script,
// which needs pdftotext and the gitignored source.
const tidy = (raw) => raw
  .replace(/\s*\((?:Rm|Room)[^)]*\)/i, '')
  .replace(/,?\s*Room\s+\d+\w*/i, '')
  .replace(/\s+Division$/i, '')
  .replace(/^Police - College$/, 'College Police')
  .replace(/^Bookstore - College Store$/, 'Bookstore')
  .trim();

const onCampus = ([lon, lat]) =>
  lon > CAMPUS.west && lon < CAMPUS.east && lat > CAMPUS.south && lat < CAMPUS.north;

test('buildings have plausible footprints and heights', () => {
  const { features } = load('buildings');
  assert.ok(features.length > 50, `only ${features.length} footprints`);
  for (const f of features) {
    assert.equal(f.geometry.type, 'Polygon');
    const area = ringAreaM2(f.geometry.coordinates[0]);
    // build-buildings.mjs floors at 60 m2; the largest is the parking garage.
    assert.ok(area > 50, `footprint covers only ${area.toFixed(0)} m2`);
    assert.ok(f.properties.height > 0 && f.properties.height < 60,
      `height ${f.properties.height} m`);
    // The extrusion reads area_m2 nowhere, but a disagreement means the file was
    // hand-edited rather than regenerated.
    assert.ok(Math.abs(area - f.properties.area_m2) / area < 0.1,
      `area_m2 ${f.properties.area_m2} disagrees with the geometry's ${area.toFixed(0)}`);
  }
});

// src/map-images.js draws one pictogram per kind and addresses them with
// ['get', 'kind']. A kind with no entry renders as a bare fallback disc, and
// nothing in the app logs it.
test('every amenity class has an icon registered for it', () => {
  const { features } = load('amenities');
  assert.ok(features.length > 50, `only ${features.length} amenities`);
  const kinds = new Set(features.map((f) => f.properties.kind));
  for (const kind of kinds) {
    assert.ok(AMENITY_KINDS.includes(kind), `amenities.json has ${kind} but map-images.js has no icon`);
  }
  for (const f of features) {
    assert.equal(f.geometry.type, 'Point');
    assert.ok(onCampus(f.geometry.coordinates), `${f.properties.kind} is off campus`);
    assert.ok(f.properties.label, `${f.properties.kind} has no label`);
  }
});

test('labels carry usable text at a usable size', () => {
  const { features } = load('labels');
  assert.ok(features.length > 30, `only ${features.length} labels`);
  const kinds = new Set(['area', 'building', 'plate', 'parking']);
  for (const f of features) {
    const { text, kind, pt } = f.properties;
    assert.ok(kinds.has(kind), `unknown label kind ${kind}`);
    assert.ok(typeof text === 'string' && text.trim().length > 1,
      `unusable label text ${JSON.stringify(text)}`);
    assert.ok(pt > 3 && pt < 30, `${text} is set at ${pt} pt`);
    assert.ok(onCampus(f.geometry.coordinates), `${text} is off campus`);
  }
});

// Names taken from my campus's database are added only where the printed sheet leaves
// a building bare, and they are anchored at the footprint's pole of
// inaccessibility so the name lands on the building rather than beside it.
test('names added from the database sit inside a footprint', () => {
  const added = load('labels').features.filter((f) => f.properties.source === 'arc');
  assert.ok(added.length > 0, 'no labels were added from my campus names');

  const footprints = load('buildings').features;
  for (const label of added) {
    const host = footprints.find((f) => pointInRing(label.geometry.coordinates, f.geometry.coordinates[0]));
    assert.ok(host, `"${label.properties.text}" is not on any footprint`);
    assert.equal(tidy(host.properties.name), label.properties.text,
      `"${label.properties.text}" sits on ${host.properties.name}`);
    // Fitted to the building rather than to the sheet's 8-em default.
    assert.ok(label.properties.maxWidth >= 5 && label.properties.maxWidth <= 12,
      `${label.properties.text} wraps at ${label.properties.maxWidth} ems`);
  }
});

// One label per name. Health Education Complex is nine separate footprints and
// Portable Village is seven; naming each one prints the name nine times.
//
// Scoped to within a kind, because the sheet genuinely carries two Stadiums: the
// car park is labelled "Stadium" and the venue it serves "STADIUM".
test('no name is printed twice within a kind', () => {
  const seen = new Map();
  for (const f of load('labels').features) {
    const key = `${f.properties.kind}/${f.properties.text.toLowerCase()}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, n] of seen) assert.equal(n, 1, `${key} appears ${n} times`);
});

// build-labels.mjs cuts curved text runs out of the PDF's text layer, and the
// failure mode is fragments: "n L", "Sta", "use". Those were suppressed by an
// explicit list, so a new one appearing means the discriminator has drifted.
test('no label is a fragment of another', () => {
  const texts = load('labels').features.map((f) => f.properties.text);
  for (const text of texts) {
    if (text.length > 4) continue;
    assert.ok(
      /^[A-Z][a-z]*\.?$|^[A-Z]{2,}$/.test(text),
      `"${text}" looks like a fragment of a longer label`,
    );
  }
});

test('the directory keeps unpositioned rows searchable rather than dropping them', () => {
  const { features } = load('places');
  const positioned = features.filter((f) => f.geometry);
  const unpositioned = features.filter((f) => !f.geometry);
  assert.ok(positioned.length > 100);
  // my campus lists divisions with no room assigned. They are kept so the search index
  // can still be built from the file; src/main.js filters them on the way into
  // the vector source, because a null geometry cannot be tiled.
  for (const f of unpositioned) {
    assert.equal(f.properties.kind, 'unpositioned');
    assert.ok(f.properties.name, 'an unpositioned row has no name');
  }
  for (const f of positioned) assert.ok(onCampus(f.geometry.coordinates), `${f.properties.name} is off campus`);
});

test('every place has a name the search box can match', () => {
  for (const f of load('places').features) {
    const { name } = f.properties;
    assert.ok(typeof name === 'string' && name.trim(), 'a place has no name');
  }
});
