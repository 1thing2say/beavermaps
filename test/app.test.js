// server/app.js — how a request is answered, over real HTTP.
//
// Everything here used to live in server/index.js beside a graph build and a
// listen(), so none of it could be asked about without booting the whole
// server. Now the graph is a stub, dist/ is a scratch directory, and the app
// listens on a port the OS picks. What is worth checking is the part a unit
// test of one middleware cannot see: the ORDER the layers are in, and which
// of them actually answers a given request.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, parseCoord } from '../server/app.js';
import { createRateLimit } from '../server/limit.js';
import { wireForm } from '../server/wire.js';
import { inlineScriptHashes } from '../server/headers.js';

// --- a scratch dist/ ---------------------------------------------------------

const DIST = mkdtempSync(path.join(tmpdir(), 'beavermaps-app-'));
mkdirSync(path.join(DIST, 'assets'));
const THEME_SCRIPT = '\n  document.documentElement.dataset.theme = "light";\n';
// Over the 1 KB floor in wire.js, as the real one is by sixty times, so the
// compressed path is the one that answers it.
const INDEX_HTML = `<!doctype html><html><head><script>${THEME_SCRIPT}</script>`
  + '<script type="module" src="/assets/app-abc123.js"></script></head><body>'
  + '<div class="app-shell"></div>'.repeat(80) + '</body></html>';
writeFileSync(path.join(DIST, 'index.html'), INDEX_HTML);
writeFileSync(path.join(DIST, 'assets', 'app-abc123.js'), 'const x = "' + 'a'.repeat(5000) + '";\n');
writeFileSync(path.join(DIST, 'assets', 'tiny-abc123.js'), 'let a=1;\n');
writeFileSync(path.join(DIST, 'assets', 'pic-abc123.png'), Buffer.alloc(4096, 7));
writeFileSync(path.join(DIST, 'manifest.webmanifest'), '{"name":"beavermaps"}');

// --- a stub graph ------------------------------------------------------------

const ROUTE = {
  ok: true,
  geometry: { type: 'LineString', coordinates: [[-121.3355, 38.6555], [-121.3356, 38.6556]] },
  distanceFeet: 42,
  maneuvers: [],
  snapped: null,
  door: null,
};
const graph = { route: () => ROUTE, vertices: [[-121.3355, 38.6555]] };
const WIRE = {
  network: wireForm({ type: 'FeatureCollection', features: [] }),
  vertices: wireForm({ vertices: graph.vertices }),
  buildings: wireForm({ type: 'FeatureCollection', features: [] }),
};

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((done) => s.close(done)))));

