// src/search-rank.js — what typing into the box actually finds.
//
// This is the whole behaviour of the search field and it had never been asked a
// question, because it lived inside startApp() and read its index, its
// popularity bonus and its DOM out of a scope nothing could enter.
//
// Against the real places.json, deliberately. A ranking tested on a fixture is
// a ranking tested on the fixture: the interesting cases here are all about
// this campus's actual names — a building whose description lists what is
// inside it, a dozen rows that all begin with the same word, two names where
// one contains the other.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RESULTS, normalise, buildPlaceIndex, scoreTerm, rankPlaces, search, popularEntries,
} from '../src/search-rank.js';
import { load } from './helpers.js';
import { NAME_ALIASES, directoryFeature } from '../src/place-names.js';
import { MAX_BONUS, recordVisit, forgetVisits } from '../src/popular.js';

const places = load('places');
const index = buildPlaceIndex(places.features);
/** The rows that can actually be walked to — what the index is built from. */
const located = places.features.filter((f) => f.geometry);

const names = (entries) => entries.map((e) => e.name);
const find = (query) => names(rankPlaces(index, query));

test('normalise folds a query down to lowercase ASCII words', () => {
  assert.equal(normalise('Student Center'), 'student center');
  assert.equal(normalise('  STEM-213  '), 'stem 213');
  assert.equal(normalise('Café'), 'cafe', 'an accent nobody can type blocked the match');
  assert.equal(normalise(null), '');
  assert.equal(normalise(undefined), '');
});

test('the index collapses repeated names into one entry holding every position', () => {
  // my campus lists a class like "Defibrillator" once per node and build-places
  // splits that into one feature each. Six identical rows is noise.
  assert.ok(index.length < located.length,
    'nothing collapsed — either the data changed or the grouping stopped working');
  assert.equal(index.length, new Set(located.map((f) => f.properties.name)).size);

  const spread = index.find((e) => e.points.length > 1);
  assert.ok(spread, 'no name appears at more than one position any more');
  assert.ok(spread.points.every((p) => Array.isArray(p) && p.length === 2));
});

test('every entry carries a searchable key and haystack', () => {
  for (const entry of index) {
    assert.equal(typeof entry.nameKey, 'string');
    assert.ok(entry.haystack.includes(entry.nameKey) || entry.nameKey === '',
      `${entry.name}: the name is not in its own haystack`);
  }
});

test('an exact name beats a prefix beats a word beats a substring beats a description', () => {
  // The bands have to stay ordered and far enough apart that no pile of weak
  // matches climbs into a strong one — that gap is what lets the popularity
  // bonus be added afterwards without crossing a band.
  const entry = { nameKey: 'library', haystack: 'library books and study rooms' };
  assert.equal(scoreTerm(entry, 'library'), 100);
  assert.equal(scoreTerm({ ...entry, nameKey: 'library annex' }, 'library'), 80);
  assert.equal(scoreTerm({ ...entry, nameKey: 'north library' }, 'libr'), 60);
  assert.equal(scoreTerm({ ...entry, nameKey: 'publibrary' }, 'library'), 35);
  assert.equal(scoreTerm(entry, 'study'), 12);
  assert.equal(scoreTerm(entry, 'cafeteria'), 0);
});

test('a term that lands nowhere disqualifies the row outright', () => {
  // "student center" must not match a row that only has "student".
  const only = [{
    name: 'Student Lockers', nameKey: 'student lockers', haystack: 'student lockers', points: [],
  }];
  assert.deepEqual(rankPlaces(only, 'student'), only);
  assert.deepEqual(rankPlaces(only, 'student center'), []);
});

test('an empty query ranks nothing', () => {
  assert.deepEqual(rankPlaces(index, ''), []);
  assert.deepEqual(rankPlaces(index, '   '), []);
  assert.deepEqual(rankPlaces(index, '!!!'), []);
});

test('typing a building name finds that building first', () => {
  // Chosen from the data rather than typed, so this keeps working when the
  // directory is regenerated.
  const target = index.find((e) => e.nameKey.split(' ').length >= 2);
  assert.equal(find(target.name)[0], target.name);
});

test('every name in the directory can be found by typing it', () => {
  // The floor this whole feature stands on. A name that cannot find itself is
  // a row nobody can reach.
  const missed = index.filter((entry) => !find(entry.name).includes(entry.name));
  assert.deepEqual(names(missed), [], 'these names cannot find themselves');
});

test('a shorter name wins a tie against one that contains it', () => {
  // "Library" beats "Lockers for Library" among two places nobody has been to.
  const pair = [
    { name: 'Long Name Holding Library', nameKey: 'long name holding library', haystack: '', points: [] },
    { name: 'Library', nameKey: 'library', haystack: '', points: [] },
  ];
  assert.equal(rankPlaces(pair, 'library')[0].name, 'Library');
});

