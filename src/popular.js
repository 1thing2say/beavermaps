// Which of two equally good matches should be offered first.
//
// The search index scores a query LEXICALLY — where the words landed, and how
// early. That is the right first question and it runs out of answers almost
// immediately on a phone, because the first keystroke is one letter and one
// letter matches thirty things at exactly the same score. Ranked on spelling
// alone the tie-break was name LENGTH, so typing "l" offered LRC, then Lab,
// then Lawn, and the Library — the single most looked-for room on this campus —
// was fourth. That is not a scoring bug; it is a question spelling cannot
// answer. This file answers it.
//
// TWO SIGNALS, AND THEY ARE NOT THE SAME KIND OF THING.
//
//   WHAT YOU HAVE CHOSEN BEFORE is the real one, and it is the only thing here
//   that literally means "most searched". Every destination this app opens is
//   recorded, decayed, and weighted. It is per-browser and it is yours: a
//   student walks the same three routes all semester and the third week should
//   know that.
//
//   HOW MANY REASONS THERE ARE TO GO SOMEWHERE is the cold start, and it has
//   to exist, because a first-time visitor has no history and is exactly the
//   person a wayfinder is for. It is read off my campus's own directory rather than
//   invented: the number of destinations my campus lists INSIDE a building. The
//   Student Center holds a bookstore, a cafeteria, the business office and a
//   dozen offices; Operations holds nothing anybody visits. That is a count
//   this repo already ships, not a ranking somebody's taste supplied.
//
// WHAT IT IS DELIBERATELY NOT: a re-ranking. Popularity is added as a bounded
// bonus — see MAX_BONUS — small enough that it can never lift a place that
// merely CONTAINS your word above one whose name begins with it. Search that
// quietly reorders itself past what you typed stops being search. It settles
// ties, and ties are all it is asked to settle.

import { readJson, writeJson, removeKey } from './storage.js';

const STORAGE_KEY = 'mapper-popular';

/**
 * How long it takes a visit to count half as much.
 *
 * Three weeks, which is a semester's habit rather than a lifetime's. The point
 * of decaying at all is that a campus is walked in phases: the place you looked
 * up every day during registration is not the place you want in October, and a
 * plain visit COUNT would keep offering it until it was manually cleared.
 *
 * Long enough that a weekly class still holds its place — a room visited every
 * seven days settles at about four times the weight of one visited once — and
 * short enough that a semester's worth of habit has faded before the next.
 */
const HALF_LIFE_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * How many places are remembered.
 *
 * A cap rather than a horizon: entries decay to nothing on their own, and this
 * only stops a browser that has been used for years from carrying a list of
 * every place on campus at a weight of 0.0001. Trimmed by weight, so what falls
 * off is always the least used thing and never the oldest.
 */
const KEEP = 40;

/**
 * The most a place can be lifted by being popular, in the units `scoreTerm`
 * uses.
 *
 * The gaps that matter over there are 100 (the name IS the query), 80 (the name
 * starts with it), 60 (some word in the name starts with it), 35 (the name
 * contains it) and 12 (only the description does). 20 is smaller than every one
 * of those gaps, so popularity can never promote a weaker KIND of match — a
 * description hit stays below a name hit however often you have been there.
 * What it can do is reorder the things that landed in the same band, which is
 * the whole of the job.
 */
const MAX_BONUS = 20;

/** Where the bonus curve is half-spent, in decayed visits. */
const BONUS_MIDPOINT = 3;

/** Everything that has to be true for a stored row to be worth reading. */
function isRow(row) {
  return row
    && typeof row === 'object'
    && typeof row.name === 'string'
    && Number.isFinite(row.weight)
    && Number.isFinite(row.at);
}

/**
 * What is on disk, sanitised.
 *
 * Never throws and never returns anything but an array. This key is
 * hand-editable, survives across versions of the app, and is worth exactly
 * nothing — a corrupt one should cost a visitor their suggestion order, not
 * their map.
 */
function load() {
  const saved = readJson(STORAGE_KEY);
  return Array.isArray(saved) ? saved.filter(isRow) : [];
}

function save(rows) {
  writeJson(STORAGE_KEY, rows);
}

/** A stored weight, brought forward to now. */
function decayed(row, now) {
  return row.weight * 0.5 ** ((now - row.at) / HALF_LIFE_MS);
}

