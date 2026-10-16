import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGraph } from './graph.js';
import { wireForm } from './wire.js';
import { createApp } from './app.js';
import { closeOnSignal } from './shutdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const distDir = path.join(root, 'dist');

const PORT = process.env.PORT || 8080;

const readJson = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));

// ---------------------------------------------------------------------------
// Boot-time graph construction. This is the entire reason routing lives on a
// server: the O(E) topology build is paid once at startup instead of on every
// visitor's phone.
//
// The graph itself is server/graph.js. Nothing but file reading and HTTP is
// left in here, which is what makes the router testable — see test/router.test.js.
// ---------------------------------------------------------------------------
const network = readJson('src/paths.json');

/**
 * The streets around the campus, so a walk can start outside it.
 *
 * Routed over, never drawn. `/api/network` (in server/app.js) still serves my
 * campus's own paths alone, because whichever provider is painting the ground
 * is already drawing these streets and putting ours on top of theirs is the
 * doubled linework at the campus edge that this pair of files exists to
 * avoid. The only thing a visitor ever sees from here is the route ribbon
 * lying along it.
 *
 * Unioned rather than merged into paths.json on purpose: that file is my campus's
 * printed linework and one script owns it. This one is OpenStreetMap's, owned by
 * scripts/build-approach-network.mjs, and the join between them is sixteen
 * gate connectors and four across the car parks, which that script prints on
 * every build.
 */
const approach = readJson('src/approach-paths.json');

/**
 * The ways across the sheet's paved plazas, written by the last stage of
 * scripts/build-walk-network.mjs. Routed, never drawn, like the streets: the
 * plaza is already on the map as paving, and a walk across it shows on the
 * route ribbon. Campus network for every rule in graph.js that asks.
 */
const plazas = readJson('src/plaza-paths.json');

/**
 * Where each building's drawn approach paths met its walls, so a room inside
 * resolves to the door its path led to rather than to whichever face of the
 * building a path happens to run past. Written by scripts/build-walk-network.mjs
 * with paths.json, from the same walls stage; see doorFor() in graph.js.
 */
const doors = readJson('src/doors.json');

/**
 * The line the streets were clipped at. A point inside it whose nearest edge
 * is a street on the other side is still offered the campus's own network;
 * see candidates() in graph.js.
 */
const boundary = readJson('src/campus-boundary.json');

/**
 * Every building's doors, from the directory, so a walk to a building can end
 * at whichever of its doors suits it, with the building's footprint, so
 * anywhere inside it is the same place as the building; and every footprint on
 * the sheet, so a way onto the network across open ground is never drawn
 * through one. Both files are also served as overlays below, from the same reads.
 */
const directory = readJson('src/directory.json');
const buildings = readJson('src/buildings.json');
const entrances = directory.features.filter((f) => f.properties.doors)
  .map((f) => ({ doors: f.properties.doors, footprint: f.geometry }));

const buildStart = Date.now();
const graph = createGraph({ network, approach, plazas, doors, boundary, entrances, buildings });

console.log(
  `[beavermaps] graph ready in ${Date.now() - buildStart}ms ` +
  `(${network.features.length} campus + ${plazas.features.length} plaza + ${approach.features.length} approach segments, ` +
  `${graph.vertices.length} vertices)`
);

/**
 * Everything the client draws but never routes over, extracted from my campus's own
 * basemap by the scripts/build-*.mjs passes. None of it goes into the graph;
 * these are served rather than bundled so ~2 MB of geometry stays out of the JS
 * and editing the data does not mean rebuilding the front-end.
 *
 * `basemap` is the whole printed sheet translated element for element — it is
 * what the client draws.
 *
 * `landcover` USED TO BE HERE and is not any more. It was the earlier partial
 * extraction the sheet replaced, kept on the list after nothing fetched it any
 * more — 320 KB read, parsed, gzipped and held resident at every boot to answer
 * a request that was never made. src/landcover.json and its generator stay; the
 * file is still the smaller seven-class extraction and scripts/build-labels.mjs
 * still reasons about it. It is just not an endpoint.
 *
 * Read once at boot, like the network — so like the network, changing a file
 * needs a restart.
 */
const OVERLAY_NAMES = ['buildings', 'basemap', 'amenities', 'places', 'labels', 'directory'];
const READ = { directory, buildings };
const OVERLAYS = Object.fromEntries(
  OVERLAY_NAMES.map((name) => [name, READ[name] ?? readJson(`src/${name}.json`)]),
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
  vertices: wireForm({ vertices: graph.vertices }),
  ...Object.fromEntries(Object.entries(OVERLAYS).map(([name, data]) => [name, wireForm(data)])),
};
console.log(
  `[beavermaps] wire forms ready in ${Date.now() - wireStart}ms (` +
  `${Math.round(Object.values(WIRE).reduce((n, w) => n + w.raw.length, 0) / 1024)} KB -> ` +
  `${Math.round(Object.values(WIRE).reduce((n, w) => n + w.gzip.length, 0) / 1024)} KB gzipped)`
);

// ---------------------------------------------------------------------------
// HTTP
//
// Every route, header and fallback is in server/app.js, which takes what was
// built above as arguments — so it can be tested without any of this, see
// test/app.test.js. What is left here is the part that only makes sense once:
// listening, and stopping.
// ---------------------------------------------------------------------------
const app = createApp({
  graph,
  wire: WIRE,
  overlayNames: OVERLAY_NAMES,
  distDir: existsSync(distDir) ? distDir : null,
});

/*
 * Express 5 hands a bind failure (EADDRINUSE, EACCES) to this callback rather
 * than throwing it. Ignoring the argument meant a port that was already taken
 * logged "listening" and then exited 0 once the event loop drained, so a
 * supervisor saw a clean stop and the log claimed success. Say what went
 * wrong and exit non-zero instead.
 *
 * The port in the log is the one actually bound, which differs from PORT when
 * PORT is 0.
 */
const server = app.listen(PORT, '0.0.0.0', (err) => {
  if (err) {
    console.error(`[beavermaps] could not listen on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`[beavermaps] listening on http://0.0.0.0:${server.address().port}`);
});

// SIGTERM is how Fly stops a machine, on every deploy and every scale-down;
// let what is in flight finish first. See server/shutdown.js.
closeOnSignal(server);
