/**
 * Regenerate src/paths.json from the archived my campus wayfinding graph.
 *
 * Their graph lives in the SVG coordinate space of their basemap, so every node
 * has to be projected into WGS84 before it means anything to Mapbox. That
 * projection lives in scripts/projection.mjs — read its header before changing
 * anything here, because my campus's own published constants are wrong by ~71 m.
 *
 * The source lives under campus-data/, which is gitignored — see
 * campus-data/MANIFEST.md. This script is therefore not runnable from a bare
 * clone, but src/paths.json (its output) is committed.
 *
 *   node scripts/build-paths.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from './projection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'campus-data/wayfind/api/Batch.json');
const TARGET = path.join(root, 'src/paths.json');
const CORRECTIONS = path.join(root, 'src/path-corrections.json');

const { value } = JSON.parse(readFileSync(SOURCE, 'utf8'));

/**
 * Per-node corrections from scripts/build-snap.mjs, if they have been solved.
 * The projection is as good as a global transform gets — what remains is my campus
 * having drawn individual paths several metres off, which only a per-path
 * correction can fix. Read that script's header before regenerating this.
 *
 * Keyed by my campus's node ID rather than by coordinate, so it survives a rebuild.
 */
const corrections = existsSync(CORRECTIONS)
  ? JSON.parse(readFileSync(CORRECTIONS, 'utf8')).corrections
  : {};

// Their editor soft-deletes by clearing Is_Active rather than removing rows.
const coords = new Map();
let corrected = 0;
for (const node of value.Nodes) {
  if (!node.Is_Active) continue;
  const [lon, lat] = project([node.Pos_X, node.Pos_Y]);
  const delta = corrections[node.ID];
  if (!delta) {
    coords.set(node.ID, [lon, lat]);
    continue;
  }
  corrected += 1;
  // Re-round after shifting: node positions are written once and shared by
  // every segment that meets there, so they must stay bit-identical or the
  // router sees two nodes where the campus has one.
  coords.set(node.ID, [
    Number((lon + delta[0]).toFixed(7)),
    Number((lat + delta[1]).toFixed(7)),
  ]);
}

// Every edge is stored twice, once from each end. Collapsing on a sorted key
// halves the feature count and stops each path being drawn on top of itself.
const edges = new Map();
for (const edge of value.Adjacencies) {
  if (!edge.Is_Active) continue;
  const { From_Node: from, To_Node: to } = edge;
  if (!coords.has(from) || !coords.has(to) || from === to) continue;
  const key = from < to ? `${from}-${to}` : `${to}-${from}`;
  if (!edges.has(key)) edges.set(key, [from, to]);
}

const features = [...edges.values()].map(([from, to]) => ({
  type: 'Feature',
  properties: { from, to },
  geometry: { type: 'LineString', coordinates: [coords.get(from), coords.get(to)] },
}));

writeFileSync(TARGET, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const lons = [...coords.values()].map((c) => c[0]);
const lats = [...coords.values()].map((c) => c[1]);
const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
const centre = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

console.log(`[build-paths] ${coords.size} nodes, ${features.length} segments -> src/paths.json`);
console.log(`[build-paths] ${corrected} nodes shifted by src/path-corrections.json`);
console.log(`[build-paths] bbox   ${bbox.map((n) => n.toFixed(6)).join(', ')}`);
console.log(`[build-paths] centre ${centre.map((n) => n.toFixed(6)).join(', ')}`);
