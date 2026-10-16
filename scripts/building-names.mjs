/**
 * Shared building helpers: where a name goes on a footprint, what the name
 * should say, and where on the network the building's way in most likely is.
 *
 * Lifted out of build-labels.mjs once build-directory.mjs needed the same two
 * things. Both scripts have to agree about which footprints are one building and
 * what that building is called, or the map would label a building one way and
 * the popup another. The last of them, wallNearest(), is shared for the same
 * reason between build-walk-network.mjs, which puts a node there, and
 * build-directory.mjs, which sends the card's Directions to it.
 */

import { readFileSync } from 'node:fs';

const M_PER_LAT = 111320;
const M_PER_LON = 111320 * Math.cos((38.6547 * Math.PI) / 180);
const toMetres = (ring) => ring.map(([lon, lat]) => [lon * M_PER_LON, lat * M_PER_LAT]);
export const metresBetween = ([ax, ay], [bx, by]) =>
  Math.hypot((bx - ax) * M_PER_LON, (by - ay) * M_PER_LAT);

/** Distance from a point to a ring in metres, positive inside. */
function signedDistance([px, py], ring) {
  let nearest = Infinity;
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    nearest = Math.min(nearest, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return inside ? nearest : -nearest;
}

/**
 * The point inside a footprint furthest from any wall, and how far that is.
 *
 * A centroid is the obvious choice and the wrong one: my campus has L-shaped and
 * U-shaped buildings whose centroid falls outside the walls, which would set
 * the name on the lawn next to the building it names. This is the pole of
 * inaccessibility, and its radius is also the useful part — it measures how
 * much room the building actually has for type, which is what sizes the label.
 *
 * Coarse grid first, then hill-climb with a halving step. Deterministic.
 */
export function poleOfInaccessibility(lonLatRing, { grid = 24, precision = 0.4 } = {}) {
  const ring = toMetres(lonLatRing);
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return null;

  let best = null;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const x = x0 + ((i + 0.5) * (x1 - x0)) / grid;
      const y = y0 + ((j + 0.5) * (y1 - y0)) / grid;
      const d = signedDistance([x, y], ring);
      if (!best || d > best.d) best = { x, y, d };
    }
  }
  let step = Math.max(x1 - x0, y1 - y0) / grid;
  while (step > precision) {
    let moved = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = best.x + dx * step;
      const y = best.y + dy * step;
      const d = signedDistance([x, y], ring);
      if (d > best.d) { best = { x, y, d }; moved = true; }
    }
    if (!moved) step /= 2;
  }
  return { coordinates: [best.x / M_PER_LON, best.y / M_PER_LAT], radius: best.d };
}

/**
 * my campus's database names, reduced to something a map can carry.
 *
 * Two mechanical rules cover most of it — strip a room reference, and turn an
 * "X - ABBR" pair into "X (ABBR)" — and the rest are one-off inconsistencies in
 * my campus's own strings, listed rather than parsed. Guessing a general rule from
 * four irregular examples would be worse than naming them.
 */
const RENAME = new Map([
  ['Bookstore - College Store', 'Bookstore'],
  ['Police - College', 'College Police'],
  ['STEM, Science Division - Science, Room 440', 'Science'],
  ['Printing Services Sign Shop', 'Printing Services'],
  ['Gym - MAIN and PRACT', 'Gym'],
]);

export function tidyName(raw) {
  if (RENAME.has(raw)) return RENAME.get(raw);
  let name = raw
    .replace(/\s*\((?:Rm|Room)[^)]*\)/i, '')
    .replace(/,?\s*Room\s+\d+\w*/i, '')
    .replace(/\s+Division$/i, '')
    .trim();
  // "Learning Resource Center - LRC" -> "Learning Resource Center (LRC)", but
  // only when the tail really is an abbreviation of the head.
  const pair = /^(.*?)\s+-\s+([A-Z][A-Za-z0-9 -]{0,14})$/.exec(name);
  if (pair) {
    const [, head, tail] = pair;
    const initials = head.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join('');
    const short = tail.replace(/[^A-Za-z]/g, '');
    if (short.toUpperCase() === initials.toUpperCase()) name = `${head} (${tail})`;
    else if (tail.length < head.length) name = head;
    else name = tail;
  }
  return name;
}

