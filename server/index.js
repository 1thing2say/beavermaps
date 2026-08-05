import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import pathFinderModule from 'geojson-path-finder';
import { point, featureCollection } from '@turf/helpers';
import { nearestPoint } from '@turf/nearest-point';
import { buildManeuvers, FEET_PER_KM } from '../src/maneuvers.js';

// geojson-path-finder ships CommonJS with no "exports" map, so under bare Node
// the default import is the module namespace rather than the class itself.
// Vite's bundler papers over this; node does not.
const PathFinder = pathFinderModule.default ?? pathFinderModule;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const distDir = path.join(root, 'dist');

const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// Boot-time graph construction. This is the entire reason routing lives on a
// server: the O(E) topology build is paid once at startup instead of on every
// visitor's phone.
// ---------------------------------------------------------------------------
const network = JSON.parse(readFileSync(path.join(root, 'src/paths.json'), 'utf8'));

/**
 * Everything the client draws but never routes over, extracted from my campus's own
 * basemap by the scripts/build-*.mjs pair of passes. None of it goes into the
 * graph; these are served rather than bundled so ~370 kB of geometry stays out
 * of the JS and editing the data does not mean rebuilding the front-end.
 *
 * Read once at boot, like the network — so like the network, changing a file
 * needs a restart.
 */
const OVERLAYS = Object.fromEntries(
  ['buildings', 'landcover', 'amenities', 'places'].map((name) => [
    name,
    JSON.parse(readFileSync(path.join(root, `src/${name}.json`), 'utf8')),
  ]),
);

const buildStart = Date.now();
// The default vertex-snapping precision is 1e-5 degrees, and the closest pair of
// distinct campus nodes is 1.24e-5 apart — a 24% margin. Tightening it to 1e-7
// (~1cm, matching the precision paths.json is written at) keeps tight junctions
// like stair landings from being welded into a single vertex.
const pathFinder = new PathFinder(network, { precision: 1e-7 });

// Every unique vertex, so incoming coordinates can be snapped onto the graph.
// findPath only accepts points that are actually nodes in the network.
const seen = new Set();
const vertices = [];
for (const feature of network.features) {
  for (const coord of feature.geometry.coordinates) {
    const key = `${coord[0]},${coord[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      vertices.push(coord);
    }
  }
}
const networkPoints = featureCollection(vertices.map((v) => point(v)));

console.log(
  `[mapper] graph ready in ${Date.now() - buildStart}ms ` +
  `(${network.features.length} segments, ${vertices.length} vertices)`
);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

function parseCoord(value) {
  const pair = Array.isArray(value) ? value : String(value ?? '').split(',');
  if (pair.length !== 2) return null;
  const lon = Number(pair[0]);
  const lat = Number(pair[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return [lon, lat];
}

function route(req, res) {
  const source = req.method === 'POST' ? req.body : req.query;
  const from = parseCoord(source?.from);
  const to = parseCoord(source?.to);

  if (!from || !to) {
    return res.status(400).json({
      error: 'from and to are required as [lon, lat] (note: longitude first)',
    });
  }

  const start = nearestPoint(point(from), networkPoints);
  const end = nearestPoint(point(to), networkPoints);

  const result = pathFinder.findPath(start, end);
  if (!result) return res.status(404).json({ error: 'no path found on the network' });

  res.json({
    geometry: { type: 'LineString', coordinates: result.path },
    distanceFeet: Math.round(result.weight * FEET_PER_KM),
    maneuvers: buildManeuvers(result.path),
    snapped: {
      from: start.geometry.coordinates,
      to: end.geometry.coordinates,
    },
  });
}

app.get('/api/route', route);
app.post('/api/route', route);

// The client draws the path network but no longer bundles it — one copy, and
// editing paths.json no longer means rebuilding the front-end.
app.get('/api/network', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(network);
});

for (const [name, data] of Object.entries(OVERLAYS)) {
  app.get(`/api/${name}`, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  });
}

app.get('/healthz', (_req, res) => res.json({ ok: true, vertices: vertices.length }));

// Serve the built front-end when it exists. In dev the Vite server handles
// this and proxies /api back here instead.
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  // Fallback as middleware rather than app.get('*') — Express 5 no longer
  // accepts a bare wildcard path.
  app.use((_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  console.log('[mapper] no dist/ found — API only. Run `npm run build` to serve the app.');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[mapper] listening on http://0.0.0.0:${PORT}`);
});
