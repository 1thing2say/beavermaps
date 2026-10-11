// The HTTP half of the server: every route, header and fallback, and nothing
// that reads a file at boot.
//
// Split out of server/index.js for the reason graph.js was: index.js built the
// graph at module scope and called listen() on the way past, so nothing about
// how a request is answered — which bucket it counts against, what a malformed
// coordinate gets back, whether `/` goes out compressed — could be asked
// without booting the whole thing on a real port. Here the graph, the wire
// forms and dist/ are arguments, and test/app.test.js stands this up on a stub
// graph and a scratch dist/ in a few milliseconds.

import path from 'node:path';
import express from 'express';
import { createRateLimit, clientKey } from './limit.js';
import { sendWire, compressedStatic } from './wire.js';
import { securityHeaders } from './headers.js';

/** Reasons that mean "well-formed, but not a walk" rather than "no such path". */
const UNPROCESSABLE = new Set(['unreachable', 'same-place']);

/**
 * One end of a route request, as `[lon, lat]`, or null for anything else.
 *
 * STRICT ABOUT TYPES, because the body is JSON and the query string is qs, and
 * between them a caller can hand this any shape at all. It used to be
 * `String(value)` and `Number(...)` over whatever arrived, which accepted far
 * too much — `[[1], 2]` is `[1, 2]` to Number(), and so is `[true, 2]` — and
 * threw on the one shape String() cannot convert: `{"toString": 1}` came back
 * as a 500 with a stack trace in the log, once per request, for anybody who
 * cared to send it. A client error is a 400 and costs a log nothing.
 *
 * So: a string `"lon,lat"`, or an array of exactly two parts, each of them a
 * number or a numeric string. A blank part is not zero — Number('') is, and
 * `from=,` was being routed from the Gulf of Guinea.
 */
export function parseCoord(value) {
  let pair;
  if (typeof value === 'string') pair = value.split(',');
  else if (Array.isArray(value)) pair = value;
  else return null;
  if (pair.length !== 2) return null;

  const parts = pair.map((part) => {
    if (typeof part === 'number') return part;
    if (typeof part === 'string' && part.trim() !== '') return Number(part);
    return NaN;
  });
  const [lon, lat] = parts;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return [lon, lat];
}

/**
 * Build the app. Nothing here listens; server/index.js does that.
 *
 * - `graph`        — what createGraph returns; `route` and `vertices` are used.
 * - `wire`         — the precompressed payloads, by name (see WIRE in index.js).
 * - `overlayNames` — which of `wire` are served at /api/<name>.
 * - `distDir`      — the built front-end, or null to serve the API alone.
 * - `env`          — read for FLY_APP_NAME; see clientKey in limit.js.
 * - `takeRoute`    — the route limiter, injectable so a test can use a small one.
 * - `log`          — where the one-off lines below go.
 */
export function createApp({
  graph,
  wire,
  overlayNames = [],
  distDir = null,
  env = process.env,
  takeRoute = createRateLimit(),
  log = console.log,
}) {
  const app = express();

  // Nothing here is served faster for having announced which framework served it.
  app.disable('x-powered-by');

  /**
   * Behind Fly's edge, so the forwarding headers arrive from fly-proxy.
   *
   * ONE HOP, not `true`. `trust proxy: true` tells Express to believe the
   * left-most entry of a header the client itself can write. One hop means
   * "trust the proxy immediately in front of me and nothing further out".
   * The price is that with NO proxy in front — `npm run dev`, the tests — the
   * socket peer is itself taken for that hop, so a client talking straight to
   * this server sets `req.ip` and `req.secure` from headers it wrote. That is
   * harmless on a laptop, and it means the rate limit off Fly is a courtesy
   * rather than a defence (see clientKey in limit.js); on Fly the hop really is
   * fly-proxy, and HSTS over a spoofed X-Forwarded-Proto is ignored by a
   * browser that reached the server over plain HTTP anyway.
   *
   * WHAT THIS IS FOR ON FLY is `req.secure` — X-Forwarded-Proto through that
   * one hop, which is what decides whether HSTS goes out (see headers.js). It
   * is NOT what the rate limiter keys on there: with one trusted hop `req.ip`
   * is the right-most X-Forwarded-For entry, which behind fly-proxy is the same
   * Fly-side address for every visitor. That is clientKey's problem, in
   * limit.js, and it reads Fly-Client-IP instead.
   */
  app.set('trust proxy', 1);

  // X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  // Permissions-Policy, a Report-Only CSP and, over HTTPS, HSTS. The reasons
  // for each are with them in headers.js.
  app.use(securityHeaders({ distDir }));

  // A route request is two coordinates. The default 100 KB is three orders of
  // magnitude more room than that, and the parse is the one piece of work here
  // that happens before any of our own code can decline it.
  app.use(express.json({ limit: '4kb' }));

  /**
   * What the limiter will be keying on, said once per process and without the
   * addresses themselves: whether Fly-Client-IP arrived, how many hops
   * X-Forwarded-For had, and whether req.ip agrees with Fly-Client-IP. The
   * first route request after a deploy is the first time anybody finds out
   * whether clientKey's reading of Fly's headers is right, and this line is
   * what answers it from `fly logs` without printing a visitor's IP there.
   */
  let shapeLogged = false;
  function logClientShape(req) {
    if (shapeLogged) return;
    shapeLogged = true;
    const fly = req.get('fly-client-ip');
    const hops = (req.get('x-forwarded-for') ?? '').split(',').filter((s) => s.trim()).length;
    log(
      `[beavermaps] first route request: Fly-Client-IP ${fly ? 'present' : 'absent'}, ` +
      `X-Forwarded-For ${hops} hop${hops === 1 ? '' : 's'}, ` +
      `req.ip ${fly ? (fly === req.ip ? 'matches' : 'differs from') + ' Fly-Client-IP' : 'used as is'}, ` +
      `keyed on ${env.FLY_APP_NAME && fly ? 'Fly-Client-IP' : 'req.ip'}`
    );
  }

  function route(req, res) {
    logClientShape(req);
    const quota = takeRoute(clientKey(req, env));
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
      door: result.door,
    });
  }

  app.get('/api/route', route);
  app.post('/api/route', route);

  // The client draws the path network but no longer bundles it — one copy, and
  // editing paths.json no longer means rebuilding the front-end.
  //
  // my campus's paths only. The approach network is deliberately not here: it is routed
  // over and never drawn. See the `approach` import in index.js.
  app.get('/api/network', (req, res) => sendWire(req, res, wire.network));

  /**
   * Every vertex in the routing graph, campus and approach alike, as bare pairs.
   *
   * The client measures a start — a GPS fix, or Start here on a dropped pin —
   * against the nearest one, so a start too far from anything walkable is
   * refused without a round trip. It no longer moves anything onto them: a
   * vertex can be tens of metres along a path from where the router would join
   * it (see dropPin in src/main.js), so the coordinate itself is what is sent.
   *
   * Pairs rather than a FeatureCollection because this is the one payload where
   * the framing costs more than the data: `{"type":"Feature","properties":{},…}`
   * around each of these is roughly six times the two numbers inside it.
   */
  app.get('/api/vertices', (req, res) => sendWire(req, res, wire.vertices));

  for (const name of overlayNames) {
    app.get(`/api/${name}`, (req, res) => sendWire(req, res, wire[name]));
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
  if (distDir) mountDist(app, distDir);
  else log('[beavermaps] no dist/ found — API only. Run `npm run build` to serve the app.');

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

  return app;
}