/** Stand an app up on an ephemeral port and return its base URL. */
async function start(options = {}) {
  const app = createApp({
    graph,
    wire: WIRE,
    overlayNames: ['buildings'],
    distDir: DIST,
    env: {},
    log: () => {},
    ...options,
  });
  const server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * One raw request. Raw rather than fetch() because fetch decodes gzip for you,
 * and whether the bytes on the wire were gzipped is half of what is under test.
 */
function request(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

const postRoute = (base, body, headers = {}) => request(base, '/api/route', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

const A = [-121.3355, 38.6555];
const B = [-121.3365, 38.6565];

// --- the rate limit's key (item 2) ------------------------------------------

test('on Fly, two visitors behind the same proxy hop get separate buckets', async () => {
  // What fly-proxy sends: the visitor in Fly-Client-IP, and an X-Forwarded-For
  // whose right-most entry — the one `trust proxy 1` turns into req.ip — is the
  // same for everybody. Keyed on req.ip, the second visitor was refused for the
  // first one's request.
  const base = await start({ env: { FLY_APP_NAME: 'beavermaps' }, takeRoute: createRateLimit({ max: 1 }) });
  const first = await postRoute(base, { from: A, to: B }, {
    'fly-client-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7, 172.16.0.2',
  });
  const second = await postRoute(base, { from: A, to: B }, {
    'fly-client-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.9, 172.16.0.2',
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'a different visitor was counted against the first one');

  // ...and the first visitor's own bucket is still theirs.
  const again = await postRoute(base, { from: A, to: B }, {
    'fly-client-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7, 172.16.0.2',
  });
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers['retry-after']) >= 1);
});

test('off Fly, a Fly-Client-IP the client wrote itself is ignored', async () => {
  // Nothing strips the header when there is no fly-proxy in front, so honouring
  // it would make the limit a header field anybody can rotate.
  const base = await start({ env: {}, takeRoute: createRateLimit({ max: 1 }) });
  assert.equal((await postRoute(base, { from: A, to: B }, { 'fly-client-ip': '203.0.113.7' })).status, 200);
  const spoofed = await postRoute(base, { from: A, to: B }, { 'fly-client-ip': '198.51.100.9' });
  assert.equal(spoofed.status, 429, 'rotating Fly-Client-IP bought a fresh allowance');
});

test('off Fly, X-Forwarded-For still picks the bucket — documented, not defended', async () => {
  // `trust proxy 1` takes the socket peer for the trusted hop, so with nothing
  // in front a direct client's own right-most X-Forwarded-For entry becomes
  // req.ip. That is the accepted off-Fly behaviour clientKey's comment
  // describes; this pins it so the comment cannot drift back to claiming the
  // socket address is used. A client sending no header stays in one bucket.
  const base = await start({ env: {}, takeRoute: createRateLimit({ max: 1 }) });
  const statuses = [];
  for (const xff of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
    statuses.push((await postRoute(base, { from: A, to: B }, { 'x-forwarded-for': xff })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200]);
  assert.equal((await postRoute(base, { from: A, to: B })).status, 200);
  assert.equal((await postRoute(base, { from: A, to: B })).status, 429);
});

test('the first route request logs the header shape once, with no address in it', async () => {
  const lines = [];
  const base = await start({ env: { FLY_APP_NAME: 'beavermaps' }, log: (line) => lines.push(line) });
  const headers = { 'fly-client-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7, 172.16.0.2' };
  await postRoute(base, { from: A, to: B }, headers);
  await postRoute(base, { from: A, to: B }, headers);
  const shape = lines.filter((l) => l.includes('first route request'));
  assert.equal(shape.length, 1);
  assert.match(shape[0], /Fly-Client-IP present/);
  assert.match(shape[0], /X-Forwarded-For 2 hops/);
  assert.match(shape[0], /keyed on Fly-Client-IP/);
  assert.doesNotMatch(shape[0], /203\.0\.113\.7|172\.16\.0\.2/);
});

// --- malformed coordinates (item 21) -----------------------------------------

test('a coordinate of the wrong shape is a 400, never a 500', async () => {
  const base = await start();
  const bad = [
    { toString: 1 },          // String() throws on this one — it was a 500
    [[1], 2],                 // Number([1]) is 1, so this was accepted
    [true, 38.6],
    [null, 38.6],
    ['', ''],                 // Number('') is 0, so this was (0, 0)
    ',',
    '1,2,3',
    [1],
    42,
    null,
  ];
  for (const from of bad) {
    const res = await postRoute(base, { from, to: B });
    assert.equal(res.status, 400, `from=${JSON.stringify(from)} gave ${res.status}`);
    assert.match(res.headers['content-type'], /application\/json/);
  }
});

test('the query string is held to the same rules', async () => {
  const base = await start();
  for (const from of [',', 'a,b', '1,2,3', '', '-121.3&from=38.6&from=1']) {
    const res = await request(base, `/api/route?from=${from}&to=-121.3,38.6`);
    assert.equal(res.status, 400, `from=${from} gave ${res.status}`);
  }
});

test('the shapes a client actually sends still route', async () => {
  const base = await start();
  assert.equal((await postRoute(base, { from: A, to: B })).status, 200);
  assert.equal((await postRoute(base, { from: A.map(String), to: B })).status, 200);
  assert.equal((await request(base, `/api/route?from=${A.join(',')}&to=${B.join(',')}`)).status, 200);
});

test('parseCoord: strings and pairs of numbers, nothing else', () => {
  assert.deepEqual(parseCoord('-121.3, 38.6'), [-121.3, 38.6]);
  assert.deepEqual(parseCoord([-121.3, '38.6']), [-121.3, 38.6]);
  assert.equal(parseCoord({ toString: 1 }), null);
  assert.equal(parseCoord([[1], 2]), null);
  assert.equal(parseCoord(['1', ' ']), null);
  assert.equal(parseCoord('200,0'), null);
  assert.equal(parseCoord('0,91'), null);
  assert.equal(parseCoord(undefined), null);
});

// --- the shell, compressed (item 8) ------------------------------------------

test('`/` and a deep link go out gzipped and no-cache', async () => {
  const base = await start();
  for (const pathname of ['/', '/building/library']) {
    const res = await request(base, pathname, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['content-encoding'], 'gzip', `${pathname} went out uncompressed`);
    assert.equal(res.headers['cache-control'], 'no-cache', pathname);
    assert.match(res.headers['content-type'], /text\/html/, pathname);
    assert.equal(gunzipSync(res.body).toString(), INDEX_HTML, pathname);
  }
});

test('a client that cannot take gzip still gets the shell, no-cache', async () => {
  const base = await start();
  const res = await request(base, '/building/library');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(res.body.toString(), INDEX_HTML);
});

test('HEAD on the shell has the headers and no body', async () => {
  const base = await start();
  const res = await request(base, '/', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.body.length, 0);
});

test('only GET and HEAD get the shell', async () => {
  const base = await start();
  assert.equal((await request(base, '/anything', { method: 'DELETE' })).status, 405);
});

test('an unknown /api path is a JSON 404, not the shell', async () => {
  const base = await start();
  const res = await request(base, '/api/buidlings');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/json/);
});

// --- a chunk from a previous build (item 5) ----------------------------------

test('a missing file under /assets/ is a 404 with no-store, not the shell', async () => {
  // An open tab asking for a chunk the last deploy replaced. Answered with the
  // shell it was a 200 text/html, which the browser reports as a MIME error
  // inside a dynamic import, and nothing could tell it to reload.
  const base = await start();
  for (const headers of [{ 'accept-encoding': 'gzip' }, {}]) {
    const res = await request(base, '/assets/flyover-old999.js', { headers });
    assert.equal(res.status, 404);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.doesNotMatch(res.headers['content-type'] ?? '', /text\/html/);
    assert.equal(res.body.length, 0);
  }
});

test('a deep link with a dot in it is still the shell', async () => {
  const base = await start();
  const res = await request(base, '/place/st.johns');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), INDEX_HTML);
});