test('a description match is found, and ranks below a name match', () => {
  // Their descriptions enumerate what is inside each building ("This building
  // consists of Board Room, Cafeteria…"), which is why descriptions are in the
  // haystack at all — searching "cafeteria" has to find Student Center.
  const inDescriptionOnly = index.find((entry) =>
    entry.description
    && entry.haystack.includes('cafeteria')
    && !entry.nameKey.includes('cafeteria'));

  if (!inDescriptionOnly) return;   // the directory no longer says it; nothing to prove
  const hits = find('cafeteria');
  assert.ok(hits.includes(inDescriptionOnly.name), 'a description match was not found at all');

  const named = index.filter((e) => e.nameKey.includes('cafeteria')).map((e) => e.name);
  for (const byName of named) {
    assert.ok(hits.indexOf(byName) < hits.indexOf(inDescriptionOnly.name),
      `${inDescriptionOnly.name} outranked ${byName}, which has it in the name`);
  }
});

test('the popularity bonus reorders within a band and never across one', () => {
  // MAX_BONUS is bounded well under the gap between two kinds of match. If that
  // ever stops being true, one visit to the wrong place outranks spelling.
  const rows = [
    { name: 'Exact', nameKey: 'gym', haystack: 'gym', points: [] },
    { name: 'Prefix', nameKey: 'gym annex', haystack: 'gym annex', points: [] },
  ];
  const huge = () => 19;   // more than any real bonus, still under the 20-point gap
  assert.equal(rankPlaces(rows, 'gym', huge)[0].name, 'Exact');

  // ...but within one band it decides.
  const tied = [
    { name: 'Unvisited', nameKey: 'gym one', haystack: '', points: [] },
    { name: 'Visited', nameKey: 'gym two', haystack: '', points: [] },
  ];
  const favour = (name) => (name === 'Visited' ? 5 : 0);
  assert.equal(rankPlaces(tied, 'gym', favour)[0].name, 'Visited');
});

test('rooms come first and keep two places for themselves', () => {
  // Typing "320" is a lookup with a right answer, not a fuzzy name match, and
  // the place index has never heard of a room.
  const rooms = [{ room: '320' }, { room: '321' }];
  const hits = search({ index, query: 'a', rooms });
  assert.deepEqual(hits.slice(0, 2), rooms);
  assert.ok(hits.length <= MAX_RESULTS);
});

test('a query that is both a room and a building does not bury the places', () => {
  const rooms = Array.from({ length: 20 }, (_, i) => ({ room: `${i}` }));
  const hits = search({ index, query: 'a', rooms: rooms.slice(0, MAX_RESULTS - 2) });
  assert.equal(hits.length, MAX_RESULTS);
  assert.ok(hits.slice(MAX_RESULTS - 2).some((h) => h.nameKey), 'places were squeezed out entirely');
});

test('an empty query returns the rooms alone rather than the whole directory', () => {
  const rooms = [{ room: '320' }];
  assert.deepEqual(search({ index, query: '', rooms }), rooms);
});

test('the shelf an empty field shows is filtered against the index', () => {
  // These names come from the building directory and the index is built from
  // the places file; a building the two spell differently is a row that would
  // go nowhere.
  const shelf = popularEntries({ index, directory: load('directory'), limit: 6 });
  assert.ok(shelf.length > 0, 'the empty field has nothing to offer');
  assert.ok(shelf.length <= 6);
  for (const entry of shelf) {
    assert.ok(index.includes(entry), `${entry.name} is not a real destination`);
  }
});

test('the shelf never repeats a row', () => {
  const shelf = popularEntries({ index, directory: load('directory'), limit: MAX_RESULTS });
  assert.equal(new Set(names(shelf)).size, shelf.length);
});

test('a row with no position is left out of the index entirely', () => {
  // places.json keeps fourteen rows my campus lists without a room. A search
  // hit you cannot walk to is worse than no hit: choosing one reaches for
  // `entry.points[0]` and finds nothing there.
  const unlocated = places.features.filter((f) => !f.geometry);
  assert.ok(unlocated.length > 0, 'test premise: the file has rows with no geometry');

  for (const entry of index) {
    assert.ok(entry.points.length > 0, `${entry.name} is in the index with nowhere to go`);
  }
  // ...and it does not throw on the raw file, which is how this was found.
  assert.doesNotThrow(() => buildPlaceIndex(places.features));
});

// ---------------------------------------------------------------------------
// The directory's names. The index is built from places.json and the cards,
// the cold start and the map labels all speak directory.json, and twenty of
// its thirty-three buildings are spelt differently in the two.

