import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { createGraph } from './graph.js';
import { createRateLimit } from './limit.js';
import { wireForm, sendWire, compressedStatic } from './wire.js';

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
 * Routed over, never drawn. `/api/network` below still serves my campus's own paths
 * alone, because whichever provider is painting the ground is already drawing
 * these streets and putting ours on top of theirs is the doubled linework at the
 * campus edge that this pair of files exists to avoid. The only thing a visitor
 * ever sees from here is the route ribbon lying along it.
 *
 * Unioned rather than merged into paths.json on purpose: that file is my campus's
 * printed linework and one script owns it. This one is OpenStreetMap's, owned by
 * scripts/build-approach-network.mjs, and the join between them is fifteen
 * connectors that script prints on every build.
 */
const approach = readJson('src/approach-paths.json');

const buildStart = Date.now();
const graph = createGraph({ network, approach });

console.log(
  `[beavermaps] graph ready in ${Date.now() - buildStart}ms ` +
  `(${network.features.length} campus + ${approach.features.length} approach segments, ` +
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
const OVERLAYS = Object.fromEntries(
  OVERLAY_NAMES.map((name) => [name, readJson(`src/${name}.json`)]),
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
// ---------------------------------------------------------------------------
const app = express();

// Nothing here is served faster for having announced which framework served it.
app.disable('x-powered-by');

/**
 * Behind Fly's edge, so the client address arrives in X-Forwarded-For.
 *
 * ONE HOP, not `true`. `trust proxy: true` tells Express to believe the
 * left-most entry of a header the client itself can write, which turns the rate
 * limiter below into a header field anybody can rotate. One hop means "trust the
 * proxy immediately in front of me and nothing further out", which is exactly
 * the deployment in fly.toml. Run this without a proxy and req.ip is the socket
 * address, which is also correct.
 */
app.set('trust proxy', 1);

/**
 * The headers a static site and a JSON API both want, and neither had.
 *
 * `nosniff` is the load-bearing one: without it a browser is free to decide for
 * itself that a response is HTML whatever the Content-Type said, and every
 * payload here is attacker-influenced in the trivial sense that a place name
 * comes out of a data file. The frame and referrer lines are cheap and there is
 * no case where this map wants to be in somebody else's iframe or to name the
 * page a visitor came from to a third party.
 */
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// A route request is two coordinates. The default 100 KB is three orders of
// magnitude more room than that, and the parse is the one piece of work here
// that happens before any of our own code can decline it.
app.use(express.json({ limit: '4kb' }));

function parseCoord(value) {
  const pair = Array.isArray(value) ? value : String(value ?? '').split(',');
  if (pair.length !== 2) return null;
  const lon = Number(pair[0]);
  const lat = Number(pair[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return [lon, lat];
}

const takeRoute = createRateLimit();

function route(req, res) {
  const quota = takeRoute(req.ip ?? 'unknown');
  res.set('RateLimit-Limit', String(quota.limit));
  res.set('RateLimit-Remaining', String(quota.remaining));
  if (!quota.allowed) {
    res.set('Retry-After', String(quota.retryAfterSeconds));
    return res.status(429).json({ error: 'too many route requests — try again shortly' });
  }

  const source = req.method === 'POST' ? req.body : req.query;
  const from = parseCoord(source?.from);
  const to = parseCoord(source?.to);

  if (!from || !to) {
    return res.status(400).json({
      error: 'from and to are required as [lon, lat] (note: longitude first)',
    });
  }

  const result = graph.route(from, to);

  // 422 rather than 404, and the two are not interchangeable. A 404 means the
  // graph was asked a sensible question and has no answer — both ends are on it
  // and nothing joins them. A 422 means the question itself was not answerable:
  // the coordinate is nowhere near anything this server knows how to walk on.
  // The client tells them apart to decide what to say, so the wire has to.
  if (!result.ok) {
    // 404 is "the graph does not join these two", which is a fact about the
    // network. 422 is "the request itself does not describe a walk", which is
    // a fact about what was asked — too far to snap, or both ends in the same
    // place. Only the second kind is worth putting in front of a person.
    const status = UNPROCESSABLE.has(result.reason) ? 422 : 404;
    return res.status(status).json({ error: result.error, reason: result.reason });
  }

  return res.json({
    geometry: result.geometry,
    distanceFeet: result.distanceFeet,
    maneuvers: result.maneuvers,
    snapped: result.snapped,
  });
}

/** Reasons that mean "well-formed, but not a walk" rather than "no such path". */
const UNPROCESSABLE = new Set(['unreachable', 'same-place']);

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
 * route will really begin.
 *
 * Pairs rather than a FeatureCollection because this is the one payload where
 * the framing costs more than the data: `{"type":"Feature","properties":{},…}`
 * around each of these is roughly six times the two numbers inside it.
 */
app.get('/api/vertices', (req, res) => sendWire(req, res, WIRE.vertices));

for (const name of OVERLAY_NAMES) {
  app.get(`/api/${name}`, (req, res) => sendWire(req, res, WIRE[name]));
}

app.get('/healthz', (_req, res) => res.json({ ok: true, vertices: graph.vertices.length }));

/**
 * An unknown /api path is a 404, and says so in the language the caller asked in.
 *
 * BEFORE the SPA fallback, which is the whole point. Without this, every
 * misspelled endpoint fell through to `index.html` and came back 200 with 59 KB
 * of markup — so `fetchOverlay('buidlings')` passed its `response.ok` check and
 * then died inside `response.json()` with a parse error naming a position in a
 * document the caller never asked for. A 404 is four lines and turns that into
 * the sentence it always was.
 */
app.use('/api', (req, res) => {
  res.status(404).json({ error: `no such endpoint: ${req.method} /api${req.path}` });
});

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
  //
  // GET AND HEAD ONLY. A single-page app serves its shell in place of a path it
  // does not recognise because the router in the browser will recognise it; that
  // argument is about navigation and navigation is a GET. Answering `DELETE
  // /anything` with 200 and the whole app said this server has a handler for
  // every verb at every path, which is both untrue and the sort of untrue that
  // makes a scanner's report longer than it needs to be.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    return res.sendFile(path.join(distDir, 'index.html'));
  });
  app.use((_req, res) => res.status(405).json({ error: 'method not allowed' }));
} else {
  console.log('[beavermaps] no dist/ found — API only. Run `npm run build` to serve the app.');
}

/**
 * Errors, as JSON.
 *
 * Express's default handler writes an HTML error page, which is the wrong
 * content type for every route above and — outside NODE_ENV=production — has
 * the stack trace and the absolute paths of this filesystem in it. The
 * Dockerfile does set NODE_ENV, so the leak was a development one; the wrong
 * content type was everywhere. A malformed JSON body is the way to reach this
 * in practice, and `err.status` is already 400 by the time body-parser is done
 * with it.
 *
 * Four parameters, because that arity is how Express recognises an error
 * handler. `next` is unused and cannot be dropped.
 */
app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? 'internal error' : (err.message ?? 'bad request'),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[beavermaps] listening on http://0.0.0.0:${PORT}`);
});
