// src/building-kinds.js — the browse-buildings grid.
//
// Ten tiles over a classification that lives in another file, drawn with
// pictograms that live in a third, keyed into a table shared with a fourth.
// Every one of those is a join that is right on the day it is written, and
// three of the four failure modes are silent: a class poi.js grows with no tile
// is a building nobody can browse to, a tile whose id has no pictogram is a
// blank rectangle, and an id that collides with a legend row outlines the wrong
// ground. None of them throws.

import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';
import {
  BUILDING_KINDS, BUILDING_KIND_BY_ID, kindRow, groupBuildings,
  uncoveredClasses,
} from '../src/building-kinds.js';
import { POI_CLASSES, poiFor } from '../src/poi.js';
import { CATEGORIES } from '../src/categories.js';
import { GLYPH_KINDS, pinColour, glyphInk, textInk, glyphSvg } from '../src/map-images.js';
import { buildAreas, highlightForKind, extentOf } from '../src/highlight.js';

const directory = load('directory');
const groups = groupBuildings(directory, poiFor);

test('every class poi.js can return has a tile, and no tile invents one', () => {
  assert.deepEqual(uncoveredClasses(), [], 'a building nobody can browse to');
  for (const kind of BUILDING_KINDS) {
    assert.ok(POI_CLASSES[kind.id], `${kind.id} is not a class poi.js knows`);
  }
  assert.equal(BUILDING_KINDS.length, Object.keys(POI_CLASSES).length);
  assert.equal(BUILDING_KIND_BY_ID.size, BUILDING_KINDS.length, 'a duplicate id');
});

