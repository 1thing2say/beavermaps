// What the search field ranks, and why it ranks it that way.
//
// All of this was inside startApp(), reading `campusPlaces`, `searchIndex` and
// `popularBonus` out of the enclosing scope and writing `searchInput.disabled`
// on the way past. None of it could be asked a question without a browser, and
// the questions worth asking are all of the form "does typing X find Y" — which
// is the entire behaviour of the feature and the only part of it anybody
// notices.
//
// The DOM half stays in main.js. This is the half with the opinions in it.

import { popularNames } from './popular.js';

/** How many rows the list shows at once. */
export const MAX_RESULTS = 8;

/**
 * Down to lowercase ASCII words.
 *
 * NFKD first, so an accented name matches what somebody types on a keyboard
 * that has no way to produce the accent.
 */
export const normalise = (s) => (s ?? '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * One entry per NAME, holding every position that name appears at.
 *
 * my campus lists a class like "Defibrillator" once per node, which build-places
 * splits into one feature each. Six identical rows in a result list is noise,
 * so they collapse to one entry holding every position.
 */
export function buildPlaceIndex(features) {
  const groups = new Map();
  for (const feature of features) {
    // A ROW WITH NO POSITION IS NOT A DESTINATION. places.json carries fourteen
    // of them — rows my campus lists without a room — and main.js already drops
    // them before this, for its own reason: a null geometry is not something a
    // vector source can tile. The guard is here as well because the two
    // filters are answering different questions, and this one's answer is that
    // a search hit you cannot walk to is worse than no hit at all. Picking one
    // would reach `entry.points[0]` and find nothing there.
    if (!feature.geometry) continue;
    const { name, description } = feature.properties;
    const group = groups.get(name) ?? { name, description, points: [] };
    group.points.push(feature.geometry.coordinates);
    groups.set(name, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    nameKey: normalise(group.name),
    haystack: normalise(`${group.name} ${group.description ?? ''}`),
  }));
}

/**
 * 0 when a term is absent. Higher is a better place for it to have matched.
 *
 * The five bands are far enough apart that no accumulation of weak matches
 * climbs into a strong one — which is what lets the popularity bonus be added
 * afterwards without being able to cross a band. See MAX_BONUS in popular.js.
 */
export function scoreTerm(entry, term) {
  if (entry.nameKey === term) return 100;
  if (entry.nameKey.startsWith(`${term} `)) return 80;
  if (entry.nameKey.split(' ').some((w) => w.startsWith(term))) return 60;
  if (entry.nameKey.includes(term)) return 35;
  if (entry.haystack.includes(term)) return 12;
  return 0;
}

/**
 * Score every entry against every term, best first.
 *
 * @param {Function} bonus  name -> a small nudge for where people actually go
 */
export function rankPlaces(index, query, bonus = () => 0) {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (!terms.length) return [];

  const scored = [];
  for (const entry of index) {
    let total = 0;
    // Every term has to land somewhere, so "student center" cannot match a
    // row that only has "student".
    for (const term of terms) {
      const score = scoreTerm(entry, term);
      if (!score) { total = 0; break; }
      total += score;
    }
    // Then two tie-breaks, in the order they deserve. WHERE PEOPLE ACTUALLY
    // GO first: one keystroke matches thirty rows at an identical lexical
    // score, and spelling has nothing left to say about which of them you
    // meant. Bounded well under the gap between two kinds of match, so it can
    // only reorder within a band — see MAX_BONUS in src/popular.js.
    //
    // Shorter names settle what is left, so "Library" beats "Lockers for
    // Library" among two places nobody has been to.
    if (total) {
      scored.push({
        entry,
        score: total + bonus(entry.name) - entry.nameKey.length / 1000,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}

/**
 * Rooms and courses first, then places.
 *
 * Ahead rather than interleaved, and not because they score higher — they are
 * not scored at all. Typing "320" or "ACCT 101" is a different kind of act
 * from typing "library": it is a lookup with a right answer, and the place
 * index cannot produce that answer at any score because it has never heard of
 * a room. Ranking them together would let a fuzzy name match on some place
 * whose description happens to contain "320" outrank the room itself.
 *
 * They still share the budget, so a query that is both — "STEM 213" is a
 * building with that room AND a course code — cannot bury the ordinary
 * results entirely.
 */
export function search({ index, query, rooms = [], bonus, limit = MAX_RESULTS }) {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (!terms.length) return rooms;
  return [...rooms, ...rankPlaces(index, query, bonus)].slice(0, limit);
}

/**
 * The list an empty field shows: where you have been, then where there is
 * most to do. See `popularNames`.
 *
 * An empty field is exactly the state somebody is in when they have not
 * decided what to type yet, and on a phone it is now the state the app BOOTS
 * in — the field holds the bottom of the screen under a thumb. Answering it
 * with nothing is a keyboard and a blank rectangle.
 *
 * Filtered against the index rather than trusted: these names come from
 * my campus's building directory and the index is built from its places file, and
 * a building the two spell differently is a row that would go nowhere.
 */
export function popularEntries({ index, directory, limit = MAX_RESULTS - 2 }) {
  const byName = new Map(index.map((entry) => [entry.name, entry]));
  return popularNames({ directory, limit })
    .map((name) => byName.get(name))
    .filter(Boolean);
}
