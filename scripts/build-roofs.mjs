/**
 * Measure the roof of every pinned building from Google's 3D tiles.
 *
 * The campus directory already carries a `height` for each building and it is a
 * placeholder — 9 metres for twenty-eight of the thirty, 4 for the other two.
 * That number was never measured; it is what the extrusion layer needs to stand
 * a footprint up. This script replaces the guess with the photogrammetry: the
 * same Photorealistic 3D Tiles the flyover orbits, read as geometry rather than
 * drawn, and asked how high the roof over each footprint actually is.
 *
 * WHY THE TILES AND NOT AN ELEVATION SERVICE. Google's Elevation API answers
 * with the ground — it is a terrain model, and a terrain model has no buildings
 * in it. Mapbox's terrain is the same. The only source on hand that knows a
 * roof from the lawn beside it is the mesh, and this campus is covered by it at
 * a geometric error of 2.01 m, which is Google's finest level.
 *
 * HOW IT WORKS
 *
 *   1. Descend the tileset to the 2.01 m leaves, pruned to tiles that come near
 *      a building. The prune is what makes this affordable: the campus has
 *      about 1450 leaves, and only the ones over a footprint are worth a fetch.
 *   2. Every leaf is a glTF whose single node carries a matrix placing it in
 *      ECEF. There is no Draco to undo — Google decompresses for this endpoint,
 *      as its own `"generator":"draco_decoder"` says — so POSITION is plain
 *      float32 and the whole decode is a matrix multiply per vertex.
 *   3. Each vertex becomes a longitude, a latitude and an ellipsoidal height,
 *      and drops into a 3 m cell of a grid laid over the building. Each cell
 *      keeps only the highest and the lowest height that landed in it.
 *   4. The roof is the median of the cell HIGHS inside the footprint, the ground
 *      the median of the cell LOWS in the collar around it, and the height the
 *      difference.
 *
 * WHY A GRID AND NOT A PERCENTILE OVER THE VERTICES. This was the first version
 * and it reported the Health Education Complex as 0.6 m tall. A photogrammetry
 * mesh is dense where the geometry is complicated and sparse where it is
 * simple, so a large flat roof is a handful of big triangles while the eaves
 * below it — where the surface dives from roof to pavement in a couple of
 * metres — carry thousands of vertices. Counting vertices therefore counts
 * WALL, and the more roof a building has the worse the answer gets.
 *
 * The grid fixes it twice over. Cells weight by AREA rather than by vertex
 * density, so a plain roof counts for its size. And taking the highest sample
 * in each cell is what removes the wall entirely: a cell at the eaves holds
 * both the roof edge and the wall under it, and the roof edge is the higher of
 * the two. What is left is the top surface, sampled evenly.
 *
 * The MEDIAN of those, not the maximum, because a roof is not a plane — there
 * are stair cores, lift overruns, air handling, the occasional tree leaning
 * over a parapet. The median is the deck you would walk on; `peak_m` is kept
 * alongside it for whatever is standing up there.
 *
 * THE KEY IS REFERRER-RESTRICTED, which is the only protection a browser key
 * can have, so this has to present a referrer the way the browser would. Set
 * ROOF_REFERER if your key allows a different origin than the dev server.
 *
 * Billing: one root tileset request per run. Google's documentation is explicit
 * that tile requests and session tokens do not touch the quota, so the several
 * hundred megabytes this pulls cost nothing beyond that single event.
 *
 * Output src/roofs.json is committed. Re-run it when Google reflies the campus.
 *
 *   node scripts/build-roofs.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Ellipsoid } from '@math.gl/geospatial';
import { Matrix4, Vector3 } from '@math.gl/core';

const root = new URL('..', import.meta.url);
const KEY = /VITE_GOOGLE_MAPS_KEY=(\S+)/.exec(readFileSync(new URL('.env', root), 'utf8'))?.[1];
if (!KEY) throw new Error('VITE_GOOGLE_MAPS_KEY is not in .env');

const TILESET = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const REFERER = process.env.ROOF_REFERER ?? 'http://localhost:5173/';

/** Google's finest level over my campus. Anything above this is a coarser ancestor. */
const LEAF_GE = 2.5;
/**
 * The grid the roof is sampled on, in metres.
 *
 * A little over the tileset's own 2.01 m geometric error, so a cell is about
 * the smallest patch of roof the source can actually resolve. Finer would be
 * inventing detail and would leave cells on a plain roof with nothing in them;
 * coarser would start averaging a stair core into the deck beside it.
 */