const directory = load('directory');
const joined = buildPlaceIndex(places.features, directory);

/** The two directory buildings with no row of their own in the places file. */
const NO_PLACE_ROW = ['Ranch House', 'Kinesiology & Athletics (Physical Education)'];

test('every directory building is reached by some place in the index', () => {
  // What decides whether picking a search result opens the building card or
  // the thin pin card. Twenty of these used to fall through to the pin.
  const reached = new Set(index
    .map((entry) => directoryFeature(directory, entry.name)?.properties.name)
    .filter(Boolean));
  const missed = directory.features
    .map((f) => f.properties.name)
    .filter((name) => !reached.has(name) && !NO_PLACE_ROW.includes(name));
  assert.deepEqual(missed, []);
  // The ones named in the finding, spelt the way the places file spells them.
  for (const [place, row] of [
    ['Gym - MAIN and PRACT', 'Gym'],
    ['Bookstore - College Store', 'Bookstore'],
    ['Police - College', 'College Police'],
    ['Administration Building', 'Admin Bldg.'],
    ['Technical Education West - TEW', 'Technical Education West (TEW)'],
    ['CTE - Career Technical Education', 'Career Technical Education (CTE)'],
    ['Learning Resource Center - LRC', 'Learning Resource Center (LRC)'],
  ]) {
    assert.equal(directoryFeature(directory, place)?.properties.name, row, `${place} opened no card`);
  }
  // ...and a car park that shares a building's first words is not that building.
  assert.equal(directoryFeature(directory, 'Ranch House Parking Lot (Staff Only)'), null);
});

test('every places-file alias joins a real place to a real directory row', () => {
  // A hand-made map rots when either file it points into is edited.
  const rows = new Set(directory.features.map((f) => f.properties.name));
  const officials = new Set(directory.features.map((f) => f.properties.officialName));
  const placeNames = new Set(index.map((e) => e.name));
  for (const [from, to] of NAME_ALIASES) {
    assert.ok(placeNames.has(from), `no place is called "${from}"`);
    assert.ok(rows.has(to), `"${from}" is aliased to "${to}", which is not a directory row`);
    assert.ok(!rows.has(from) && !officials.has(from), `"${from}" needs no alias`);
  }
});

test('typing the title a building card prints finds that building first', () => {
  // The card says "Admin Bldg."; the map says "Science & Engineering". Both
  // used to find nothing at all.
  for (const f of directory.features) {
    const { name } = f.properties;
    if (NO_PLACE_ROW.includes(name)) continue;
    const [first] = rankPlaces(joined, name);
    assert.ok(first, `"${name}" found nothing`);
    assert.equal(directoryFeature(directory, first.name)?.properties.name, name,
      `"${name}" found ${first.name} first`);
  }
});

test('a name typed in full beats its siblings however popular they are', () => {
  // "Student Center" and "Student Support Center" both score 80 + 60 term by
  // term; one visit to the second used to put it first.
  const everyoneElse = (target) => (name) => (name === target ? 0 : MAX_BONUS);
  for (const entry of joined) {
    const [first] = rankPlaces(joined, entry.name, everyoneElse(entry.name));
    assert.equal(first.name, entry.name, `"${entry.name}" lost to ${first.name}`);
  }
  assert.deepEqual(names(rankPlaces(index, 'Student Center',
    (n) => (n === 'Student Support Center' ? MAX_BONUS : 0))).slice(0, 2),
  ['Student Center', 'Student Support Center']);
});

/** A localStorage that behaves like the real one. */
function stubStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

test('a fresh browser gets a full shelf, the most prominent building included', () => {
  stubStorage();
  forgetVisits();
  const shelf = popularEntries({ index: joined, directory, limit: 6 });
  assert.equal(shelf.length, 6, `the cold start offered ${shelf.length} rows of 6`);
  assert.ok(names(shelf).includes('Learning Resource Center - LRC'),
    'the LRC, joint most prominent, is missing');
  assert.ok(names(shelf).includes('Administration Building'));
  assert.equal(new Set(shelf).size, shelf.length);
});

test('remembered names the index does not hold do not cost the shelf its rows', () => {
  // Rooms and courses are not remembered any more, but a browser that
  // remembered some before, or a place since renamed, must not shrink the list.
  stubStorage();
  forgetVisits();
  recordVisit('Room 320');
  recordVisit('ACCT 101 — Fundamentals of College Accounting');
  recordVisit('Room 401');
  recordVisit('Library');
  const shelf = popularEntries({ index: joined, directory, limit: 6 });
  assert.equal(shelf.length, 6);
  assert.equal(shelf[0].name, 'Library', 'the visit no longer leads');
  forgetVisits();
});
