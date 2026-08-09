// The remaining committed artifacts, and the joins between them.
//
// The cross-file checks are the point. Each generator is correct on its own
// terms; what breaks silently is agreement — an amenity class with no icon
// registered for it, or a label kind the style has no colour for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, CAMPUS, ringAreaM2, pointInRing } from './helpers.js';

import { AMENITY_KINDS } from '../src/map-images.js';
import { ICON_NAMES } from '../src/g-icons.js';
import { CATEGORIES, collect } from '../src/categories.js';
import { POI_CLASSES, POI_LABEL_KINDS, poiFor } from '../src/poi.js';

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

// The app hides my campus's printed pictograms for the classes it redraws itself, so
// that one symbol does not get two icon languages stacked on it. That is only
// safe while the redrawing actually covers them — and it silently stopped
// covering them once already: the sheet draws fifteen bicycle-and-P signs and
// the size match in build-amenities.mjs was finding fourteen, so hiding the
// layer would have deleted the fifteenth outright.
test('every printed marker the app hides is redrawn as a disc', () => {
  const centre = (geometry) => {
    let x = 0; let y = 0; let n = 0;
    const walk = (c) => {
      if (typeof c[0] === 'number') { x += c[0]; y += c[1]; n += 1; } else c.forEach(walk);
    };
    walk(geometry.coordinates);
    return [x / n, y / n];
  };
  const metres = ([aLon, aLat], [bLon, bLat]) => Math.hypot(
    (aLon - bLon) * 111320 * Math.cos((aLat * Math.PI) / 180),
    (aLat - bLat) * 111320,
  );

  const discs = load('amenities').features.map((f) => f.geometry.coordinates);
  const hidden = load('basemap').features
    .filter((f) => f.properties.kind === 'parking_marker' || f.properties.kind === 'bike_marker');
  assert.ok(hidden.length > 80, `only ${hidden.length} hidden markers`);

  const far = hidden
    .map((f) => Math.min(...discs.map((q) => metres(centre(f.geometry), q))))
    .filter((d) => d > 10);

  // The only parts further than 10 m from a disc are the eight that draw my campus's
  // two Student Drop-Off symbols. Those are painted on the kerb while the disc
  // replacing them sits on the routing node my campus binds that destination to, so
  // the symbol moves ~21 and ~30 m rather than disappearing. Pinned by count so
  // a third stray cannot join them unnoticed.
  assert.equal(far.length, 8, `${far.length} hidden markers have no disc within 10 m`);
  assert.ok(Math.max(...far) < 32, `worst uncovered marker is ${Math.max(...far).toFixed(0)} m away`);
});

// Every printed building name gets a coloured POI disc beside it. Two ways that
// breaks without a word: a class with no image registered draws the fallback
// disc, and a rule that stops matching quietly demotes a building to the
// generic one — neither shows up as an error, only as a map that looks slightly
// wrong to someone who knows the campus.
test('every building label resolves to a registered POI disc', () => {
  for (const id of Object.keys(POI_CLASSES)) {
    assert.ok(AMENITY_KINDS.includes(id), `poi class ${id} has no disc in map-images.js`);
  }

  const { features } = load('labels');
  const named = features.filter((f) => POI_LABEL_KINDS.has(f.properties.kind));
  assert.ok(named.length > 30, `only ${named.length} building labels`);

  const seen = new Map();
  for (const f of named) {
    const icon = poiFor(f.properties.text);
    // "Closed" is the sheet's word for a fenced-off area and gets no disc; it
    // is the only label allowed to opt out, and naming it here means a rule
    // that starts swallowing real buildings fails rather than passes.
    if (icon === null) {
      assert.match(f.properties.text, /^Closed$/, `${f.properties.text} got no POI disc`);
      continue;
    }
    assert.ok(POI_CLASSES[icon], `${f.properties.text} -> unknown poi class ${icon}`);
    seen.set(icon, (seen.get(icon) ?? 0) + 1);
  }

  // The specific ones are the point of the exercise. If these fall back to
  // `campus` the map is a wall of identical blue discs again.
  for (const id of ['arts', 'food', 'sport', 'library', 'store', 'civic', 'works']) {
    assert.ok(seen.get(id) > 0, `no building classified as ${id}`);
  }
  // Ordering guards, both marked in src/poi.js: these two contain a word that
  // an earlier-ordered rule would otherwise win.
  assert.equal(poiFor('Evangelisti Culinary Arts Center'), 'food');
  assert.equal(poiFor('Arts & Sci'), 'campus');
});

// The chip strip spans four files: a category names a glyph in g-icons.js, a
// pin image in map-images.js, amenity kinds in amenities.json and a name
// pattern over places.json. Every one of those joins fails silently — a chip
// with a dead regex still renders, still presses, and reports "Nothing found".
test('every category resolves against the data and the icon sets', () => {
  const amenities = load('amenities');
  const places = load('places');
  const kinds = new Set(amenities.features.map((f) => f.properties.kind));
  const sheetKinds = new Set(load('basemap').features.map((f) => f.properties.kind));

  for (const category of CATEGORIES) {
    assert.ok(ICON_NAMES.includes(category.glyph),
      `${category.id}: g-icons.js has no glyph "${category.glyph}"`);
    assert.ok(category.legend, `${category.id} has no legend text`);

    for (const kind of category.kinds ?? []) {
      assert.ok(kinds.has(kind), `${category.id}: amenities.json has no ${kind}`);
    }
    // Only a `match` category drops its own pins, so only it needs an image.
    if (category.match) {
      assert.ok(AMENITY_KINDS.includes(category.icon),
        `${category.id}: map-images.js has no disc "${category.icon}"`);
    }
    // `zones` names a class of the printed sheet for the legend to outline. A
    // typo here costs nothing visible — the row simply outlines no ground and
    // reports fewer zones than there are — so the join is asserted instead.
    if (category.zones) {
      assert.ok(sheetKinds.has(category.zones),
        `${category.id}: basemap.json has no "${category.zones}" class`);
    }

    const hits = collect(category, { amenities, places });
    assert.ok(hits.length > 0, `${category.id} matches nothing`);
    for (const hit of hits) {
      assert.ok(hit.name, `${category.id} has a nameless hit`);
      assert.ok(AMENITY_KINDS.includes(hit.icon),
        `${category.id}: no disc registered for "${hit.icon}"`);
      assert.ok(onCampus(hit.coords), `${category.id}: ${hit.name} is off campus`);
    }
  }
});

// The appearance control names its glyphs by mode. `icon()` returns an empty
// string for a name it does not know rather than throwing, so a rename here
// costs a blank rail button and nothing says a word about it.
test('the appearance control has a glyph for every mode', () => {
  for (const mode of ['light', 'dark', 'auto']) {
    assert.ok(ICON_NAMES.includes(mode), `g-icons.js has no "${mode}" glyph`);
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