/** Ring containment, in lon/lat. svg-geometry's copy works in SVG units. */
export function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    if ((y1 > py) !== (y2 > py) && px < ((x2 - x1) * (py - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

export const loadFootprints = (file) => JSON.parse(readFileSync(file, 'utf8')).features;

/**
 * Footprints carrying the same tidied name are one building.
 *
 * my campus draws the Health Education Complex as nine separate shapes and the
 * Portable Village as seven. Treating each as its own building labels the name
 * nine times, and splits one directory entry into nine.
 *
 * Returns a Map of name -> { name, members, host, pole }, where host is the
 * largest member and pole is its label anchor.
 */
export function groupByName(footprints) {
  const groups = new Map();
  for (const footprint of footprints) {
    if (!footprint.properties.name) continue;
    const name = tidyName(footprint.properties.name);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(footprint);
  }
  return new Map([...groups].map(([name, members]) => {
    const host = members.reduce((a, b) => (a.properties.area_m2 >= b.properties.area_m2 ? a : b));
    return [name, {
      name,
      members,
      host,
      pole: poleOfInaccessibility(host.geometry.coordinates[0]),
    }];
  }));
}

/**
 * Footprints the printed sheet names and my campus's touchable table does not.
 *
 * build-buildings.mjs names a footprint from my campus's Touchable regions, which is
 * their own hand-authored answer to "what is this shape" and is right 71 times
 * out of 96. It is not the only answer. The Ranch House is drawn on the sheet,
 * printed with its name inside its own walls, and has no touchable region at
 * all — nobody at my campus ever made it a destination — so it arrived as a
 * nameless 315 m2 polygon and dropped out of `groupByName` before it could
 * become a building. On the map that reads as a labelled building you can tap
 * straight through: no card, no directory row, no flyover.
 *
 * Applied by build-directory.mjs, where the two naming sources already meet,
 * rather than upstream — build-labels.mjs reads buildings.json, and naming a
 * footprint from labels.json in the script that writes it would make the
 * pipeline a loop. build-walk-network.mjs applies it too, so the buildings it
 * splices entrances into (see wallNearest) are the directory's buildings.
 *
 * A `building` label ONLY, never a plate, and that restriction is the whole
 * rule. A building label is set inside the shape it names; a plate is set
 * beside it with a leader line, which means a plate lands on whatever happens
 * to be under it — Environmental Resources' plate sits on a 76 m2 outbuilding
 * that is not Environmental Resources, and adopting it would put a second row
 * of that name in the directory. Measured over the sheet, the restricted rule
 * claims exactly one footprint.
 *
 * Names the footprints in place, and returns them.
 */
export function adoptPrintedNames(footprints, labels) {
  for (const footprint of footprints) {
    if (footprint.properties.name) continue;
    const printed = labels.find((l) => l.properties.kind === 'building'
      && pointInRing(l.geometry.coordinates, footprint.geometry.coordinates[0]));
    if (printed) footprint.properties.name = printed.properties.text;
  }
  return footprints;
}

/**
 * Corners whose nearest network is within this of the nearest corner's are
 * tied for it. A metre, because that is how far a drawn stroke wanders about
 * its own line (build-walk-network.mjs's FOLD_M says the same of a stroke):
 * which corner of a building the network passes closest to is not decided by
 * less than the drawing's own slop.
 */
export const WALL_TIE_M = 1.0;
/** Two points this close are one node; build-walk-network.mjs's WELD_M. */
const WALL_WELD_M = 2.0;

/**
 * Where a building's walls come nearest the network: the points on the
 * network a door most likely is, nearest first.
 *
 * The directory's rule for a building the sheet draws no door into, and an
 * addition to the doors of one it does (build-directory.mjs, entranceFor).
 * Each corner of each outline is taken to the nearest point on the network —
 * on an edge, not at a vertex — and every corner within WALL_TIE_M of the
 * nearest one offers its point; points within a weld of one already offered
 * are the same one.
 *
 * ON AN EDGE, BECAUSE THE BUILD DECIDES WHERE THE VERTICES ARE. This used to
 * be the network VERTEX nearest a corner, and that is only the nearest point
 * where the drawing happens to put a vertex. The collapse stage of
 * build-walk-network.mjs now makes a stroke traced as a run of near-collinear
 * points the one straight edge it is, and with the vertex gone the entrance
 * jumped to whichever corner's vertex survived: the Learning Resource Center's
 * by 53 m, though the network still passed 0.3 m from where it had been, and
 * walks from it to Davies Hall went from 87 to 145 m. build-walk-network.mjs
 * splices a node at every point this returns, as it does for every place, so
 * the directory finds a vertex wherever it looks.
 *
 * EVERY CORNER ABOUT AS NEAR, NOT ONLY THE NEAREST. Which corner the network
 * passes closest to is often a matter of centimetres — the Welcome and Support
 * Center's two were 0.38 and 0.42 m off — and choosing one moves the whole
 * building's way in to that side of it. Each is as likely the door as the
 * other, so each is offered, and the router's any-door rule (see `entrances`
 * in server/graph.js) lets a walk end at whichever suits it.
 *
 * `segments` is the network as [[lon, lat], [lon, lat]] pairs. Returns
 * [{ at, d }] — the point, and metres from its corner — nearest first.
 */
export function wallNearest(group, segments) {
  const flat = ([lon, lat]) => [lon * M_PER_LON, lat * M_PER_LAT];
  const flatSegs = segments.map(([a, b]) => [flat(a), flat(b), a, b]);
  const found = [];
  for (const member of group.members) {
    for (const ring of member.geometry.coordinates) {
      for (const corner of ring) {
        const [px, py] = flat(corner);
        let best = null;
        for (const [[ax, ay], [bx, by], a, b] of flatSegs) {
          const vx = bx - ax, vy = by - ay;
          const L = vx * vx + vy * vy;
          const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L));
          const d = Math.hypot(px - ax - t * vx, py - ay - t * vy);
          if (!best || d < best.d) best = { d, at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
        }
        if (best) found.push(best);
      }
    }
  }
  if (!found.length) return [];
  found.sort((x, y) => x.d - y.d || x.at[0] - y.at[0] || x.at[1] - y.at[1]);
  const reach = found[0].d + WALL_TIE_M;
  const offered = [];
  for (const point of found) {
    if (point.d > reach) break;
    if (offered.some((o) => metresBetween(o.at, point.at) < WALL_WELD_M)) continue;
    offered.push(point);
  }
  return offered;
}

/**
 * A way in for every shard of a building, not only the shards nearest the
 * network.
 *
 * wallNearest() ties corners against the nearest corner of the whole group,
 * so on a building drawn as several footprints the shards further from the
 * network than the nearest one plus WALL_TIE_M offer nothing: three of the
 * Portable Village's seven were 66-68 m by the graph from a way in, with a
 * path 16 m from their own walls, and Technical Education West's southern
 * portables 48-66 m. So each member is also asked on its own, and its nearest
 * point is offered when it is within MEMBER_REACH_M of the member's walls.
 * build-directory.mjs lists it only where no way in already lies within
 * MEMBER_APART_M of it (see entranceFor); build-walk-network.mjs splices a
 * node at every one, as at wallNearest()'s. Only for a group of more than one
 * footprint: a single building's walls are wallNearest()'s question, and a
 * door on every face of it would be a guess.
 *
 * Returns [{ at, d }], one per member that qualifies, in member order.
 */
export const MEMBER_REACH_M = 12;
export const MEMBER_APART_M = 20;
export function memberNearest(group, segments) {
  if (group.members.length < 2) return [];
  return group.members
    .map((member) => wallNearest({ members: [member] }, segments)[0])
    .filter((point) => point && point.d <= MEMBER_REACH_M);
}