// --- cache policy for every built file (item 35) -----------------------------

test('every hashed asset is immutable, whichever layer answers it', async () => {
  const base = await start();
  const IMMUTABLE = 'public, max-age=31536000, immutable';
  // Gzipped by compressedStatic:
  assert.equal((await request(base, '/assets/app-abc123.js', { headers: { 'accept-encoding': 'gzip' } }))
    .headers['cache-control'], IMMUTABLE);
  // ...and the three that fall through to express.static, which on its own
  // says max-age=0: an image, a file under the gzip floor, a client with no gzip.
  for (const [pathname, headers] of [
    ['/assets/pic-abc123.png', { 'accept-encoding': 'gzip' }],
    ['/assets/tiny-abc123.js', { 'accept-encoding': 'gzip' }],
    ['/assets/app-abc123.js', {}],
  ]) {
    const res = await request(base, pathname, { headers });
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['cache-control'], IMMUTABLE, pathname);
  }
});

test('a stable name outside /assets/ is revalidated every time', async () => {
  const base = await start();
  const res = await request(base, '/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
});

// --- security headers (item 19) ----------------------------------------------

test('every response carries the policy headers', async () => {
  const base = await start();
  for (const pathname of ['/', '/api/buildings', '/healthz', '/assets/flyover-old999.js']) {
    const { headers } = await request(base, pathname);
    assert.equal(headers['x-content-type-options'], 'nosniff', pathname);
    assert.equal(headers['x-frame-options'], 'DENY', pathname);
    assert.match(headers['permissions-policy'], /geolocation=\(self\)/, pathname);
    assert.match(headers['permissions-policy'], /camera=\(\)/, pathname);
    assert.ok(headers['content-security-policy-report-only'], pathname);
    // Report-Only until a deploy has run clean under it — an enforcing policy
    // that is wrong about one host is a map with no flyover.
    assert.equal(headers['content-security-policy'], undefined, pathname);
  }
});

test('the policy allows the built page\'s own inline script by hash', async () => {
  const base = await start();
  const csp = (await request(base, '/')).headers['content-security-policy-report-only'];
  const [hash] = inlineScriptHashes(readFileSync(path.join(DIST, 'index.html'), 'utf8'));
  const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'));
  assert.ok(scriptSrc.includes(hash), `${hash} not in ${scriptSrc}`);
  assert.ok(!scriptSrc.includes("'unsafe-inline'"));
});

test('HSTS only over HTTPS, and only for this host', async () => {
  const base = await start();
  // Plain HTTP with no proxy saying otherwise: browsers ignore HSTS over HTTP,
  // and this is also what Vite's /api proxy looks like under `npm run dev`,
  // where an honoured header would pin all of localhost to HTTPS for a year.
  assert.equal((await request(base, '/healthz')).headers['strict-transport-security'], undefined);
  // Through the one trusted proxy hop, as fly-proxy sends it.
  const hsts = (await request(base, '/healthz', { headers: { 'x-forwarded-proto': 'https' } }))
    .headers['strict-transport-security'];
  assert.equal(hsts, 'max-age=31536000');
  assert.doesNotMatch(hsts, /includeSubDomains|preload/);
});

test('without a dist/ the API still answers and nothing is served as the shell', async () => {
  const base = await start({ distDir: null });
  assert.equal((await request(base, '/healthz')).status, 200);
  assert.equal((await request(base, '/')).status, 404);
});