const CELL_M = 3;
/**
 * How far inside the footprint a cell has to sit to count as roof, in metres.
 *
 * The traced outlines come off my campus's own basemap, not off the mesh, and the two
 * disagree by a metre or two in places. Without this, a footprint drawn a little
 * generously puts cells on the pavement beside the building and drags the roof
 * down toward the street.
 */
const INSET_M = 2.5;
/** How far outside a footprint still counts as that building's ground, metres. */
const COLLAR_M = 14;
/** Slack around a footprint when deciding whether a tile is worth fetching. */
const TILE_MARGIN_M = 30;
/** Concurrent tile fetches. Politeness, not a limit anyone imposed. */
const LANES = 8;

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 87_000; // at 38.65°N

// ---------------------------------------------------------------------------
// The buildings
// ---------------------------------------------------------------------------

const directory = JSON.parse(readFileSync(new URL('src/directory.json', root), 'utf8'));

/** Every outer ring of a MultiPolygon, flattened. Nothing here has holes. */
const ringsOf = (geometry) => geometry.coordinates.map((part) => part[0]);

function bboxOf(rings) {
  let w = 180; let s = 90; let e = -180; let n = -90;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
}

/** Crossing number, per ring. A point in any part is in the building. */
function inRings(rings, lon, lat) {
  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat)
        && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

const grow = ([w, s, e, n], m) => [
  w - m / M_PER_DEG_LON, s - m / M_PER_DEG_LAT,
  e + m / M_PER_DEG_LON, n + m / M_PER_DEG_LAT,
];

const buildings = directory.features
  .filter((f) => f.properties?.name)
  .map((f) => {
    const rings = ringsOf(f.geometry);
    const bbox = bboxOf(rings);
    return {
      name: f.properties.name,
      area_m2: f.properties.area_m2,
      rings,
      bbox,
      collar: grow(bbox, COLLAR_M),
      reach: grow(bbox, TILE_MARGIN_M),
      // Every 3 m cell that anything landed in, as `iy * 1e5 + ix` to the
      // highest and lowest height seen there.
      cells: new Map(),
      // The middle of the footprint, which is what the flyover centres on too —
      // not the anchor, which is the point furthest inside rather than the
      // middle. See footprintExtent in src/flyover.js.
      centre: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

console.log(`${buildings.length} pinned buildings to measure`);

// The one sphere the whole campus fits in, for the coarse half of the descent
// where a tile is kilometres wide and no per-building test would reject it.
const all = bboxOf(buildings.flatMap((b) => b.rings));
const CAMPUS_CENTRE = Ellipsoid.WGS84.cartographicToCartesian(
  [(all[0] + all[2]) / 2, (all[1] + all[3]) / 2, 0], new Vector3(),
);
const CAMPUS_RADIUS = Ellipsoid.WGS84
  .cartographicToCartesian([all[0], all[1], 200], new Vector3())
  .distance(CAMPUS_CENTRE) + 200;

// ---------------------------------------------------------------------------
// The tileset
// ---------------------------------------------------------------------------

let session = '';
let jsonFetches = 0;
let tileFetches = 0;
let tileBytes = 0;

async function get(href, asJson) {
  const url = new URL(href, TILESET);
  if (!url.searchParams.has('key')) url.searchParams.set('key', KEY);
  if (session && !url.searchParams.has('session')) url.searchParams.set('session', session);
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers: { Referer: REFERER } });
    if (response.ok) {
      if (asJson) { jsonFetches += 1; return response.json(); }
      const body = Buffer.from(await response.arrayBuffer());
      tileFetches += 1;
      tileBytes += body.length;
      return body;
    }
    if (response.status === 403) {
      throw new Error(`403 from Google. The key is referrer-restricted; this sent `
        + `"${REFERER}". Set ROOF_REFERER to an origin the key allows.`);
    }
    if (response.status < 500 || attempt === 4) {
      throw new Error(`${response.status} on ${url.pathname}`);
    }
    await new Promise((r) => { setTimeout(r, 800 * attempt); });
  }
}

