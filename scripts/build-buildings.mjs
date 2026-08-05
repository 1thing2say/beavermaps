/**
 * Extract campus building footprints from the archived my campus basemap SVG.
 *
 * The SVG carries no semantic layer names — every group id is a UUID and there
 * are no <text> elements, because the labels are outlined paths. Buildings are
 * therefore identified by how they are drawn. Three facts about the file, each
 * checked by rendering the classification back over the map and looking at it:
 *
 *   1. Buildings are the #fff shapes. The ground is #c7c8ca, landscaping is
 *      #577f3d / #bcd37e, parking lots are #a9afb7, label plates are #4e4e4f,
 *      the pool is #37afcb. Verified by testing which fill sits under each of
 *      the 83 hand-authored Touchable regions: 53 landed on #fff, more than
 *      every other fill combined.
 *   2. Most #fff shapes are not buildings — 1957 of them exist, with a median
 *      area of 7.8 m², because outlined label glyphs, parking stall stripes and
 *      UI chips are also white. Area does most of the separating.
 *   3. Between 60 and 400 m² the two mix. Real structures there (the portables
 *      by Technical Education West, the ERI outbuildings, stadium bleachers,
 *      dugouts) are rects and simple polygons; decoration is curved paths with
 *      many vertices — outlined letters, and the four "P" parking pins, which
 *      are nested rounded squares of exactly 15.0x15.0 m and 17.3x17.3 m.
 *      Hence GLYPH_VERTS. The rule has to be gated by area because Arts &
 *      Sciences, the Welcome and Support Center and the ITC are genuinely
 *      curvy buildings; they sit at 630 m² and up, against 284 m² for the
 *      largest chip, so KEEP_ALWAYS_M2 is placed inside that gap.
 *
 * Names come from the Touchable table, whose regions are bound to LocationIDs;
 * a footprint is named when a touchable's centroid falls inside it.
 *
 * Source lives under campus-data/, which is gitignored — see
 * campus-data/MANIFEST.md. Output src/buildings.json is committed.
 *
 *   node scripts/build-buildings.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, M_PER_UNIT_X, M_PER_UNIT_Y, M2_PER_UNIT2 } from './projection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(root, 'campus-data/wayfind/api');
const TARGET = path.join(root, 'src/buildings.json');

const BUILDING_FILL = '#fff';
const BUILDING_STROKE = '#231f20'; // every real footprint is outlined in this
const DECOR_STROKE = '#a6a6a6';    // the three street-label plates down the west edge
const KEEP_ALWAYS_M2 = 400; // above this, every #fff shape was a building
const KEEP_MAYBE_M2 = 60;   // below this, everything was a glyph or a stall stripe
const MIN_SPAN_M = 3.5;     // kills parking stall stripes, which are ~0.5 m wide
const GLYPH_VERTS = 40;     // outlined letters flatten to far more points than a footprint

// No height data exists anywhere in their system, so these are placeholders
// chosen to look right under a pitched camera — not measurements.
const HEIGHT_SMALL_M = 4;
const HEIGHT_DEFAULT_M = 9;
const SMALL_BUILDING_M2 = 200;

const CURVE_CMD = /[csqtaCSQTA]/;
const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const nums = (s) => (s ? (s.match(NUM) ?? []).map(Number) : []);

// --- geometry ---------------------------------------------------------------

function flattenCubic(p0, c1, c2, p3, n = 12) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

function flattenQuad(p0, c1, p2, n = 8) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * c1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * c1[1] + t * t * p2[1],
    ]);
  }
  return out;
}

/** Flatten a path `d` into closed rings. Covers M l h v c s q Z and absolutes. */
function parsePath(d) {
  const toks = d.split(/([MmLlHhVvCcSsQqTtAaZz])/).filter((t) => t.trim());
  const rings = [];
  let cur = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let ctrl = null, prev = '';

  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    if (!/^[MmLlHhVvCcSsQqTtAaZz]$/.test(raw)) continue;
    const rel = raw === raw.toLowerCase();
    let c = raw.toUpperCase();
    const args = /^[MmLlHhVvCcSsQqTtAaZz]$/.test(toks[i + 1] ?? '') ? [] : nums(toks[++i]);

    if (c === 'Z') {
      if (cur.length) { cur.push([sx, sy]); rings.push(cur); cur = []; }
      [x, y] = [sx, sy];
      ctrl = null; prev = c;
      continue;
    }

    const k = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[c];
    for (let j = 0; j + k <= args.length; j += k) {
      const a = args.slice(j, j + k);
      if (c === 'M') {
        if (cur.length) rings.push(cur);
        [x, y] = rel ? [x + a[0], y + a[1]] : [a[0], a[1]];
        [sx, sy] = [x, y];
        cur = [[x, y]];
        c = 'L'; // repeated pairs after a moveto are implicit linetos
      } else if (c === 'L') {
        [x, y] = rel ? [x + a[0], y + a[1]] : [a[0], a[1]];
        cur.push([x, y]);
      } else if (c === 'H') {
        x = rel ? x + a[0] : a[0];
        cur.push([x, y]);
      } else if (c === 'V') {
        y = rel ? y + a[0] : a[0];
        cur.push([x, y]);
      } else if (c === 'C' || c === 'S') {
        let c1, c2, e;
        if (c === 'C') {
          c1 = rel ? [x + a[0], y + a[1]] : [a[0], a[1]];
          c2 = rel ? [x + a[2], y + a[3]] : [a[2], a[3]];
          e = rel ? [x + a[4], y + a[5]] : [a[4], a[5]];
        } else {
          c1 = ctrl && 'CS'.includes(prev) ? [2 * x - ctrl[0], 2 * y - ctrl[1]] : [x, y];
          c2 = rel ? [x + a[0], y + a[1]] : [a[0], a[1]];
          e = rel ? [x + a[2], y + a[3]] : [a[2], a[3]];
        }
        cur.push(...flattenCubic([x, y], c1, c2, e));
        ctrl = c2;
        [x, y] = e;
      } else if (c === 'Q' || c === 'T') {
        let c1, e;
        if (c === 'Q') {
          c1 = rel ? [x + a[0], y + a[1]] : [a[0], a[1]];
          e = rel ? [x + a[2], y + a[3]] : [a[2], a[3]];
        } else {
          c1 = ctrl && 'QT'.includes(prev) ? [2 * x - ctrl[0], 2 * y - ctrl[1]] : [x, y];
          e = rel ? [x + a[0], y + a[1]] : [a[0], a[1]];
        }
        cur.push(...flattenQuad([x, y], c1, e));
        ctrl = c1;
        [x, y] = e;
      } else if (c === 'A') {
        [x, y] = rel ? [x + a[5], y + a[6]] : [a[5], a[6]];
        cur.push([x, y]); // chord fallback; this file contains no arcs
      }
      prev = c;
    }
    if (!'CSQT'.includes(c)) ctrl = null;
  }
  if (cur.length) rings.push(cur);
  return rings;
}

