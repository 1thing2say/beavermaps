import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import pathFinderModule from 'geojson-path-finder';
import { point, featureCollection } from '@turf/helpers';
import { nearestPoint } from '@turf/nearest-point';
import { buildManeuvers, FEET_PER_KM } from '../src/maneuvers.js';
import { wireForm, sendWire, compressedStatic } from './wire.js';

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
 * The streets around the campus, so a walk can start outside it.
 *
 * Routed over, never drawn. `/api/network` below still serves my campus's own paths
 * alone, because whichever provider is painting the ground is already drawing
 * these streets and putting ours on top of theirs is the doubled linework at the
 * campus edge that this pair of files exists to avoid. The only thing a visitor
 * ever sees from here is the route ribbon lying along it.
 *
 * Unioned rather than merged into paths.json on purpose: that file is my campus's
 * printed linework and one script owns it. This one is OpenStreetMap's, owned by
 * scripts/build-approach-network.mjs, and the join between them is fifteen
 * connectors that script prints on every build. geojson-path-finder builds its
 * topology from coordinates rather than from feature identity, so concatenating
 * the two collections IS the merge — the gate connectors end on my campus's vertices
 * at the same seven decimals those vertices are written at, and weld there.
 */
const approach = JSON.parse(readFileSync(path.join(root, 'src/approach-paths.json'), 'utf8'));
const graph = {
  type: 'FeatureCollection',
  features: [...network.features, ...approach.features],
};

/**
 * Everything the client draws but never routes over, extracted from my campus's own
 * basemap by the scripts/build-*.mjs passes. None of it goes into the graph;
 * these are served rather than bundled so ~2 MB of geometry stays out of the JS
 * and editing the data does not mean rebuilding the front-end.
 *
 * `basemap` is the whole printed sheet translated element for element — it is
 * what the client draws. `landcover` is the earlier partial extraction it
 * replaces, still served because it is a smaller file that carries the same
 * seven ground classes.
 *
 * Read once at boot, like the network — so like the network, changing a file
 * needs a restart.
 */
const OVERLAYS = Object.fromEntries(
  ['buildings', 'basemap', 'landcover', 'amenities', 'places', 'labels', 'directory']
    .map((name) => [
      name,
      JSON.parse(readFileSync(path.join(root, `src/${name}.json`), 'utf8')),
    ]),
);

const buildStart = Date.now();
// The default vertex-snapping precision is 1e-5 degrees, and the closest pair of
// distinct campus nodes is 1.24e-5 apart — a 24% margin. Tightening it to 1e-7
// (~1cm, matching the precision paths.json is written at) keeps tight junctions
// like stair landings from being welded into a single vertex.
const pathFinder = new PathFinder(graph, { precision: 1e-7 });

// Every unique vertex, so incoming coordinates can be snapped onto the graph.
// findPath only accepts points that are actually nodes in the network.
const seen = new Set();
const vertices = [];
for (const feature of graph.features) {
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
  `(${network.features.length} campus + ${approach.features.length} approach segments, ` +
  `${vertices.length} vertices)`
);

// ---------------------------------------------------------------------------
// What goes on the wire
//
// GeoJSON is decimal digits and punctuation, which is close to the most
// compressible thing there is. The eight a cold load asks for were 1,988 KB
// uncompressed and are 246 KB gzipped; src/basemap.json alone goes 1,577 KB to
// 170. That was the single biggest cost in a cold load — measured in a
// throttled browser against these very files, the overlays took 1,838 ms at
// 8 Mbps before and 250 ms after.
//
// (The boot line below counts nine, not eight: /api/landcover is the older
// partial extraction the sheet replaced, still served and no longer fetched.)
//
// COMPRESSED ONCE, AT BOOT, rather than per request. Every one of these is
// already read once and held — see OVERLAYS — so they are constants, and a
// generic compression middleware would re-gzip 1.6 MB of unchanging basemap for
// every visitor. That is ~35 ms of server CPU per phone to produce a byte-wise
// identical answer each time. Paying it here costs a few hundred milliseconds
// of startup, once.
//
// /api/route is deliberately NOT here. It is the one response that cannot be
// precomputed, and it is about 4 KB — gzip takes it to 1 KB, which is three
// TCP segments saved on a request nobody is waiting 2 MB for. One mechanism,
// applied where the bytes actually are.
// ---------------------------------------------------------------------------

const wireStart = Date.now();
const WIRE = {
  network: wireForm(network),
  vertices: wireForm({ vertices }),
  ...Object.fromEntries(Object.entries(OVERLAYS).map(([name, data]) => [name, wireForm(data)])),
};
console.log(
  `[mapper] wire forms ready in ${Date.now() - wireStart}ms (` +
  `${Math.round(Object.values(WIRE).reduce((n, w) => n + w.raw.length, 0) / 1024)} KB -> ` +
  `${Math.round(Object.values(WIRE).reduce((n, w) => n + w.gzip.length, 0) / 1024)} KB gzipped)`
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
//
// my campus's paths only. The approach network is deliberately not here: it is routed
// over and never drawn. See the `approach` import above.
app.get('/api/network', (req, res) => sendWire(req, res, WIRE.network));

/**
 * Every vertex in the routing graph, campus and approach alike, as bare pairs.
 *
 * The client snaps a click to the nearest one so the marker lands on the graph
 * the instant you tap, rather than waiting a round trip to find out where the
 * route will really begin. Before the approach network existed it could do that
 * from /api/network, because the drawn network and the routed one were the same
 * thing; now they are not, and snapping to the drawn one would drag a start
 * point on the pavement outside up to 800 m onto the campus.
 *
 * Pairs rather than a FeatureCollection because this is the one payload where
 * the framing costs more than the data: `{"type":"Feature","properties":{},…}`
 * around each of these is roughly six times the two numbers inside it.
 */
app.get('/api/vertices', (req, res) => sendWire(req, res, WIRE.vertices));

for (const name of Object.keys(OVERLAYS)) {
  app.get(`/api/${name}`, (req, res) => sendWire(req, res, WIRE[name]));
}

app.get('/healthz', (_req, res) => res.json({ ok: true, vertices: vertices.length }));

// Serve the built front-end when it exists. In dev the Vite server handles
// this and proxies /api back here instead.
//
// Two layers, in this order. The first answers compressible files to clients
// that accept gzip and sets the cache policy — dist/ is 3,576 KB uncompressed
// and 993 KB gzipped, which is the same argument as the API payloads and the
// same size of saving. Everything it does not answer falls through to
// express.static, which keeps ranges, HEAD and the rest where they belong.
if (existsSync(distDir)) {
  app.use(compressedStatic(distDir));
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
