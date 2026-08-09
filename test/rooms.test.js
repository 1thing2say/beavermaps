// src/rooms.json — the join between my campus's class schedule and this map.
//
// Two datasets that share no key. The schedule says "Main Campus, STEM, 320";
// the map has a building called "Diane Bryant STEM Innovation Center". Nothing
// links them but a table of names written by hand in scripts/build-rooms.mjs,
// and every way that table can be wrong is silent:
//
//   - a name the schedule adds next term resolves to nothing and the rooms in
//     it simply stop being findable
//   - a name that fuzzy-matches the WRONG thing sends someone across campus,
//     which is worse than not answering at all
//   - a room number used by two buildings, collapsed to one, is wrong 30% of
//     the time on exactly the busiest rooms
//
// None of those throw. They all just answer a search incorrectly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root, CAMPUS, load, metresBetween } from './helpers.js';

const rooms = JSON.parse(readFileSync(path.join(root, 'src', 'rooms.json'), 'utf8'));
const buildings = Object.values(rooms.buildings);
const here = buildings.filter((b) => !b.offCampus);

test('every building the schedule names is either placed or explained', () => {
  // The whole point of the artifact. A name with neither a coordinate nor a
  // reason is a room nobody can find, and it would arrive silently — the
  // generator would still write a valid file.
  for (const b of here) {
    assert.ok(
      b.coords || b.spread,
      `"${b.name}" teaches ${b.sections} sections here and resolves to nothing`,
    );
    if (b.spread) assert.ok(!b.coords, `"${b.name}" claims to be spread out and pins a point anyway`);
  }
  // ...and the reverse: nothing off this campus gets a coordinate on it. my campus
  // teaches at two outreach centres and a dozen union halls, and "your class is
  // in Fresno" is a legitimate answer that must not be drawn on the campus.
  for (const b of buildings.filter((x) => x.offCampus)) {
    assert.ok(!b.coords, `"${b.name}" is off campus but carries coordinates`);
  }
});

test('the coordinates are the map\'s own, not invented', () => {
  // The generator copies an anchor out of directory.json, labels.json or
  // places.json. Re-derive the lookup here from those three files: if a name is
  // ever matched to a feature that does not exist, or the geometry moves under
  // it, the copy and the source stop agreeing.
  const known = new Map();
  for (const f of load('directory').features) {
    if (!known.has(f.properties.name)) known.set(f.properties.name, 'building');
  }
  for (const f of load('labels').features) {
    if (!known.has(f.properties.text)) known.set(f.properties.text, 'label');
  }
  for (const f of load('places').features) {
    if (f.geometry && !known.has(f.properties.name)) known.set(f.properties.name, 'place');
  }

  for (const b of here.filter((x) => x.coords)) {
    assert.ok(known.has(b.mapName), `"${b.name}" points at "${b.mapName}", which is not on this map`);
    assert.equal(known.get(b.mapName), b.mapKind, `"${b.mapName}" is not a ${b.mapKind}`);
    const [lon, lat] = b.coords;
    assert.ok(
      lon > CAMPUS.west && lon < CAMPUS.east && lat > CAMPUS.south && lat < CAMPUS.north,
      `"${b.name}" is placed at ${b.coords}, which is not near my campus`,
    );
  }
});

test('two buildings that share a room number are not in the same place', () => {
  // The reason `rooms` has to stay a list. Science and Technical Education West
  // both number 400-412, so "401" is a genuine question rather than a lookup —
  // and it is only worth asking because the two answers are far enough apart to
  // walk to the wrong one.
  const placed = new Map(here.filter((b) => b.coords).map((b) => [b.name, b.coords]));
  let checked = 0;
  for (const [room, names] of Object.entries(rooms.rooms)) {
    assert.ok(Array.isArray(names), `room ${room} is not a list`);
    if (names.length < 2) continue;
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const [a, b] = [placed.get(names[i]), placed.get(names[j])];
        if (!a || !b) continue;
        const apart = metresBetween(a, b);
        assert.ok(apart > 20, `room ${room}: ${names[i]} and ${names[j]} are ${apart.toFixed(0)} m apart`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 15, `only ${checked} colliding pairs — the collisions have gone missing`);
});

test('the room index and the building index say the same thing', () => {
  // They are written from one pass but stored twice, because a search needs
  // both directions: a typed room number goes one way, a tapped building the
  // other. Nothing but this notices if a later edit updates only one.
  const fromBuildings = new Map();
  for (const b of buildings) {
    if (b.offCampus) continue;
    for (const room of b.rooms) {
      if (!fromBuildings.has(room)) fromBuildings.set(room, new Set());
      fromBuildings.get(room).add(b.name);
    }
  }
  assert.deepEqual(
    Object.keys(rooms.rooms).sort(),
    [...fromBuildings.keys()].sort(),
    'the two indexes cover different rooms',
  );
  for (const [room, names] of Object.entries(rooms.rooms)) {
    assert.deepEqual(names, [...fromBuildings.get(room)].sort(), `room ${room} disagrees`);
  }
});

test('every class resolves to a building that exists', () => {
  // The half of this that has no ambiguity: the schedule always states the
  // building, so a course code always has an answer. 539 of them.
  const named = new Set(buildings.map((b) => b.name));
  assert.ok(Object.keys(rooms.courses).length > 400, 'the course index is suspiciously small');
  for (const [course, { title, in: names }] of Object.entries(rooms.courses)) {
    assert.ok(title, `${course} has no title to show in a result row`);
    assert.ok(names.length > 0, `${course} names no building`);
    for (const name of names) assert.ok(named.has(name), `${course} names unknown building "${name}"`);
  }
  // A course taught in two buildings is normal — a lecture and its lab — and
  // the artifact must keep both rather than collapsing to the first.
  const split = Object.values(rooms.courses).filter((c) => c.in.length > 1);
  assert.ok(split.length > 20, `only ${split.length} courses span more than one building`);
  // Courses keep their off-campus meetings, because "that class is at Natomas"
  // is the right answer to give and the room index cannot give it.
  const away = new Set(buildings.filter((b) => b.offCampus).map((b) => b.name));
  const reachesAway = Object.values(rooms.courses).filter((c) => c.in.some((n) => away.has(n)));
  assert.ok(reachesAway.length > 0, 'no course reaches an outreach centre — they were dropped');
});

test('the artifact says which term it is, because it will go stale', () => {
  // A schedule is true for one term. Anything built from it has to carry that
  // on its face, or next August it is quietly wrong and nothing says so.
  assert.match(rooms.term.strm, /^\d{4}$/);
  assert.ok(rooms.term.name && rooms.term.retrieved, 'the term is not named or dated');
  assert.match(rooms.source, /^https:\/\//);
});
