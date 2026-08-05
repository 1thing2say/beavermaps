/**
 * Geometry helpers for reading my campus's ActiveMap.svg.
 *
 * Lifted verbatim out of build-buildings.mjs once a second and third script
 * needed the same parser. Nothing here is generic SVG support — it covers
 * exactly what this one machine-generated Illustrator file contains, which is
 * why readShapes can get away with a regex instead of a DOM.
 *
 * The path parser is the part that matters. scripts/projection.mjs records a
 * fit that came out at 110 m because an earlier pass treated every number in a
 * `d` attribute as a coordinate; relative commands and bezier control points
 * make that meaningless. Do not reintroduce that shortcut.
 */

import { M_PER_UNIT_X, M_PER_UNIT_Y } from './projection.mjs';

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
export const nums = (s) => (s ? (s.match(NUM) ?? []).map(Number) : []);

/** Matches any curve command, i.e. "this shape is drawn, not boxed". */
export const CURVE_CMD = /[csqtaCSQTA]/;

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
/**
 * Every subpath of a `d` attribute, as { pts, closed }.
 *
 * `closed` records whether the subpath ended on Z. It is the only thing that
 * separates an area from a line here: a stroked walkway and a filled lawn are
 * both just a list of points until you know whether the author closed it.
 */
export function parseSubpaths(d) {
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
      if (cur.length) { cur.push([sx, sy]); rings.push({ pts: cur, closed: true }); cur = []; }
      [x, y] = [sx, sy];
      ctrl = null; prev = c;
      continue;
    }

    const k = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[c];
    for (let j = 0; j + k <= args.length; j += k) {
      const a = args.slice(j, j + k);
      if (c === 'M') {
        if (cur.length) rings.push({ pts: cur, closed: false });
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
  if (cur.length) rings.push({ pts: cur, closed: false });
  return rings;
}

/** Subpath point lists only, for callers that treat every subpath as a ring. */
export const parsePath = (d) => parseSubpaths(d).map((s) => s.pts);

export const matMul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Only translate/rotate/scale/matrix appear in this file, always on the shape. */
export function parseTransform(t) {
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

export const applyMat = (m, ring) =>
  ring.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);

export function shoelace(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

export const ringArea = (ring) => Math.abs(shoelace(ring));

/** [minX, minY, maxX, maxY] in SVG units. */
export function bbox(ring) {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Bounding-box centre, NOT the shoelace centroid.
 *
 * projection.mjs records why: shoelace moment sums lose most of their
 * significant digits once coordinates are used in lon/lat, and small footprints
 * came out with centroids hundreds of metres away. It is also what Overpass
 * `out center` returns, so both sides of any OSM comparison agree.
 */
export function bboxCentre(ring) {
  const [x0, y0, x1, y1] = bbox(ring);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/** Shorter bbox side, in ground metres. The two axes scale differently. */
export function minSpanMetres(ring) {
  const [x0, y0, x1, y1] = bbox(ring);
  return Math.min((x1 - x0) * M_PER_UNIT_X, (y1 - y0) * M_PER_UNIT_Y);
}

export function centroid(ring) {
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

export function pointInRing([px, py], ring) {
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
 * Scan shape elements out of the SVG, one entry per element, keeping the rings
 * of a compound path together. Regex rather than a parser because this is
 * machine-generated Illustrator output with flat structure, no <g> transforms
 * and no nesting to accumulate — verified against the file.
 *
 * <polyline> is deliberately excluded: it is an open figure by definition, used
 * here only for stroked line work, and SVG would still fill it.
 *
 * Grouping matters for anything with a hole in it. The stadium track is one
 * <path> holding two subpaths, an outer and an inner oval; split into separate
 * shapes it stops being a track and becomes a filled lozenge.
 *
 * Returns { tag, attrs, curvy, rings } with the shape's own transform applied.
 * Callers filter by fill.
 */
export function readShapeGroups(svg) {
  const out = [];
  for (const [, tag, attrText] of svg.matchAll(/<(rect|polygon|path)\b([^>]*)>/g)) {
    const attrs = {};
    for (const [, k, v] of attrText.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[k] = v;

    let rings;
    if (tag === 'rect') {
      const x = +(attrs.x ?? 0), y = +(attrs.y ?? 0);
      const w = +(attrs.width ?? 0), h = +(attrs.height ?? 0);
      rings = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
    } else if (tag === 'polygon') {
      const v = nums(attrs.points);
      const ring = [];
      for (let i = 0; i + 1 < v.length; i += 2) ring.push([v[i], v[i + 1]]);
      if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) {
        ring.push(ring[0]);
      }
      rings = [ring];
    } else {
      rings = parsePath(attrs.d ?? '');
    }

    const m = parseTransform(attrs.transform);
    const curvy = tag === 'path' && CURVE_CMD.test(attrs.d ?? '');
    const kept = rings.filter((r) => r.length >= 4).map((r) => applyMat(m, r));
    if (kept.length) out.push({ tag, attrs, curvy, rings: kept });
  }
  return out;
}

/**
 * readShapeGroups flattened to one entry per ring, as { tag, attrs, curvy, ring }.
 *
 * This is what build-buildings and build-amenities want: both classify by the
 * size of an individual ring, and neither has a shape with a hole in it.
 */
export function readShapes(svg) {
  return readShapeGroups(svg).flatMap(({ tag, attrs, curvy, rings }) =>
    rings.map((ring) => ({ tag, attrs, curvy, ring })));
}

/**
 * <circle> and <ellipse>, as { attrs, centre, rx, ry } in SVG units.
 *
 * Kept out of readShapes on purpose. There are only 22 of them in the whole
 * file and three are white, which would put them into build-buildings' footprint
 * candidate set for no gain — the largest is 59.6 m², a hair under its 60 m²
 * floor, so the classification would sit right on a threshold it currently
 * clears comfortably. Callers that want circles ask for them.
 */
const DRAW_TAGS = ['rect', 'polygon', 'polyline', 'line', 'path', 'circle', 'ellipse'];

/**
 * The whole drawing, every drawable element, in document order.
 *
 * readShapeGroups answers "which shapes are this colour"; this answers "what is
 * on the sheet, in the order it was painted". A flat vector map is a painter's
 * algorithm — trees over lawn, stalls over tarmac — so the index each element
 * comes back with is load-bearing, not bookkeeping.
 *
 * Differences from readShapeGroups, all of them deliberate:
 *   - <line> and <polyline> are included. There are 169 of them and they are the
 *     campus driveways and walkways, drawn as strokes with no fill at all.
 *   - Subpaths carry `closed`, so an open stroked figure stops being mistaken
 *     for a ring.
 *   - Nothing is dropped for having too few points. A <line> has two.
 *   - <defs> and <clipPath> contents are skipped. Both clip paths in this file
 *     are a full-page rect, and readShapeGroups currently reports them as two
 *     phantom fill:none shapes covering the entire sheet.
 *   - <g> is tracked, so group opacity and clip-path reach the elements inside.
 *     Five groups carry opacity here; ignoring them loses the wash on the
 *     shadowed areas.
 *
 * Each element also reports the top-level <g> it belongs to, as `layer` (index)
 * and `layerId`. Those groups are the artwork's own layer panel — one holds all
 * 1,004 parking-bay stripes, another all 509 trees, another every label — and
 * they are a far better classifier than any rule inferred from fill colour.
 *
 * Returns { i, layer, layerId, tag, attrs, curvy, opacity, clipped, subpaths }
 * with all transforms, the element's and its ancestors', already applied.
 */
export function readDrawing(svg, { circleSegments = 24 } = {}) {
  const out = [];
  const stack = [{ mat: [1, 0, 0, 1, 0, 0], opacity: 1, clipped: false }];
  const layers = [];
  let skip = 0;

  const re = new RegExp(
    `<(defs|clipPath|g|${DRAW_TAGS.join('|')})\\b([^>]*?)(/?)>|</(defs|clipPath|g)>`,
    'g',
  );

  for (const m of svg.matchAll(re)) {
    const [, tag, attrText, selfClose, closeTag] = m;

    if (closeTag) {
      if (closeTag === 'g') { if (!skip) stack.pop(); }
      else skip = Math.max(0, skip - 1);
      continue;
    }
    if (tag === 'defs' || tag === 'clipPath') { skip += 1; continue; }
    if (skip) continue;

    const attrs = {};
    for (const [, k, v] of attrText.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[k] = v;

    const parent = stack.at(-1);
    const mat = matMul(parent.mat, parseTransform(attrs.transform));
    const opacity = parent.opacity * (attrs.opacity === undefined ? 1 : +attrs.opacity);
    const clipped = parent.clipped || Boolean(attrs['clip-path']);

    if (tag === 'g') {
      // A self-closing <g/> opens nothing.
      if (selfClose) continue;
      // Depth 1 is a layer; anything deeper is a sub-group inside one and
      // inherits its layer.
      let layerId = parent.layerId ?? null;
      if (stack.length === 1) {
        layerId = attrs.id ?? `(anon ${layers.length})`;
        if (!layers.includes(layerId)) layers.push(layerId);
      }
      stack.push({ mat, opacity, clipped, layerId });
      continue;
    }

    let subpaths;
    if (tag === 'rect') {
      const x = +(attrs.x ?? 0), y = +(attrs.y ?? 0);
      const w = +(attrs.width ?? 0), h = +(attrs.height ?? 0);
      subpaths = [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], closed: true }];
    } else if (tag === 'polygon' || tag === 'polyline') {
      const v = nums(attrs.points);
      const pts = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
      // A <polygon> is closed by definition; a <polyline> is not, even when its
      // last point happens to land back on its first.
      if (tag === 'polygon' && pts.length
        && (pts[0][0] !== pts.at(-1)[0] || pts[0][1] !== pts.at(-1)[1])) pts.push(pts[0]);
      subpaths = [{ pts, closed: tag === 'polygon' }];
    } else if (tag === 'line') {
      subpaths = [{
        pts: [[+(attrs.x1 ?? 0), +(attrs.y1 ?? 0)], [+(attrs.x2 ?? 0), +(attrs.y2 ?? 0)]],
        closed: false,
      }];
    } else if (tag === 'circle' || tag === 'ellipse') {
      const cx = +(attrs.cx ?? 0), cy = +(attrs.cy ?? 0);
      const rx = +(attrs.r ?? attrs.rx ?? 0), ry = +(attrs.r ?? attrs.ry ?? 0);
      const pts = [];
      for (let i = 0; i <= circleSegments; i++) {
        const t = (i / circleSegments) * 2 * Math.PI;
        pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
      }
      subpaths = [{ pts, closed: true }];
    } else {
      subpaths = parseSubpaths(attrs.d ?? '');
    }

    subpaths = subpaths
      .filter((s) => s.pts.length >= 2)
      .map((s) => ({ pts: applyMat(mat, s.pts), closed: s.closed }));
    if (!subpaths.length) continue;

    out.push({
      i: out.length,
      layer: parent.layerId === undefined || parent.layerId === null
        ? -1
        : layers.indexOf(parent.layerId),
      layerId: parent.layerId ?? null,
      tag,
      attrs,
      curvy: tag === 'path' && CURVE_CMD.test(attrs.d ?? ''),
      opacity,
      clipped,
      subpaths,
    });
  }
  return out;
}

export function readCircles(svg) {
  const out = [];
  for (const [, tag, attrText] of svg.matchAll(/<(circle|ellipse)\b([^>]*)>/g)) {
    const attrs = {};
    for (const [, k, v] of attrText.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[k] = v;
    const rx = +(attrs.r ?? attrs.rx ?? 0);
    const ry = +(attrs.r ?? attrs.ry ?? 0);
    if (!rx || !ry) continue;
    const m = parseTransform(attrs.transform);
    const [centre] = applyMat(m, [[+(attrs.cx ?? 0), +(attrs.cy ?? 0)]]);
    out.push({ tag, attrs, centre, rx, ry });
  }
  return out;
}
