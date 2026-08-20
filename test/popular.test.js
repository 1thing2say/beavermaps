// What the suggestion order is allowed to do, and what it must never do.
//
// The whole risk in ranking search results by anything other than spelling is
// that it stops answering what was typed. Most of what is here is that one
// worry, asked several ways: a bounded bonus, a saturating curve, and a decay
// that lets a habit lapse. The arithmetic is easy; the properties are the point.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bonusFor, popularity, popularNames, prominenceWeights, recordVisit, visitWeights, forgetVisits,
} from '../src/popular.js';

const DAY = 24 * 60 * 60 * 1000;

/** A localStorage that behaves like the real one, including throwing on quota. */
function stubStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

/** A directory shaped the way src/directory.json is, with only what is read. */
const directory = (rows) => ({
  features: rows.map(([name, inside]) => ({
    properties: { name, contents: Array.from({ length: inside }, (_, i) => ({ name: `r${i}` })) },
  })),
});

test('the bonus can never promote a weaker kind of match', () => {
  // The gaps `scoreTerm` works in: 100 exact, 80 name-starts-with, 60
  // word-starts-with, 35 name-contains, 12 description-only. The smallest of
  // those gaps is 12 (35 -> 12 is 23, 100 -> 80 is 20), so a bonus that stays
  // under 20 cannot lift a description hit past a name hit however popular it
  // is. Asked at an absurd weight rather than a plausible one, because the
  // guarantee has to be a ceiling and not a range.
  assert.ok(bonusFor(1e9) <= 20, 'the bonus is bounded');
  assert.ok(bonusFor(1e9) < 100 - 80, 'and bounded below the narrowest gap between two bands');
});

test('the bonus saturates, so no amount of history outranks a fresh name match', () => {
  const one = bonusFor(1);
  const five = bonusFor(5);
  const fifty = bonusFor(50);
  assert.ok(one > 0);
  assert.ok(five > one, 'more visits are worth more');
  assert.ok(fifty - five < five - one, 'but each is worth less than the last');
});

test('nothing known about a place is worth nothing, not a little', () => {
  assert.equal(bonusFor(0), 0);
  assert.equal(bonusFor(-1), 0);
  assert.equal(bonusFor(undefined), 0);
  assert.equal(bonusFor(NaN), 0);
});

test('a visit is remembered, and a second one counts for more', () => {
  stubStorage();
  const now = Date.UTC(2026, 0, 1);
  recordVisit('Library', now);
  const once = visitWeights(now).get('Library');
  recordVisit('Library', now);
  const twice = visitWeights(now).get('Library');
  assert.ok(twice > once);
});

test('a habit fades on its own', () => {
  stubStorage();
  const now = Date.UTC(2026, 0, 1);
  recordVisit('Library', now);
  const fresh = visitWeights(now).get('Library');
  const later = visitWeights(now + 21 * DAY).get('Library');
  // 21 days is the stated half-life, so this is the constant itself under test
  // rather than merely the direction.
  assert.ok(Math.abs(later - fresh / 2) < 1e-9, `expected half of ${fresh}, got ${later}`);
});

test('a place visited weekly outlives one visited once', () => {
  stubStorage();
  const start = Date.UTC(2026, 0, 1);
  for (let week = 0; week < 8; week += 1) recordVisit('Library', start + week * 7 * DAY);
  recordVisit('Operations', start);
  const at = start + 8 * 7 * DAY;
  const weights = visitWeights(at);
  assert.ok(weights.get('Library') > weights.get('Operations') * 4);
});

test('a corrupt store costs the ordering, not the map', () => {
  const store = stubStorage();
  store.set('mapper-popular', '{{not json');
  assert.deepEqual([...visitWeights(Date.now())], []);
  store.set('mapper-popular', JSON.stringify([{ name: 'Library' }, 42, null, { weight: 1, at: 1 }]));
  assert.deepEqual([...visitWeights(Date.now())], [], 'rows missing a field are dropped');
});

test('a browser with no storage at all still ranks', () => {
  delete globalThis.localStorage;
  assert.deepEqual([...visitWeights(Date.now())], []);
  assert.doesNotThrow(() => recordVisit('Library'));
  assert.doesNotThrow(() => forgetVisits());
});

test('the cold start ranks by how many reasons there are to go somewhere', () => {
  const weights = prominenceWeights(directory([
    ['Student Center', 12], ['Library', 4], ['Operations', 0],
  ]));
  assert.ok(weights.get('Student Center') > weights.get('Library'));
  assert.ok(!weights.has('Operations'), 'a building with nothing inside is not ranked, only unranked');
});

test('the cold start is worth less than being somewhere twice', () => {
  stubStorage();
  const now = Date.UTC(2026, 0, 1);
  recordVisit('Operations', now);
  recordVisit('Operations', now);
  const dir = directory([['Student Center', 40]]);
  const score = popularity({ directory: dir, now });
  assert.ok(score('Operations') > score('Student Center'),
    'what this person actually does outranks a guess about strangers');
});

test('an absent directory is not an error', () => {
  assert.deepEqual([...prominenceWeights(undefined)], []);
  assert.deepEqual([...prominenceWeights({})], []);
  assert.equal(popularity({})('Library'), 0);
});

test('the empty-field list puts where you have been before where there is most to do', () => {
  stubStorage();
  const now = Date.UTC(2026, 0, 1);
  recordVisit('Operations', now);
  const names = popularNames({
    directory: directory([['Student Center', 12], ['Library', 4]]),
    now,
    limit: 3,
  });
  assert.equal(names[0], 'Operations');
  assert.deepEqual(names, ['Operations', 'Student Center', 'Library']);
});

test('the empty-field list never repeats a place or overruns its room', () => {
  stubStorage();
  const now = Date.UTC(2026, 0, 1);
  recordVisit('Library', now);
  const names = popularNames({
    directory: directory([['Library', 9], ['Student Center', 12], ['Gym', 3]]),
    now,
    limit: 2,
  });
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2, 'a visited place that is also prominent appears once');
  assert.equal(names[0], 'Library');
});