/** A year, and a promise never to ask again. Only a content-hashed name earns it. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * The built front-end, in four layers, in this order.
 *
 * 1. compressedStatic answers compressible files to clients that accept gzip
 *    and sets the cache policy — dist/ is 3,576 KB uncompressed and 993 KB
 *    gzipped, which is the same argument as the API payloads and the same size
 *    of saving.
 *
 * 2. express.static answers everything that falls through — images, files
 *    under the 1 KB floor, clients that did not ask for gzip — and keeps
 *    ranges, HEAD and the rest where they belong. With the SAME cache policy
 *    as layer 1: a hashed name under assets/ is immutable whichever layer sent
 *    it, and anything else is `no-cache`. Left to itself express.static says
 *    `max-age=0` for everything, so the hashed images and the small hashed
 *    chunks were re-asked for on every load while the big chunks beside them
 *    were not. `index: false` because `/` is the shell, and the shell goes out
 *    through layer 4.
 *
 * 3. A miss under /assets/ is a 404 with `no-store`, NOT the shell. Every name
 *    under assets/ is hashed, so a miss there is a chunk from a previous build
 *    — an open tab or an installed PWA asking for the flyover code a deploy
 *    just replaced. Answered with index.html it came back 200 text/html, which
 *    the browser reports as a MIME-type error inside a dynamic import, and the
 *    tab stayed broken until somebody reloaded it by hand. A 404 is what the
 *    client's preload-error handler can act on. `no-store` so that no cache
 *    remembers the 404 for the moment the name exists again. Only /assets/:
 *    a dot elsewhere in a path is not evidence of a file, and deep links are
 *    allowed to contain one.
 *
 * 4. Everything else that is a GET or a HEAD is the shell — `/` and every deep
 *    link — and it goes out THROUGH LAYER 1, so it is compressed like any
 *    other file: 64.6 KB of index.html was going out raw on exactly the
 *    request a cold visitor waits on first, while the JS behind it went out
 *    gzipped. Only a client that cannot take gzip falls back to sendFile, with
 *    the same `no-cache` layer 1 would have set. index.html is the one file
 *    with a stable name and it is what names the hashed assets, so it has to
 *    be re-asked for every time or a rebuild is invisible.
 *
 *    Fallback as middleware rather than app.get('*') — Express 5 no longer
 *    accepts a bare wildcard path. GET AND HEAD ONLY: a single-page app serves
 *    its shell in place of a path it does not recognise because the router in
 *    the browser will recognise it; that argument is about navigation and
 *    navigation is a GET. Answering `DELETE /anything` with 200 and the whole
 *    app said this server has a handler for every verb at every path, which is
 *    both untrue and the sort of untrue that makes a scanner's report longer
 *    than it needs to be.
 */
function mountDist(app, distDir) {
  const serveCompressed = compressedStatic(distDir);
  const assetsDir = path.join(distDir, 'assets') + path.sep;

  app.use(serveCompressed);
  app.use(express.static(distDir, {
    index: false,
    setHeaders(res, file) {
      res.setHeader('Cache-Control', file.startsWith(assetsDir) ? IMMUTABLE : 'no-cache');
    },
  }));
  app.use('/assets', (_req, res) => res.status(404).set('Cache-Control', 'no-store').end());
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    req.url = '/index.html';
    return serveCompressed(req, res, () =>
      res.sendFile(path.join(distDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
  });
  app.use((_req, res) => res.status(405).json({ error: 'method not allowed' }));
}
