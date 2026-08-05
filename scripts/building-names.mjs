/**
 * Shared building helpers: where a name goes on a footprint, and what the name
 * should say.
 *
 * Lifted out of build-labels.mjs once build-directory.mjs needed the same two
 * things. Both scripts have to agree about which footprints are one building and
 * what that building is called, or the map would label a building one way and
 * the popup another.
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
