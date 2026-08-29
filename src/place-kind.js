// WHAT SORT OF PLACE A ROW IS, for the lists in the sheet.
//
// The map has told you what kind of place something is for a while: every
// building name on it carries a small coloured disc, classified by src/poi.js
// and drawn by src/map-images.js, and Google's map is scannable for exactly
// that reason. The sheet did not. Searching "library" gave a list of names in
// one ink, which is the same wall of undifferentiated type my campus's printed sheet
// is — the thing the discs were added to fix — reproduced inside the app.
//
// So a row gets the mark its place already has on the map. This file is only
// the join: given the name a row is printed with, which of map-images.js's
// kinds does it belong to. The colour and the pictogram come from there, the
// building classification comes from poi.js, and nothing is redefined here —
// a second table of hues would be a second table to drift.
//
// FIVE SOURCES, IN THIS ORDER, first answer wins:
//
//   1. the directory, by any name a building answers to. A row that IS a
//      building takes that building's class, whichever of its three names was
//      typed on it.
//   2. amenities.json, by printed label. "Defibrillator" is a red bolt on the
//      map and there is no reason for it to be a blue building in a list.
//   3. ROWS below — the handful of things that are neither, because my campus's
//      directory lists car parks, bus stops and playing fields as places.
//   4. poi.js's own rules, on the row's own name. Its name beats its container:
//      the cafeteria is inside the Student Center and is still food.
//   5. what building holds it. A room, an office or a division takes the class
//      of the building you would walk into to reach it.
//
// Anything left is `campus`, which is the same default poi.js lands on and is a
// true statement about a college campus: it is a building here.

import { poiFor, poiRule } from './poi.js';

/** Loose enough to join "All Gender Restroom" to "All-gender restroom". */
const key = (s) => (s ?? '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * ...and loose enough about number, which the two files disagree about.
 *
 * my campus's directory counts what it lists — the Parking Garage holds "Emergency
 * telephones", five of them — while the legend names one symbol, "Emergency
 * telephone". Without this the plural misses the pictogram, falls through to
 * the building holding it, and a telephone comes out as a car park.
 */
const singular = (k) => k.replace(/s$/, '');

/** Where a row lands when nothing else claims it. */
export const FALLBACK_KIND = 'campus';

/**
 * The rows that are places without being buildings, and without being one of
 * the pictograms on my campus's printed key.
 *
 * Deliberately not in poi.js. That file classifies the names PRINTED ON THE
 * MAP, where a car park is already a `parking` label and a playing field is an
 * `area` that Apple and Google both leave unmarked — running these patterns
 * there would put a disc on ground that is meant to carry none. They are only
 * needed here, where the same things arrive as rows in a directory.
 *
 * Ordered, first match wins, and `homebase` is first for the reason `food` is
 * first in poi.js: "Arts HomeBase" contains the word Arts and is not a gallery.
 */
const ROWS = [
  { kind: 'homebase', test: /homebase/i },
  { kind: 'parking', test: /parking (lot|garage)|metered parking/i },
  { kind: 'bus_stop', test: /^bus \d|para transit/i },
  { kind: 'drop_off', test: /drop[- ]?off/i },
  { kind: 'health_centre', test: /health (&|and) wellness|wellness cent/i },
  // The athletics ground. Not `\bfield\b` on its own — "Field Studies" is a
  // course, and my campus's directory is full of them.
  { kind: 'sport', test: /stadium|tennis court|soccer|baseball|softball|athletic field/i },
];

/**
 * Build the lookup once, over whatever data has landed.
 *
 * A closure rather than a function taking the collections each time, because
 * the list it feeds redraws on every keystroke and rebuilding two maps of 200
 * entries per row is work nobody asked for. Called again when a file lands —
 * see main.js — so a search made before amenities.json arrives still answers,
 * just with fewer of the five sources available.
 */
export function placeIndex({ directory, amenities } = {}) {
  /** Every name a building answers to -> the class of that building. */
  const buildings = new Map();
  /** Everything a building holds -> the class of the building holding it. */
  const inside = new Map();

  for (const feature of directory?.features ?? []) {
    const props = feature.properties ?? {};
    const kind = poiFor(props.name) ?? FALLBACK_KIND;
    for (const alias of [props.name, props.officialName, ...(props.parts ?? [])]) {
      if (alias) buildings.set(key(alias), kind);
    }
    // `contents` is what my campus files under the building; `facilities` is the
    // legend's own symbols counted inside it. Both are things a row can name.
    // First writer wins: a room listed under two buildings is one of them, and
    // which one is not a question this file can answer.
    for (const held of [...(props.contents ?? []), ...(props.facilities ?? [])]) {
      if (held?.name && !inside.has(key(held.name))) inside.set(key(held.name), kind);
    }
  }

  /** A printed label on my campus's key -> the pictogram kind it is drawn with. */
  const pictograms = new Map();
  for (const feature of amenities?.features ?? []) {
    const { label, kind } = feature.properties ?? {};
    if (!label || !kind) continue;
    // Both numbers, so the join works whichever file happens to be the plural
    // one. The exact spelling wins where a set-and-its-singular would collide.
    if (!pictograms.has(singular(key(label)))) pictograms.set(singular(key(label)), kind);
    pictograms.set(key(label), kind);
  }

  return function kindOf(name) {
    const k = key(name);
    if (!k) return FALLBACK_KIND;
    return buildings.get(k)
      ?? pictograms.get(k)
      ?? pictograms.get(singular(k))
      ?? ROWS.find((row) => row.test.test(name))?.kind
      ?? poiRule(name)
      ?? inside.get(k)
      ?? FALLBACK_KIND;
  };
}