const matMul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Only translate/rotate/scale/matrix appear in this file, always on the shape. */
function parseTransform(t) {
  let m = [1, 0, 0, 1, 0, 0];
  for (const [, fn, arg] of (t ?? '').matchAll(/([a-zA-Z]+)\(([^)]*)\)/g)) {
    const v = nums(arg);
    if (fn === 'translate') m = matMul(m, [1, 0, 0, 1, v[0], v[1] ?? 0]);
    else if (fn === 'scale') m = matMul(m, [v[0], 0, 0, v[1] ?? v[0], 0, 0]);
    else if (fn === 'matrix') m = matMul(m, v);
    else if (fn === 'rotate') {
      const r = (v[0] * Math.PI) / 180;
      const [cos, sin] = [Math.cos(r), Math.sin(r)];
      if (v.length === 3) {
        m = matMul(m, [1, 0, 0, 1, v[1], v[2]]);
        m = matMul(m, [cos, sin, -sin, cos, 0, 0]);
        m = matMul(m, [1, 0, 0, 1, -v[1], -v[2]]);
      } else m = matMul(m, [cos, sin, -sin, cos, 0, 0]);
    }
  }
  return m;
}

const applyMat = (m, ring) =>
  ring.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);

function shoelace(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

const ringArea = (ring) => Math.abs(shoelace(ring));

/** Shorter bbox side, in ground metres. The two axes scale differently. */
function minSpanMetres(ring) {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return Math.min(
    (Math.max(...xs) - Math.min(...xs)) * M_PER_UNIT_X,
    (Math.max(...ys) - Math.min(...ys)) * M_PER_UNIT_Y,
  );
}

function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const cr = x1 * y2 - x2 * y1;
    a += cr; cx += (x1 + x2) * cr; cy += (y1 + y2) * cr;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    if ((y1 > py) !== (y2 > py) && px < ((x2 - x1) * (py - y1)) / (y2 - y1) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

// --- read the SVG -----------------------------------------------------------

/**
 * Scan shape elements out of the SVG. Regex rather than a parser because this
 * is machine-generated Illustrator output with flat structure, no <g>
 * transforms and no nesting to accumulate — verified against the file.
 */
function readShapes(svg) {
  const out = [];
  // <polyline> is deliberately absent: it is an open figure, used here only for
  // stroked line work. The file's one white polyline is a zigzag path marking,
  // which SVG still fills, so it has to be excluded by type rather than by area.
  for (const [, tag, attrText] of svg.matchAll(/<(rect|polygon|path)\b([^>]*)>/g)) {
    const at = {};
    for (const [, k, v] of attrText.matchAll(/([\w:-]+)="([^"]*)"/g)) at[k] = v;
    if (at.fill !== BUILDING_FILL) continue;

    // Rounded corners mean a UI chip, not a footprint: the "P" parking pins and
    // the BUS/SOS edge markers are white rects with rx/ry, and the markers are
    // large enough (381 m²) to clear the area test on their own. No building on
    // this sheet is drawn with a corner radius.
    if (at.rx !== undefined || at.ry !== undefined) continue;
    if (at.stroke === DECOR_STROKE) continue;

    let rings;
    if (tag === 'rect') {
      const x = +(at.x ?? 0), y = +(at.y ?? 0);
      const w = +(at.width ?? 0), h = +(at.height ?? 0);
      rings = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
    } else if (tag === 'polygon') {
      const v = nums(at.points);
      const ring = [];
      for (let i = 0; i + 1 < v.length; i += 2) ring.push([v[i], v[i + 1]]);
      if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) {
        ring.push(ring[0]);
      }
      rings = [ring];
    } else {
      rings = parsePath(at.d ?? '');
    }

    const m = parseTransform(at.transform);
    const curvy = tag === 'path' && CURVE_CMD.test(at.d ?? '');
    for (const r of rings) {
      if (r.length >= 4) out.push({ tag, curvy, ring: applyMat(m, r) });
    }
  }
  return out;
}

/** Rebuild a Touchable row's ring in SVG space. */
function touchableRing({ Type, Attribute: a }) {
  let ring;
  if (Type === 'rect') {
    ring = [[a.X, a.Y], [a.X + a.Width, a.Y], [a.X + a.Width, a.Y + a.Height], [a.X, a.Y + a.Height], [a.X, a.Y]];
  } else if (Type === 'polygon' || Type === 'polyline') {
    const v = nums(a.Points);
    ring = [];
    for (let i = 0; i + 1 < v.length; i += 2) ring.push([v[i], v[i + 1]]);
    if (ring.length) ring.push(ring[0]);
  } else if (Type === 'path') {
    const rs = parsePath(a.D ?? '');
    ring = rs.length ? rs.reduce((b, r) => (ringArea(r) > ringArea(b) ? r : b)) : null;
  } else return null;
  if (!ring || ring.length < 4) return null;
  return applyMat(parseTransform(a.Transform), ring);
}

// --- build ------------------------------------------------------------------

const svg = readFileSync(path.join(DATA, 'ActiveMap.svg'), 'utf8');
const touchables = JSON.parse(readFileSync(path.join(DATA, 'Touchable.json'), 'utf8'));
const locations = new Map(
  JSON.parse(readFileSync(path.join(DATA, 'locations.json'), 'utf8')).map((l) => [l.ID, l]),
);

const shapes = readShapes(svg);
const buildings = [];
for (const s of shapes) {
  const m2 = ringArea(s.ring) * M2_PER_UNIT2;
  let keep;
  if (m2 >= KEEP_ALWAYS_M2) keep = true;
  else if (m2 >= KEEP_MAYBE_M2) {
    keep = minSpanMetres(s.ring) >= MIN_SPAN_M
      && !(s.curvy && s.ring.length > GLYPH_VERTS);
  } else keep = false;
  if (keep) buildings.push({ ...s, m2 });
}

// Name a footprint when a hand-authored touchable region sits inside it. Where
// footprints nest, the smallest container wins: taking the first match in
// document order instead makes the assignment depend on paint order, so it
// silently moves to a different polygon whenever the kept set changes.
const named = new Map();
for (const t of touchables) {
  const ring = touchableRing(t);
  if (!ring) continue;
  const c = centroid(ring);

  let hit = -1;
  let best = Infinity;
  buildings.forEach((b, i) => {
    if (b.m2 < best && pointInRing(c, b.ring)) {
      best = b.m2;
      hit = i;
    }
  });
  if (hit < 0) continue;

  const name = locations.get(t.LocationID)?.Name;
  if (name && !named.has(hit)) named.set(hit, name);
}

const features = buildings.map((b, i) => {
  let ring = b.ring.map(project);
  // GeoJSON wants exterior rings counter-clockwise. Projecting flips the sign,
  // because SVG y grows downward and latitude grows upward.
  if (shoelace(ring) < 0) ring = ring.reverse();
  return {
    type: 'Feature',
    properties: {
      name: named.get(i) ?? null,
      // Placeholder, not survey data — see HEIGHT_* above.
      height: b.m2 < SMALL_BUILDING_M2 ? HEIGHT_SMALL_M : HEIGHT_DEFAULT_M,
      area_m2: Math.round(b.m2),
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
});

writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const total = features.reduce((s, f) => s + f.properties.area_m2, 0);
console.log(`[build-buildings] ${shapes.length} #fff shapes -> ${features.length} footprints`);
console.log(`[build-buildings] named ${named.size}, total footprint area ${total.toLocaleString()} m2`);
console.log(`[build-buildings] -> src/buildings.json`);
