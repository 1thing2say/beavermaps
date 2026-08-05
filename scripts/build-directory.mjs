/**
 * What is inside each building, so the map can answer a tap.
 *
 * The pieces already exist and have never been joined: src/buildings.json has
 * the footprints, src/labels.json has what the printed sheet calls them, and
 * src/places.json has my campus's 145 positioned destinations. 75 of those fall
 * inside a footprint — the Administration Building holds ten, the Student
 * Center and the Welcome and Support Center eight each — and until now there
 * was no way to ask a building what it contains.
 *
 * One feature per *building*, not per footprint. my campus draws the Health Education
 * Complex as nine separate shapes and the Portable Village as seven, so
 * groupByName folds them together; otherwise tapping one shard of a building
 * would show a ninth of its directory. The same grouping and the same tidied
 * names are used by build-labels.mjs, which is why both live in
 * building-names.mjs — the popup and the label have to agree.
 *
 * The display name prefers what the sheet prints. "Administration Building" is
 * my campus's database name and "Admin Bldg." is what a person reading the map sees,
 * so the popup says the second and keeps the first for search.
 *
 * Reads only committed artifacts, so unlike its siblings this one runs from a
 * bare clone.
 *
 *   node scripts/build-directory.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupByName, metresBetween, pointInRing, loadFootprints } from './building-names.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (name) => path.join(root, 'src', name);
const TARGET = src('directory.json');

const footprints = loadFootprints(src('buildings.json'));
const labels = JSON.parse(readFileSync(src('labels.json'), 'utf8')).features;
const places = JSON.parse(readFileSync(src('places.json'), 'utf8')).features;
const network = JSON.parse(readFileSync(src('paths.json'), 'utf8')).features;

/** Same reach build-labels.mjs uses: a plate is set beside its building. */
const PLATE_REACH_M = 40;

const vertices = [];
const seen = new Set();
for (const segment of network) {
  for (const coord of segment.geometry.coordinates) {
    const key = `${coord[0]},${coord[1]}`;
    if (!seen.has(key)) { seen.add(key); vertices.push(coord); }
  }
}

const inAnyMember = (coords, members) =>
  members.some((m) => pointInRing(coords, m.geometry.coordinates[0]));

const wordsOf = (text) => (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 3);

/** How much a printed label agrees with my campus's own name for the building. */
function agreement(text, officialName) {
  const arc = wordsOf(officialName);
  return wordsOf(text).filter((w) => arc.some((a) => a.startsWith(w) || w.startsWith(a))).length;
}

/**
 * The name a person reading the map would use, and the named parts inside it.
 *
 * Point size cannot choose between competing labels — the sheet sets Practice
 * Gym at 8.4 pt and Main Gym at 8.1, Counseling at 8.4 and Admin Bldg. at 8.1 —
 * because those are all the same tier of type. What does choose is agreement
 * with my campus's own name for the building: "Admin Bldg." matches "Administration
 * Building" and "Counseling" does not, so the department stops being mistaken
 * for the building it sits in.
 *
 * Three rules, in order:
 *   1. A plate covering the building wins. Plates are how this sheet gives a
 *      building its name — Fine & Applied Arts, Science & Engineering, Health &
 *      Ed — while the labels inside name wings and departments.
 *   2. Otherwise the printed label that uniquely best agrees with my campus's name.
 *   3. Otherwise my campus's own tidied name, because a tie means the printed labels
 *      are naming parts rather than the whole: the Gym holds Main Gym and
 *      Practice Gym and is neither of them.
 */
function describe(group) {
  const inside = labels
    .filter((l) => ['building', 'plate'].includes(l.properties.kind))
    .filter((l) => inAnyMember(l.geometry.coordinates, group.members));
  const plates = group.pole ? labels.filter((l) => l.properties.kind === 'plate'
    && !inside.includes(l)
    && metresBetween(l.geometry.coordinates, group.pole.coordinates) < PLATE_REACH_M) : [];

  const plate = [...inside, ...plates].find((l) => l.properties.kind === 'plate');
  const parts = inside.map((l) => l.properties.text);

  if (plate) return { name: plate.properties.text, parts: parts.filter((t) => t !== plate.properties.text) };

  const scored = inside.map((l) => ({ text: l.properties.text, score: agreement(l.properties.text, group.name) }));
  const top = Math.max(0, ...scored.map((c) => c.score));
  const winners = scored.filter((c) => c.score === top && top > 0);
  if (winners.length === 1) {
    return { name: winners[0].text, parts: parts.filter((t) => t !== winners[0].text) };
  }
  return { name: null, parts };
}

