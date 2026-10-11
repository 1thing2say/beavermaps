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
  memberNearest, MEMBER_APART_M, WALL_TIE_M,
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

/**
 * The vertices only the plaza crossings touch (src/plaza-paths.json): corners
 * pushed clear of an obstacle and points where two crossings cross. The router
 * walks them like any other node, and where one stands a metre from a wall
 * across open paving it is as good a way in as any the network offers — STEM
 * and TEW have them 1.2-1.3 m from their walls, against the nearest drawn path
 * further off. Offered to wallNearest() as points, so what it returns is
 * always one of them, never a point along a crossing.
 */
const plazaFile = src('plaza-paths.json');
const plazaPoints = [];
if (existsSync(plazaFile)) {
  const seenHere = new Set(seen);
  for (const f of JSON.parse(readFileSync(plazaFile, 'utf8')).features) {
    for (const c of f.geometry.coordinates) {
      const key = `${c[0]},${c[1]}`;
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      plazaPoints.push(c);
    }
  }
}

/** Network adjacency with metres, for the walk from a drawn door (see entranceFor). */
const adjacency = new Map();
for (const segment of network) {
  const cs = segment.geometry.coordinates;
  for (let k = 1; k < cs.length; k += 1) {
    const [a, b] = [`${cs[k - 1][0]},${cs[k - 1][1]}`, `${cs[k][0]},${cs[k][1]}`];
    const m = metresBetween(cs[k - 1], cs[k]);
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push([b, m]);
    adjacency.get(b).push([a, m]);
  }
}
/** Every node within `cap` metres of `from` by the network. */
function within(from, cap) {
  const best = new Map([[from, 0]]);
  const queue = [[0, from]];
  while (queue.length) {
    queue.sort((x, y) => x[0] - y[0]);
    const [d, n] = queue.shift();
    if (d > best.get(n)) continue;
    for (const [m, w] of adjacency.get(n) ?? []) {
      if (d + w > cap || d + w >= (best.get(m) ?? Infinity)) continue;
      best.set(m, d + w);
      queue.push([d + w, m]);
    }
  }
  return best;
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
 * the door. The card stands on its anchor, so the entrance is a door of the
 * footprint the anchor is in, and of several the one nearest the anchor — the
 * rule server/graph.js applies to a room inside a building, with the anchor as
 * the room. A door on another shard of the building is not the entrance (the
 * CTE's is on its north wing, 4.7 m from the main building but 90 m from the
 * anchor the card points at), but it is a way in, listed after the home
 * footprint's: see below.
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
 * createGraph), and the pin moves to the door the walk used. Four kinds go
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
 *     and the walk takes the nearer. Those are asked of the
 *     whole building, so on one drawn as several footprints the shards
 *     further from the network than the nearest offered nothing; each shard
 *     with no way in within MEMBER_APART_M is now offered its own nearest
 *     point (memberNearest() in building-names.mjs). The Portable Village's
 *     furthest three were 66-68 m by the graph from a way in, with a path
 *     16 m from their walls.
 *   - Last, the plaza crossings' own corners where one stands nearest the
 *     walls (see plazaPoints): STEM's and TEW's, a metre off the wall across
 *     open paving.
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
  const take = (point, d, how) => {
    const node = how === 'plaza' ? point : nodeAt(point);
    if (!node || nearWalls.some((w) => keyOf(w.node) === keyOf(node))) return;
    nearWalls.push({ node, d, how });
  };
  for (const { at: point, d } of wallNearest(group, segments)) take(point, d, 'walls');
  // A shard no way in reaches (memberNearest() in building-names.mjs).
  for (const { at: point, d } of memberNearest(group, segments)) {
    const node = nodeAt(point);
    if (node && [...drawn, ...shards, ...nearWalls.map((w) => w.node)].every((w) => metresBetween(w, node) > MEMBER_APART_M)) take(point, d, 'member');
  }
  // A plaza corner a metre off the wall, tied with the nearest as wallNearest()
  // ties corners, over the network and the plaza points together. Only the
  // plaza points are taken from it, after the rest: what the network offers
  // stays offered, so a walk can only get shorter for it.
  const pointSegs = plazaPoints.map((c) => [c, c]);
  const plazaKeys = new Set(plazaPoints.map(keyOf));
  for (const { at: point, d } of wallNearest(group, [...segments, ...pointSegs])) {
    if (plazaKeys.has(keyOf(point))) take(point, d, 'plaza');
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
/** build-walk-network.mjs's weld: two points this close are one node. */
const WELD_M = 2.0;
for (const [group, { drawn, shards, nearWalls }] of ways) {
  for (const door of [...drawn, ...shards]) claim(door, group, -Infinity);
  for (const { node, d, how } of nearWalls) if (how !== 'plaza') claim(node, group, drawn.length ? d : d - UNDRAWN_FIRST);
}
// NOT IN SOMEONE ELSE'S BUILDING, AND NOT AT SOMEONE ELSE'S DOOR. A point
// where one building's walls come nearest can lie inside another's footprint
// — the Pool's and Adaptive PE's used to be inside the Gym, on a path the Gym
// was drawn over — or a step from another building's door, where a walk to
// one building would end at the other's. Refused, both. The claims above
// settle a node two buildings both offer; this settles two nodes a weld or
// two apart, for the same reason.
const NEIGHBOUR_DOOR_M = 2 * WELD_M;
const inOther = (node, group) => groups.some((g) => g !== group && inAnyMember(node, g.members));
/** Metres from p to the nearest wall of any member of a group. */
const LON_M = metresBetween([0, 38.65], [1, 38.65]), LAT_M = metresBetween([0, 0], [0, 1]);
const wallsOf = (p, group) => Math.min(...group.members.flatMap((m) => m.geometry.coordinates.flatMap((ring) => ring.slice(1).map((b, k) => {
  const a = ring[k];
  const [ax, ay, bx, by, px, py] = [a[0], a[1], b[0], b[1], p[0], p[1]].map((v, i) => v * (i % 2 ? LAT_M : LON_M));
  const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}))));
// "Someone else's door" is one a step away that the other building has the
// better claim to, from a point plainly nearer their walls than this
// building's — by more than WALL_TIE_M, the drawing's own slop. Two buildings
// side by side each have a corner on the path between them, a couple of
// metres apart and as near one wall as the other (Fine & Applied Arts' and the
// Evangelisti Center's, 2.83 and 2.61 m), and each keeps its own.
const nearOthers = (node, group, rank) => [...owner].some(([key, held]) => held.group !== group
  && held.rank < rank && metresBetween(key.split(',').map(Number), node) < NEIGHBOUR_DOOR_M
  && wallsOf(node, held.group) + WALL_TIE_M <= wallsOf(node, group));
// AND NOT A STEP SHORT OF A DRAWN DOOR. Where the sheet draws an approach path
// into a building and the walls stage peels it back to the wall, the door is
// at the end of a dead end, and the network on its way there can pass nearer
// the walls than the door itself. Kinesiology's wall-nearest point was 7.3 m
// back along its own approach from the door the sheet draws, and walks ended
// there, short of it. A wall-nearest point that close by the network to a
// door that ends a dead end is that door's approach, and the door stands.
const APPROACH_M = 10;
const deadEnd = (door) => (adjacency.get(keyOf(door)) ?? []).length === 1;
let givenAway = 0, refused = 0, approaches = 0;
for (const [group, way] of ways) {
  const listed = new Set([...way.drawn, ...way.shards].map(keyOf));
  const short = new Set();
  for (const door of [...way.drawn, ...way.shards].filter(deadEnd)) {
    for (const key of within(keyOf(door), APPROACH_M).keys()) short.add(key);
  }
  const extra = [];
  const onApproach = [];
  for (const wall of way.nearWalls) {
    const { node, d, how } = wall;
    if (listed.has(keyOf(node))) continue;
    const held = owner.get(keyOf(node));
    if (held && held.group !== group) { givenAway += 1; continue; }
    const rank = way.drawn.length ? d : d - UNDRAWN_FIRST;
    if (inOther(node, group) || nearOthers(node, group, held?.rank ?? rank)) { refused += 1; continue; }
    if (how !== 'plaza' && short.has(keyOf(node))) { onApproach.push(wall); continue; }
    listed.add(keyOf(node));
    extra.push(node);
  }
  // Bar the one place the walls come nearest of all, where nothing else is
  // offered within a weld of it: a walk to the building with no door there
  // ends there. Dropped as an approach, it left the Health Education
  // Complex's nearest way in 6.6 m off, round a portable from its door.
  const nearest = way.nearWalls.filter((w) => w.how === 'walls').reduce((a, b) => (!a || b.d < a.d ? b : a), null);
  for (const wall of onApproach) {
    const others = [...way.drawn, ...way.shards, ...extra];
    if (wall === nearest && others.every((x) => metresBetween(x, wall.node) > WELD_M)) extra.push(wall.node);
    else approaches += 1;
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
  + `${givenAway} left to another building that shares it, ${refused} inside another building or a step from its door, `
  + `${approaches} on a drawn door's own approach within ${APPROACH_M} m`);
console.log(`[build-directory] ${[...ways.values()].reduce((n, w) => n + w.drawn.length, 0)} drawn doors, `
  + `${[...ways.values()].reduce((n, w) => n + w.doors.filter((d) => w.nearWalls.some((x) => x.how === 'member' && keyOf(x.node) === keyOf(d))).length, 0)} ways in for a shard no other reaches, `
  + `${[...ways.values()].reduce((n, w) => n + w.doors.filter((d) => plazaPoints.some((c) => keyOf(c) === keyOf(d))).length, 0)} on a plaza crossing`);
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
