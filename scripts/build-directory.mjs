/**
 * What is inside each building, so the map can answer a tap.
 *
 * The pieces already exist and have never been joined: src/buildings.json has
 * the footprints, src/labels.json has what the printed sheet calls them, and
 * src/places.json has my campus's 145 positioned destinations. 89 of those fall
 * inside a footprint — the Student Center and the Learning Resource Center
 * hold fourteen each, the Welcome and Support Center thirteen — and until now
 * there was no way to ask a building what it contains.
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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  groupByName, metresBetween, pointInRing, loadFootprints, adoptPrintedNames, wallNearest,
} from './building-names.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (name) => path.join(root, 'src', name);
const TARGET = src('directory.json');

const footprints = loadFootprints(src('buildings.json'));
const labels = JSON.parse(readFileSync(src('labels.json'), 'utf8')).features;
const places = JSON.parse(readFileSync(src('places.json'), 'utf8')).features;
const network = JSON.parse(readFileSync(src('paths.json'), 'utf8')).features;
const doors = existsSync(src('doors.json')) ? JSON.parse(readFileSync(src('doors.json'), 'utf8')).features : [];

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
/** The network as straight pieces, for wallNearest(). */
const segments = network.flatMap((segment) => segment.geometry.coordinates.slice(1)
  .map((b, k) => [segment.geometry.coordinates[k], b]));

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

/**
 * The doors build-walk-network.mjs recorded on each footprint, keyed by the
 * footprint's outline. buildings.json and doors.json both carry the sheet's own
 * polygon, so the outline is the join; six decimals, because the two files are
 * written at different precisions.
 */
const ringKey = (ring) => JSON.stringify(ring.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]));
const doorsByRing = new Map();
for (const f of doors) {
  const at = new Map();
  for (const stub of f.properties.stubs) for (const d of stub.doors) at.set(d.join(','), d);
  doorsByRing.set(ringKey(f.geometry.coordinates[0]), [...at.values()]);
}

/**
 * Where the card's Directions button sends you.
 *
 * A DOOR WHERE THE SHEET DRAWS ONE. The walls stage peels every approach path
 * the sheet runs into a building back to the wall, and the node it leaves there
 * is the one place on the building's outline a drawn path actually arrives:
 * the door. The card stands on its anchor, so the doors that count are those of
 * the footprint the anchor is in, and of several the one nearest the anchor —
 * the rule server/graph.js applies to a room inside a building, with the anchor
 * as the room. A door on another shard of the building does not: the CTE's one
 * drawn door is on its 1,600 m2 annexe, 90 m from the main building the card
 * points at.
 *
 * Otherwise where the network comes nearest the building's walls, which is
 * where a door most likely is (wallNearest() in building-names.mjs, which
 * build-walk-network.mjs has already put a node at). That used to be the only
 * rule, and on a building with a drawn door it could pick a path running past
 * the back wall: the Library's entrance sat 31 m round the building from the
 * one path the sheet draws into it.
 *
 * AND EVERY WAY IN, NOT ONLY THAT ONE (`doors`, entrance first). The entrance
 * is where the card's pin goes; it is not the only way in, and a walk to the
 * building should not be made to go round to it. server/graph.js takes any of
 * a building's `doors` as the end of a walk to it (see `entrances` in
 * createGraph), and the pin moves to the door the walk used. Three kinds go
 * in:
 *
 *   - Every drawn door of the footprint the card stands on, nearest the anchor
 *     first. The Parking Garage has five and the one nearest its anchor is on
 *     the west wall: with that as the only end, walks from the north came in
 *     71 m longer on average than when they ended at the north door, and Fine
 *     & Applied Arts, with four, was 70 m worse the same way.
 *   - Every drawn door of the building's OTHER footprints, nearest the anchor
 *     first. Not the entrance, as above, but a way in all the same: leaving
 *     them out gave the CTE only its east wall, so a walk from the Student
 *     Center went 412 m round to it rather than 98 m to the annexe's door,
 *     and Science & Engineering's doors on two of its shards, 2.9 m from the
 *     Science Success Center's wall, were never offered: 166 m between the two
 *     buildings, against 22 m with them.
 *   - Every point where the walls come nearest the network, after the drawn
 *     doors. The sheet draws a path into a building where it happens to, not
 *     into every door it has, and the walks this map used to give ended at
 *     the wall-nearest point. Moving the Library's end to its one drawn door
 *     made a walk from restroom #51 go from 92 to 171 m, though the old end
 *     was still on the graph 2.3 m from a corner. Both ends are offered now
 *     and the walk takes the nearer.
 *
 * Returns `nearWalls` too, each with its metres from the corner it is nearest:
 * a point can be nearest the walls of two buildings, and the caller gives it
 * to one (see below).
 */
function entranceFor(group) {
  const at = group.pole?.coordinates;
  const home = at && group.members.find((m) => pointInRing(at, m.geometry.coordinates[0]));
  const byAnchor = (x, y) => metresBetween(at, x) - metresBetween(at, y) || x[0] - y[0] || x[1] - y[1];
  const doorsOf = (m) => doorsByRing.get(ringKey(m.geometry.coordinates[0])) ?? [];
  const drawn = home ? [...doorsOf(home)].sort(byAnchor) : [];
  const own = new Set(drawn.map(keyOf));
  const shards = [];
  for (const m of group.members) {
    if (m === home) continue;
    for (const door of doorsOf(m)) {
      if (own.has(keyOf(door))) continue;
      own.add(keyOf(door));
      shards.push(door);
    }
  }
  shards.sort(byAnchor);
  const nearWalls = [];
  for (const { at: point, d } of wallNearest(group, segments)) {
    const node = nodeAt(point);
    if (!node || nearWalls.some((w) => keyOf(w.node) === keyOf(node))) continue;
    nearWalls.push({ node, d });
  }
  return { drawn, shards, nearWalls };
}

