// Which building in the directory a name means.
//
// Three files name the same buildings and no two of them agree. The sheet
// prints "Health & Ed (HeEd) 710-716"; the directory (src/directory.json) calls
// that building "Health Education Complex"; the places file the search index is
// built from calls it "Health Education Complex - HeEd 710-716". The sheet's
// spellings are decided in src/cards.js (LABEL_ALIASES); this is the places
// file's, which is what every search result is called. Twenty of the
// directory's thirty-three buildings are spelt differently in the places file,
// and every one of those was a search result that opened the thin pin card —
// no details, no "N destinations inside", no outline, no aerial view — for a
// building the app has a full card for.
//
// Pure and data-free, so the card, the search index and the suggestion shelf
// can all ask the same question and get the same answer, and a test can ask it
// without a browser.

/**
 * Places-file names spelt differently from the directory's row, each one a
 * decision.
 *
 * Not a general fuzzy match, and deliberately not: "Science" and "Science
 * Success Center" are two buildings, and anything loose enough to join
 * "Health & Ed" to "Health Education Complex" is loose enough to join those.
 * Each entry is a decision about one name, made by reading both files. The
 * directory's `officialName` covers most of the places file on its own (see
 * `directoryFeature`); these are the ones it does not.
 *
 * Left out on purpose: "Ranch House Parking Lot (Staff Only)" is a car park,
 * not the Ranch House, and "Kinesiology and Athletics Division" is the
 * division's office rather than the building it sits in — the same as every
 * other division row, none of which opens a building card.
 */
export const NAME_ALIASES = new Map([
  ['Gym - MAIN and PRACT', 'Gym'],
  ['Learning Resource Center - LRC', 'Learning Resource Center (LRC)'],
  ['Child Development Center - CDC', 'Child Development Center (CDC)'],
  ['Technical Education West - TEW', 'Technical Education West (TEW)'],
  ['Arts and Science - AS', 'Arts & Sci'],
  ['Health Education Complex - HeEd 710-716', 'Health Education Complex'],
  ['Bookstore - College Store', 'Bookstore'],
  ['Police - College', 'College Police'],
  ['Science Success Center (Rm 491)', 'Science Success Center'],
  ['Printing Services Sign Shop', 'Printing Services'],
]);

/**
 * The directory feature `name` means, or null.
 *
 * Its own name first, then an alias, then the directory's `officialName` —
 * which is what the places file uses for eight buildings the map shortens:
 * "Administration Building" for "Admin Bldg.", "Science" for "Science &
 * Engineering", "Receiving" for "Rec.".
 *
 * @param {object} [directory] the parsed src/directory.json, when it has landed
 */
export function directoryFeature(directory, name) {
  const features = directory?.features;
  if (!features || !name) return null;
  const said = name.trim();
  const want = NAME_ALIASES.get(said) ?? said;
  return features.find((f) => f.properties?.name === want)
    ?? features.find((f) => f.properties?.officialName === want)
    ?? null;
}

/**
 * Every other name a place goes by in the directory: its row's name and
 * official name, minus the one it already has.
 *
 * What the search index adds to a place so that typing the title its card
 * prints — "Admin Bldg.", "Science & Engineering" — finds it.
 */
export function directoryNames(directory, name) {
  const row = directoryFeature(directory, name)?.properties;
  if (!row) return [];
  return [...new Set([row.name, row.officialName])].filter((n) => n && n !== name);
}