/** The routing node closest to the building's walls, which is where a door is. */
function entranceFor(group) {
  let best = null;
  for (const member of group.members) {
    for (const ring of member.geometry.coordinates) {
      for (const corner of ring) {
        for (const vertex of vertices) {
          const d = metresBetween(corner, vertex);
          if (!best || d < best.d) best = { d, vertex };
        }
      }
    }
  }
  return best?.vertex ?? null;
}

const groups = [...groupByName(footprints).values()];
const features = [];

for (const group of groups) {
  const within = places
    .filter((p) => p.geometry && p.geometry.type === 'Point')
    .filter((p) => inAnyMember(p.geometry.coordinates, group.members));

  const contents = within
    .filter((p) => p.properties.kind === 'place')
    .map((p) => ({
      name: p.properties.name,
      ...(p.properties.description ? { description: p.properties.description } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Amenities are kept apart from the directory. They are already drawn as
  // icons, and listing them alongside departments reads badly: the Gym's three
  // "destinations" were a defibrillator and the same vending machine twice.
  // Counted rather than repeated, for the same reason.
  const counts = new Map();
  for (const p of within.filter((x) => x.properties.kind === 'amenity_class')) {
    counts.set(p.properties.name, (counts.get(p.properties.name) ?? 0) + 1);
  }
  const facilities = [...counts]
    .map(([name, n]) => ({ name, ...(n > 1 ? { n } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const { name: printed, parts } = describe(group);
  const area = group.members.reduce((sum, m) => sum + m.properties.area_m2, 0);

  features.push({
    type: 'Feature',
    properties: {
      name: printed ?? group.name,
      // Kept even when the printed name wins: it is what search matches on, and
      // it is the only place the fuller wording survives.
      officialName: group.name,
      // Named wings and departments the sheet prints inside this building.
      ...(parts.length ? { parts } : {}),
      footprints: group.members.length,
      area_m2: Math.round(area),
      height: group.host.properties.height,
      contents,
      ...(facilities.length ? { facilities } : {}),
      entrance: entranceFor(group),
      // Where the card points. The pole of inaccessibility rather than the tap,
      // so the card belongs to the building instead of to wherever a finger
      // landed — and so it lands in the same place every time.
      anchor: group.pole ? group.pole.coordinates.map((n) => +n.toFixed(7)) : null,
    },
    geometry: {
      type: 'MultiPolygon',
      coordinates: group.members.map((m) => m.geometry.coordinates),
    },
  });
}

features.sort((a, b) => b.properties.area_m2 - a.properties.area_m2);
writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const withContents = features.filter((f) => f.properties.contents.length);
const renamed = features.filter((f) => f.properties.name !== f.properties.officialName);
console.log(`[build-directory] ${footprints.length} footprints -> ${features.length} buildings`);
console.log(`[build-directory] ${withContents.length} have a directory, `
  + `${features.reduce((n, f) => n + f.properties.contents.length, 0)} entries in total`);
console.log(`[build-directory] ${renamed.length} use the printed name over my campus's`);
console.log(`[build-directory] -> src/directory.json`);
for (const f of features) {
  const { name, officialName, parts, footprints: n, area_m2: area, contents } = f.properties;
  const also = name === officialName ? '' : `  (my campus: ${officialName})`;
  console.log(`[build-directory]   ${String(area).padStart(5)} m2 `
    + `${n > 1 ? `x${n}` : '  '} ${name}${also}  [${contents.length}]`
    + `${parts ? `  parts: ${parts.join(', ')}` : ''}`);
}