/**
 * Record that somebody went somewhere.
 *
 * The decay is applied ON WRITE as well as on read, which is what keeps this to
 * one number per place instead of a list of timestamps: bringing the old weight
 * forward to now and adding one is exactly the sum of every past visit decayed
 * to this instant. A running total that never needs the history it summarises.
 *
 * @param {string} name  the place's own name, as the index holds it
 * @param {number} [now] injectable for tests
 */
export function recordVisit(name, now = Date.now()) {
  if (!name) return;
  const rows = load();
  const existing = rows.find((row) => row.name === name);
  if (existing) {
    existing.weight = decayed(existing, now) + 1;
    existing.at = now;
  } else {
    rows.push({ name, weight: 1, at: now });
  }
  rows.sort((a, b) => decayed(b, now) - decayed(a, now));
  save(rows.slice(0, KEEP));
}

/** Every remembered place with its weight as of now, heaviest first. */
export function visitWeights(now = Date.now()) {
  const out = new Map();
  for (const row of load()) out.set(row.name, decayed(row, now));
  return out;
}

/** For the debug menu, and for anybody who wants their history back. */
export function forgetVisits() {
  removeKey(STORAGE_KEY);
}

/**
 * The cold start: how many reasons my campus's own directory gives for going to each
 * building, as a weight in the same units a visit is worth.
 *
 * `contents` is the list of departments, offices and services my campus publishes for
 * a building — the same list the place card prints under "N destinations
 * inside". A building with twelve of them is somewhere twelve different errands
 * end; a building with none is a shed with a name.
 *
 * CAPPED AT ONE VISIT'S WORTH, deliberately. This is a guess about strangers
 * and the history above is a fact about the person holding the phone, so the
 * moment somebody has been anywhere twice their own habits outweigh the whole
 * of it. `Math.log1p` rather than the count itself for the same reason the
 * bonus curve below is a curve: the difference between nought and four
 * destinations inside is real, and the difference between twenty and
 * twenty-four is not.
 *
 * @param {object} [directory] the parsed src/directory.json, when it has landed
 */
export function prominenceWeights(directory) {
  const out = new Map();
  for (const feature of directory?.features ?? []) {
    const { name, contents } = feature.properties ?? {};
    if (!name) continue;
    const inside = Array.isArray(contents) ? contents.length : 0;
    if (!inside) continue;
    out.set(name, Math.min(1, Math.log1p(inside) / Math.log1p(12)));
  }
  return out;
}

/**
 * Turn a weight into something `runSearch` can add to a score.
 *
 * A saturating curve rather than anything proportional: the first visit to a
 * place is most of what there is to learn about it, the fifth adds almost
 * nothing, and an unbounded term would eventually let one much-visited building
 * outrank a name you actually typed. `w / (w + k)` is the cheapest shape with
 * that property — nought at nought, half of MAX_BONUS at BONUS_MIDPOINT
 * visits, and never past MAX_BONUS however long the browser has been in use.
 */
export function bonusFor(weight) {
  if (!(weight > 0)) return 0;
  return MAX_BONUS * (weight / (weight + BONUS_MIDPOINT));
}

/**
 * One lookup that folds both signals together, ready to hand to a scorer.
 *
 * Returns a function rather than a map so the caller can ask about a name it
 * has never heard of without checking first, and so the two sources can be
 * summed in one place instead of at every call site.
 *
 * @param {object} [directory] src/directory.json, if it has arrived
 * @param {number} [now]       injectable for tests
 * @returns {(name: string) => number} a bounded score bonus, 0 for anything unknown
 */
export function popularity({ directory, now = Date.now() } = {}) {
  const visits = visitWeights(now);
  const prominence = prominenceWeights(directory);
  return (name) => bonusFor((visits.get(name) ?? 0) + (prominence.get(name) ?? 0));
}

/**
 * The places worth offering before anybody has typed anything.
 *
 * What a phone shows the moment the field is focused, and what a first
 * keystroke is ranked against. Visited places first and in weight order, then
 * the prominent ones to fill out the list — in that order rather than merged by
 * score, because "where you have been" and "where there is a lot to do" are
 * different promises and a list that interleaved them would keep them apart by
 * accident at best.
 *
 * @param {number} limit how many rows there is room for
 */
export function popularNames({ directory, now = Date.now(), limit = 6 } = {}) {
  const visits = [...visitWeights(now).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const prominent = [...prominenceWeights(directory).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const out = [];
  for (const name of [...visits, ...prominent]) {
    if (out.length >= limit) break;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