/**
 * The closest point of an oriented bounding box to a point, in ECEF.
 *
 * Tested in ECEF rather than in longitude and latitude, and it has to be: the
 * root of this tileset is a cube centred on the Earth's core with half-axes of
 * 7645 km, and the geodetic bounding box of its eight corners does not contain
 * California. An oriented box only means anything in the space it was written
 * in.
 */
function boxDistance(box, transform, to) {
  let centre = new Vector3(box[0], box[1], box[2]);
  let axes = [
    new Vector3(box[3], box[4], box[5]),
    new Vector3(box[6], box[7], box[8]),
    new Vector3(box[9], box[10], box[11]),
  ];
  if (transform) {
    centre = transform.transformAsPoint(centre, new Vector3());
    axes = axes.map((a) => transform.transformAsVector(a, new Vector3()));
  }
  const offset = to.clone().subtract(centre);
  const closest = centre.clone();
  for (const axis of axes) {
    const length = axis.len();
    if (length < 1e-9) continue;
    const unit = axis.clone().scale(1 / length);
    closest.add(unit.scale(Math.max(-length, Math.min(length, offset.dot(unit)))));
  }
  return closest.distance(to);
}

function reaches(volume, transform, centre, radius) {
  if (volume.box) return boxDistance(volume.box, transform, centre) <= radius;
  if (volume.sphere) {
    const c = new Vector3(volume.sphere[0], volume.sphere[1], volume.sphere[2]);
    if (transform) transform.transformAsPoint(c, c);
    return c.distance(centre) <= volume.sphere[3] + radius;
  }
  return true; // a volume shape we cannot read is kept rather than lost
}

/** Each building as an ECEF sphere, so a fine tile can be rejected outright. */
const spheres = buildings.map((b) => {
  const [w, s, e, n] = b.reach;
  const centre = Ellipsoid.WGS84.cartographicToCartesian(
    [(w + e) / 2, (s + n) / 2, 0], new Vector3(),
  );
  const radius = Ellipsoid.WGS84
    .cartographicToCartesian([w, s, 120], new Vector3()).distance(centre);
  return { centre, radius };
});

const leaves = [];
const seen = new Set();

async function descend(node, inherited, base) {
  let transform = inherited;
  if (node.transform) {
    const own = new Matrix4(node.transform);
    transform = inherited ? inherited.clone().multiplyRight(own) : own;
  }
  if (!reaches(node.boundingVolume, transform, CAMPUS_CENTRE, CAMPUS_RADIUS)) return;
  // Below the campus, the tiles are small enough that the per-building test
  // actually rejects things — which is the whole saving.
  const fine = node.geometricError < 200;
  if (fine && !spheres.some((s) => reaches(node.boundingVolume, transform, s.centre, s.radius))) {
    return;
  }

  const uri = node.content?.uri;
  const url = uri ? new URL(uri, base) : null;
  const isTileset = url?.pathname.endsWith('.json');
  const leaf = node.geometricError <= LEAF_GE;

  if (url && !isTileset && (leaf || !node.children?.length)) {
    if (!seen.has(url.pathname)) {
      seen.add(url.pathname);
      leaves.push({ href: url.href, transform });
    }
    if (leaf) return;
  }
  if (isTileset) {
    const sub = await get(url.href, true);
    if (!session) session = url.searchParams.get('session') ?? '';
    await descend(sub.root, transform, url.href);
    return;
  }
  for (const child of node.children ?? []) await descend(child, transform, base);
}