/**
 * The network's node at a point wallNearest() returned: the one
 * build-walk-network.mjs spliced there, or the end of the edge it reused
 * because the point was within a weld (WELD_M, 2 m) of it. Nearest vertex,
 * then, no further than that. A point with none is a network built before
 * entrances were spliced; it is counted, and falls back to the nearest vertex
 * however far, so an old paths.json still gives every building an entrance.
 */
const SPLICED_WITHIN_M = 2.01;
let unspliced = 0;
function nodeAt(point) {
  let best = null;
  for (const vertex of vertices) {
    const d = metresBetween(point, vertex);
    if (!best || d < best.d) best = { d, vertex };
  }
  if (best && best.d > SPLICED_WITHIN_M) unspliced += 1;
  return best?.vertex ?? null;
}
const keyOf = (c) => `${c[0]},${c[1]}`;

// Footprints the printed sheet names and my campus's touchable table does not —
// the Ranch House. See adoptPrintedNames() in building-names.mjs, which
// build-walk-network.mjs applies too, so that the buildings it splices
// entrances into are these.
adoptPrintedNames(footprints, labels);

const groups = [...groupByName(footprints).values()];

// ONE BUILDING PER WAY IN. A point can be where the walls of two buildings
// come nearest the network — the Gym and the Pool share a path along their
// common side — and server/graph.js files every door under the building it
// belongs to, so a node on two lists would make a walk to the Pool's entrance
// a walk to the Gym, and a walk from one to the other "the same place". So
// each goes to one building, in this order: the building whose drawn door it
// is; then a building with no drawn door, for which the walls are all there is
// to go by; then the building whose corner it is nearest. Nearest corner alone
// gave the Gym the point by the Pool's west wall — 0.8 m from a Gym corner, 7.4
// m from a Pool one, and a quarter of a metre from a door the Gym already has
// drawn — and left the Pool only its east side, so a walk from Adaptive PE next
// door went from 13 m to 49 m round to it.
const ways = new Map(groups.map((group) => [group, entranceFor(group)]));
const owner = new Map();
const claim = (node, group, rank) => {
  const held = owner.get(keyOf(node));
  if (!held || rank < held.rank) owner.set(keyOf(node), { group, rank });
};
const UNDRAWN_FIRST = 1e6;
for (const [group, { drawn, shards, nearWalls }] of ways) {
  for (const door of [...drawn, ...shards]) claim(door, group, -Infinity);
  for (const { node, d } of nearWalls) claim(node, group, drawn.length ? d : d - UNDRAWN_FIRST);
}
let givenAway = 0;
for (const [group, way] of ways) {
  const listed = new Set([...way.drawn, ...way.shards].map(keyOf));
  const extra = [];
  for (const { node } of way.nearWalls) {
    if (listed.has(keyOf(node))) continue;
    if (owner.get(keyOf(node)).group !== group) { givenAway += 1; continue; }
    listed.add(keyOf(node));
    extra.push(node);
  }
  // The entrance is what it always was — the card's footprint's nearest drawn
  // door, or where the walls come nearest — and the other shards' doors are
  // ways in after it, never in its place.
  way.doors = way.drawn.length ? [...way.drawn, ...way.shards, ...extra]
    : [...extra.slice(0, 1), ...way.shards, ...extra.slice(1)];
}

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
  const { doors: buildingDoors } = ways.get(group);
  const entrance = buildingDoors[0] ?? null;

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
      entrance,
      // Every way in, entrance first: the drawn doors of the footprint the card
      // stands on, then where the walls come nearest the network. A walk to
      // the building may end at any of them. See entranceFor().
      ...(buildingDoors.length ? { doors: buildingDoors } : {}),
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
const atDrawn = [...ways.values()].filter((w) => w.drawn.length).length;
console.log(`[build-directory] ${atDrawn} entrances at a door the walls stage recorded (src/doors.json), `
  + `${features.filter((f) => f.properties.entrance).length - atDrawn} where the walls come nearest the network`);
console.log(`[build-directory] ${features.reduce((n, f) => n + (f.properties.doors?.length ?? 0), 0)} ways in, `
  + `${[...ways.values()].reduce((n, w) => n + w.shards.length, 0)} drawn on another of the building's footprints, `
  + `${[...ways.values()].reduce((n, w) => n + w.doors.length - w.drawn.length - w.shards.length, 0)} `
  + 'where the walls come nearest; '
  + `${givenAway} left to another building that shares it`);
if (unspliced) {
  console.log(`[build-directory] WARNING: ${unspliced} wall-nearest point(s) with no node within a weld — `
    + 'src/paths.json predates them; rerun scripts/build-walk-network.mjs');
}
console.log(`[build-directory] -> src/directory.json`);
for (const f of features) {
  const { name, officialName, parts, footprints: n, area_m2: area, contents } = f.properties;
  const also = name === officialName ? '' : `  (my campus: ${officialName})`;
  console.log(`[build-directory]   ${String(area).padStart(5)} m2 `
    + `${n > 1 ? `x${n}` : '  '} ${name}${also}  [${contents.length}]`
    + `${parts ? `  parts: ${parts.join(', ')}` : ''}`);
}
