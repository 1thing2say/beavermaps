// Shared loading and geometry checks for the data tests.
//
// Everything under test is a committed artifact in src/. Their generators read
// campus-data/, which is gitignored third-party content, so the scripts are not
// runnable from a bare clone — but their output is, which is what actually ships
// and what these tests are about.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function load(name) {
  return JSON.parse(readFileSync(path.join(root, 'src', `${name}.json`), 'utf8'));
}

/**
 * Generous bounds around my campus. Anything outside is a projection failure, and
 * projection failures on this project have historically been large — an early
 * transform came out 110 m off — so this only has to catch the big ones.
 */
export const CAMPUS = { west: -121.36, east: -121.34, south: 38.640, north: 38.660 };

export function eachPosition(geometry, visit) {
  const walk = (node, depth) => {
    if (depth === 0) return visit(node);
    for (const child of node) walk(child, depth - 1);
  };
  const depth = {
    Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3,
  }[geometry.type];
  if (depth === undefined) throw new Error(`unhandled geometry ${geometry.type}`);
  walk(geometry.coordinates, depth);
}

/** Every polygon of a feature, whether it is a Polygon or a MultiPolygon. */
export function polygonsOf(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/** Signed area in squared degrees. Positive is counter-clockwise. */
export function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
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

const METRES_PER_DEGREE_LAT = 111320;
const COS_LAT = Math.cos((38.6547 * Math.PI) / 180);

/** Shoelace area of a lon/lat ring, in square metres. */
export const ringAreaM2 = (ring) =>
  Math.abs(signedArea(ring)) * METRES_PER_DEGREE_LAT ** 2 * COS_LAT;

export function metresBetween([lon1, lat1], [lon2, lat2]) {
  const dx = (lon2 - lon1) * METRES_PER_DEGREE_LAT * COS_LAT;
  const dy = (lat2 - lat1) * METRES_PER_DEGREE_LAT;
  return Math.hypot(dx, dy);
}

/**
 * The routing graph's vertex set, keyed exactly the way server/index.js keys it.
 * paths.json is written at 7 decimals and shared endpoints are projected once,
 * so identical nodes are identical strings — no rounding needed here, and if
 * that ever stops being true these tests are where it should surface.
 */
export const vertexKey = (coord) => `${coord[0]},${coord[1]}`;

// --- colour ----------------------------------------------------------------
// Shared because two suites now argue about colour and they have to argue in
// the same units: pin-select.test.js checks that no two marker hues collide,
// skin.test.js checks that a look overrides everything it claims to and that
// every label survives the surface it lands on.

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const linear = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);

/** CIE-Lab, so "how different do these look" is a number rather than an opinion. */
export function lab(hex) {
  const [r, g, b] = channels(hex).map(linear);
  const xyz = [
    (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047,
    r * 0.2126 + g * 0.7152 + b * 0.0722,
    (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883,
  ].map((t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

export const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

/** Lab in polar form: lightness, chroma, hue angle. Chroma is the saturation. */
export function lch(hex) {
  const [L, a, b] = lab(hex);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

export const relLuminance = (hex) => {
  const [r, g, b] = channels(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrast = (a, b) => {
  const [lo, hi] = [relLuminance(a), relLuminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
};

export const toHex = (rgb) =>
  `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** `over` composited onto `under` at `alpha`, both as hex. */
export const flatten = (over, under, alpha) =>
  toHex(channels(over).map((v, i) => alpha * v + (1 - alpha) * channels(under)[i]));
