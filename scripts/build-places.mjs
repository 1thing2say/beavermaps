/**
 * Turn my campus's destination table into positioned places.
 *
 * locations.json is the directory their app searches: 120 rows, each bound to
 * routing nodes through LocationNodes. Because the binding is to nodes we
 * already project, every row that has one is georeferenced for free — this
 * script introduces no new alignment of its own, and inherits whatever
 * scripts/projection.mjs gives the graph.
 *
 * Two shapes of row, separated by how far their nodes are spread:
 *
 *   A place has nodes clustered on one building, and gets one feature at their
 *   mean. Even the loosest — Stadium at 210 m across two entrances — still
 *   describes a single thing.
 *
 *   A class has nodes scattered over the whole campus: Emergency telephones at
 *   666 m, Para Transit 410, Drink Vending Machine 403, Defibrillator 390, All
 *   Gender Restroom 357, Food Vending Machine 354. Averaging those puts a pin
 *   in the middle of the campus where there is nothing, so each node becomes
 *   its own feature instead.
 *
 * SPREAD_M sits in the gap between the two, which is wide and empty: 210 m to
 * 354 m with nothing in between. It is not a tuned parameter.
 *
 * 14 of the 120 rows have no nodes at all — bus stops, the street names, a few
 * divisions with no room assigned. They are kept with a null geometry rather
 * than dropped, so the file is still the whole directory and a search index can
 * be built from it; anything drawing this must skip them.
 *
 * Overlap with src/amenities.json is deliberate and not duplication: this is
 * the searchable directory, that is the symbol layer, and `kind` here marks
 * which rows are the ones drawn there so a renderer can suppress them.
 *
 * Source lives under campus-data/, which is gitignored — see
 * campus-data/MANIFEST.md. Output src/places.json is committed.
 *
 *   node scripts/build-places.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from './projection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'campus-data/wayfind/api/Batch.json');
const TARGET = path.join(root, 'src/places.json');

/** Above this spread a row is a class of thing, not a place. See header. */
const SPREAD_M = 250;

const { value } = JSON.parse(readFileSync(SOURCE, 'utf8'));

// Soft-deleted rows are inactive rather than absent, and node positions are
// the projection and nothing else.
const nodes = new Map();
for (const node of value.Nodes) {
  if (!node.Is_Active) continue;
  nodes.set(node.ID, project([node.Pos_X, node.Pos_Y]));
}

const metres = ([aLon, aLat], [bLon, bLat]) => Math.hypot(
  (aLon - bLon) * 111320 * Math.cos((aLat * Math.PI) / 180),
  (aLat - bLat) * 111320,
);

const round = ([lon, lat]) => [Number(lon.toFixed(7)), Number(lat.toFixed(7))];

const features = [];
let placed = 0;
let exploded = 0;
let unpositioned = 0;

for (const location of [...value.Locations].sort((a, b) => a.Name.localeCompare(b.Name))) {
  const points = location.Node_IDs.map((id) => nodes.get(id)).filter(Boolean);
  const base = {
    name: location.Name,
    description: location.Description || null,
    nodeIds: location.Node_IDs,
    sortPriority: Number(location.SortPriority),
  };

  if (!points.length) {
    unpositioned += 1;
    features.push({ type: 'Feature', properties: { ...base, kind: 'unpositioned' }, geometry: null });
    continue;
  }

  let spread = 0;
  for (const a of points) for (const b of points) spread = Math.max(spread, metres(a, b));

  if (spread > SPREAD_M) {
    exploded += 1;
    for (const p of points) {
      features.push({
        type: 'Feature',
        properties: { ...base, kind: 'amenity_class' },
        geometry: { type: 'Point', coordinates: round(p) },
      });
    }
    continue;
  }

  placed += 1;
  const mean = [
    points.reduce((s, p) => s + p[0], 0) / points.length,
    points.reduce((s, p) => s + p[1], 0) / points.length,
  ];
  features.push({
    type: 'Feature',
    properties: { ...base, kind: 'place', spread_m: Math.round(spread) },
    geometry: { type: 'Point', coordinates: round(mean) },
  });
}

writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const described = features.filter((f) => f.properties.description).length;
console.log(`[build-places] ${value.Locations.length} rows -> ${features.length} features -> src/places.json`);
console.log(`[build-places] ${placed} places, ${exploded} classes exploded per node, ${unpositioned} without nodes`);
console.log(`[build-places] ${described} carry a description`);