// ---------------------------------------------------------------------------
// The geometry
// ---------------------------------------------------------------------------

/**
 * glTF is Y-up; 3D Tiles is Z-up. This is the rotation between them.
 *
 * Not optional and not subtle when it is missing: without it the campus lands
 * at 123.22°E, 42.16°N, which is Jilin province, because the tile's own node
 * matrix carries an ECEF translation whose axes are then read in the wrong
 * order. Column-major, like glTF's own matrices, and it maps (x, y, z) to
 * (x, -z, y). The 3D Tiles specification requires every renderer to apply it
 * between the tile transform and the glTF; loaders.gl does it for the app, and
 * this file has to do it for itself.
 */
const Y_UP_TO_Z_UP = new Matrix4([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);

/** Every POSITION in a .glb, placed in ECEF. */
function* positionsOf(glb, tileTransform) {
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb');
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
  // The BIN chunk follows the JSON chunk, both padded to four bytes.
  let cursor = 20 + ((jsonLength + 3) & ~3);
  let bin = null;
  while (cursor + 8 <= glb.length) {
    const length = glb.readUInt32LE(cursor);
    const type = glb.readUInt32LE(cursor + 4);
    if (type === 0x004e4942) { bin = glb.subarray(cursor + 8, cursor + 8 + length); break; }
    cursor += 8 + ((length + 3) & ~3);
  }
  if (!bin) return;

  const point = new Vector3();
  const base = tileTransform
    ? tileTransform.clone().multiplyRight(Y_UP_TO_Z_UP)
    : Y_UP_TO_Z_UP;
  const stack = (gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []).map((index) => [index, base]);
  while (stack.length) {
    const [index, parent] = stack.pop();
    const node = gltf.nodes[index];
    let world = parent;
    if (node.matrix) {
      const own = new Matrix4(node.matrix);
      world = parent ? parent.clone().multiplyRight(own) : own;
    }
    for (const child of node.children ?? []) stack.push([child, world]);
    for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
      const accessor = gltf.accessors[primitive.attributes?.POSITION];
      if (!accessor || accessor.componentType !== 5126 || accessor.type !== 'VEC3') continue;
      const view = gltf.bufferViews[accessor.bufferView];
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const stride = (view.byteStride ?? 12) / 4;
      const floats = new Float32Array(
        bin.buffer, bin.byteOffset + start, accessor.count * stride,
      );
      for (let i = 0; i < accessor.count; i += 1) {
        point.set(floats[i * stride], floats[i * stride + 1], floats[i * stride + 2]);
        if (world) world.transformAsPoint(point, point);
        yield point;
      }
    }
  }
}

const cartographic = new Vector3();
const CELL_LON = CELL_M / M_PER_DEG_LON;
const CELL_LAT = CELL_M / M_PER_DEG_LAT;

function absorb(glb, tileTransform) {
  for (const ecef of positionsOf(glb, tileTransform)) {
    Ellipsoid.WGS84.cartesianToCartographic(ecef, cartographic);
    const [lon, lat, height] = cartographic;
    for (const b of buildings) {
      const [cw, cs, ce, cn] = b.collar;
      if (lon < cw || lon > ce || lat < cs || lat > cn) continue;
      const ix = Math.floor((lon - cw) / CELL_LON);
      const iy = Math.floor((lat - cs) / CELL_LAT);
      const key = iy * 100_000 + ix;
      const cell = b.cells.get(key);
      if (!cell) b.cells.set(key, { hi: height, lo: height });
      else if (height > cell.hi) cell.hi = height;
      else if (height < cell.lo) cell.lo = height;
    }
  }
}