test('a tile can actually be drawn: a pictogram, a hue and ink that shows on it', () => {
  for (const kind of BUILDING_KINDS) {
    assert.ok(GLYPH_KINDS.includes(kind.id), `${kind.id} has no pictogram`);
    assert.notEqual(glyphSvg(kind.id), '', kind.id);
    const tint = pinColour(kind.id);
    assert.match(tint, /^#[0-9a-f]{6}$/i, kind.id);
    assert.notEqual(glyphInk(tint).toLowerCase(), tint.toLowerCase(), kind.id);
  }
});

/** WCAG relative luminance, and the ratio between two colours. */
function contrast(a, b) {
  const lum = (hex) => {
    const chan = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, bl] = [1, 3, 5].map((i) => chan(parseInt(hex.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}

test('the label on a tile clears the bar for TEXT, not the one for a picture', () => {
  // Restated here rather than read off map-images.js, so a change to the rule
  // there has to survive an independent calculation of the same number.
  //
  // The distinction is the whole reason textInk exists: white on the food
  // orange, the sport green and the arts purple measures 3.09, 3.08 and 3.25,
  // which passes WCAG's 3:1 for a pictogram and fails its 4.5:1 for a word.
  for (const kind of BUILDING_KINDS) {
    const tint = pinColour(kind.id);
    const ratio = contrast(tint, textInk(tint));
    assert.ok(ratio >= 4.5, `${kind.label}: ${textInk(tint)} on ${tint} is ${ratio.toFixed(2)}:1`);
  }
});

test('the two ink rules disagree, which is why there are two of them', () => {
  // If this ever passes with nothing in it, the palette has moved and one of
  // the rules has become dead weight.
  const split = BUILDING_KINDS.filter((kind) => {
    const tint = pinColour(kind.id);
    return glyphInk(tint) !== textInk(tint);
  });
  assert.ok(split.length > 0, 'glyphInk and textInk now agree everywhere');
});

test('a label fits a tile half a phone wide', () => {
  for (const kind of BUILDING_KINDS) {
    assert.ok(kind.label.length <= 17, `"${kind.label}" is too long for a tile`);
    // A name, not a description. POI_CLASSES' strings are lists — "Arts, music
    // and performance", "Library and learning resources" — which is right under
    // a building's name on its card and four wrapped lines on a tile. Two of
    // the ten coincide, because "Bookstore" and "Parking structure" were
    // already names; the test is the shape, not the difference.
    assert.doesNotMatch(kind.label, /,| and /, `"${kind.label}" is a description`);
  }
});

test('the catch-all is last', () => {
  // `campus` is what a building is when nothing more specific is true of it,
  // and it holds nearly half of them. Leading with it would put the least
  // informative tile under the thumb.
  assert.equal(BUILDING_KINDS.at(-1).id, 'campus');
  assert.ok(groups.get('campus').length > groups.get('library').length);
});

test('a tile id cannot be mistaken for a legend row', () => {
  // Both families are keyed into one `legendHighlights` table, and they DO
  // collide bare: my campus's legend has a `parking` row — 22 car parks — and poi.js
  // has a `parking` class, which is the multi-storey. Namespacing is what keeps
  // pressing one from outlining the other's ground.
  const legend = new Set(CATEGORIES.map((c) => c.id));
  const bare = BUILDING_KINDS.filter((k) => legend.has(k.id)).map((k) => k.id);
  assert.ok(bare.length > 0, 'the collision this guards has gone; check kindRow is still needed');
  for (const kind of BUILDING_KINDS) {
    assert.ok(!legend.has(kindRow(kind.id)), `${kindRow(kind.id)} collides`);
  }
});

test('every named building in the directory lands in exactly one group', () => {
  const named = directory.features.filter((f) => f.properties?.name);
  const total = [...groups.values()].reduce((n, list) => n + list.length, 0);
  assert.equal(total, named.length, 'a building fell out of the grid');

  const seen = new Set();
  for (const list of groups.values()) {
    for (const props of list) {
      assert.ok(!seen.has(props.name), `${props.name} is in two groups`);
      seen.add(props.name);
    }
  }
});

test('no tile is empty, because an empty one is a press with no answer', () => {
  for (const kind of BUILDING_KINDS) {
    assert.ok(groups.get(kind.id).length >= 1, `${kind.label} holds nothing`);
  }
});

test('the groups are the ones somebody who knows the campus would expect', () => {
  const names = (id) => groups.get(id).map((p) => p.name);
  assert.deepEqual(names('library'), ['Learning Resource Center (LRC)', 'Library']);
  assert.deepEqual(names('parking'), ['Parking Garage']);
  assert.deepEqual(names('civic'), ['College Police']);
  assert.deepEqual(names('food'), ['Evangelisti Culinary Arts Center']);
  assert.ok(names('sport').includes('Gym'));
  assert.ok(names('sport').includes('Pool'));
  // Rec. is Receiving, a loading dock, and it belongs with the yards.
  assert.ok(names('works').includes('Rec.'));
  assert.ok(!names('sport').includes('Rec.'));
});

test('a group is sorted, so the same press twice gives the same list', () => {
  for (const kind of BUILDING_KINDS) {
    const names = groups.get(kind.id).map((p) => p.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), kind.label);
  }
});

test('nothing is grouped when the directory has not landed', () => {
  const cold = groupBuildings(null, poiFor);
  assert.equal(cold.size, BUILDING_KINDS.length);
  for (const list of cold.values()) assert.deepEqual(list, []);
});

// --- what a press outlines ---------------------------------------------------

const areas = buildAreas({
  directory,
  buildings: load('buildings'),
  basemap: load('basemap'),
});

test('a class outlines its own buildings and nothing else', () => {
  for (const kind of BUILDING_KINDS) {
    const { indices, points, counts } = highlightForKind(kind.id, { areas, classify: poiFor });
    assert.ok(indices.length >= 1, `${kind.label} outlines nothing`);
    // A building class is never about loose points: every member is a shape.
    assert.deepEqual(points, []);
    assert.equal(counts.outside, 0);
    assert.equal(counts.zones, 0);
    assert.equal(counts.buildings, indices.length);
    for (const i of indices) {
      assert.equal(areas[i].kind, 'building', `${kind.label} outlined a zone`);
      assert.equal(poiFor(areas[i].name), kind.id, `${areas[i].name} is not ${kind.id}`);
    }
  }
});

test('the classes partition every named building area between them', () => {
  const named = areas
    .map((area, i) => ({ area, i }))
    .filter(({ area }) => area.kind === 'building' && area.name);
  const claimed = new Set();
  for (const kind of BUILDING_KINDS) {
    for (const i of highlightForKind(kind.id, { areas, classify: poiFor }).indices) {
      assert.ok(!claimed.has(i), `${areas[i].name} is outlined by two tiles`);
      claimed.add(i);
    }
  }
  assert.equal(claimed.size, named.length);
});

test('an outline has a rectangle the camera can be pointed at', () => {
  for (const kind of BUILDING_KINDS) {
    const box = extentOf(areas, highlightForKind(kind.id, { areas, classify: poiFor }));
    assert.equal(box.length, 2, kind.label);
    const [[west, south], [east, north]] = box;
    assert.ok(east >= west && north >= south, kind.label);
    // On this campus, not off it.
    assert.ok(west > -121.36 && east < -121.34, `${kind.label} ${west} ${east}`);
    assert.ok(south > 38.640 && north < 38.660, `${kind.label} ${south} ${north}`);
  }
});

test('an unknown class outlines nothing rather than everything', () => {
  const { indices, counts } = highlightForKind('not-a-class', { areas, classify: poiFor });
  assert.deepEqual(indices, []);
  assert.equal(counts.buildings, 0);
});