/** Is this point inside the footprint, and not within INSET_M of its edge? */
function wellInside(b, lon, lat) {
  if (!inRings(b.rings, lon, lat)) return false;
  const dLon = INSET_M / M_PER_DEG_LON;
  const dLat = INSET_M / M_PER_DEG_LAT;
  return inRings(b.rings, lon - dLon, lat) && inRings(b.rings, lon + dLon, lat)
    && inRings(b.rings, lon, lat - dLat) && inRings(b.rings, lon, lat + dLat);
}

/** Split a building's cells into the roof over it and the ground around it. */
function sortCells(b) {
  const roof = [];
  const ground = [];
  const [cw, cs] = b.collar;
  for (const [key, cell] of b.cells) {
    const ix = ((key % 100_000) + 100_000) % 100_000;
    const iy = Math.round((key - ix) / 100_000);
    const lon = cw + (ix + 0.5) * CELL_LON;
    const lat = cs + (iy + 0.5) * CELL_LAT;
    if (wellInside(b, lon, lat)) roof.push(cell.hi);
    else if (!inRings(b.rings, lon, lat)) ground.push(cell.lo);
  }
  return [roof.sort((x, y) => x - y), ground.sort((x, y) => x - y)];
}

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// ---------------------------------------------------------------------------

console.log('descending the tileset…');
const tileset = await get(TILESET, true);
session = new URL(JSON.stringify(tileset).match(/"uri":"([^"]*session=[^"]*)"/)?.[1] ?? TILESET, TILESET)
  .searchParams.get('session') ?? '';
await descend(tileset.root, null, TILESET);
console.log(`${leaves.length} leaf tiles over the buildings (${jsonFetches} subtree fetches)`);

let done = 0;
await Promise.all(Array.from({ length: LANES }, async () => {
  for (;;) {
    const leaf = leaves[done];
    if (!leaf) return;
    done += 1;
    const mine = done;
    absorb(await get(leaf.href, false), leaf.transform);
    if (mine % 50 === 0) process.stdout.write(`  ${mine}/${leaves.length}\r`);
  }
}));
console.log(`read ${tileFetches} tiles, ${(tileBytes / 1048576).toFixed(0)} MB`);

const rows = buildings.map((b) => {
  const [roofs, ground] = sortCells(b);
  const roof = percentile(roofs, 0.5);
  const base = percentile(ground, 0.5);
  return {
    name: b.name,
    area_m2: b.area_m2,
    centre: roof === null ? null
      : [+b.centre[0].toFixed(7), +b.centre[1].toFixed(7), +roof.toFixed(1)],
    roof_m: roof === null ? null : +roof.toFixed(1),
    ground_m: base === null ? null : +base.toFixed(1),
    height_m: roof === null || base === null ? null : +(roof - base).toFixed(1),
    peak_m: roofs.length ? +percentile(roofs, 1).toFixed(1) : null,
    cells: roofs.length,
  };
});

writeFileSync(new URL('src/roofs.json', root), `${JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  source: 'Google Photorealistic 3D Tiles, geometric error 2.01 m',
  datum: 'metres above the WGS84 ellipsoid',
  note: 'centre is [longitude, latitude, roof_m]. roof_m is the median of the '
    + 'highest mesh sample in each 3 m cell inside the footprint, inset 2.5 m from '
    + 'its edge; ground_m is the median of the lowest sample per cell in the 14 m '
    + 'collar outside it; height_m is the difference. peak_m is the tallest cell, '
    + 'so it holds stair cores, aerials and overhanging trees. cells is how many '
    + 'cells the roof figure rests on. See scripts/build-roofs.mjs.',
  buildings: rows,
}, null, 1)}\n`);

const w = Math.max(...rows.map((r) => r.name.length));
console.log(`\n${"building".padEnd(w)}   roof  ground  height    peak   cells`);
for (const r of rows) {
  console.log(`${r.name.padEnd(w)} ${String(r.roof_m).padStart(6)} `
    + `${String(r.ground_m).padStart(7)} ${String(r.height_m).padStart(7)} `
    + `${String(r.peak_m).padStart(7)} ${String(r.cells).padStart(7)}`);
}
console.log('\nwrote src/roofs.json');
