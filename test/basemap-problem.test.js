// The sentences shown when the ground will not draw.
//
// Worth testing for the same reason the routing refusals in directions.test.js
// are: these are the only output of a code path that, by definition, only runs
// when something is already wrong, and a refusal that does not name the way
// forward is barely better than the black rectangle it replaced.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapboxRefusal, MAPBOX_HOST, forVisitor, showsDetail, isTilesetRootFailure,
  PLAIN_MAP_PROBLEM, PLAIN_GOOGLE_FALLBACK, PLAIN_AERIAL_PROBLEM,
} from '../src/basemap-problem.js';

const ORIGIN = 'https://macbook-pro.local:5173';

test('a refused origin is quoted back, because it is the thing to be pasted', () => {
  const said = mapboxRefusal(403, ORIGIN);
  assert.ok(said.includes(ORIGIN), `403 must name the origin, said: ${said}`);
  assert.match(said, /URL restrictions/i);
});

test('a bad token sends you to .env rather than to the allowlist', () => {
  const said = mapboxRefusal(401, ORIGIN);
  assert.match(said, /VITE_MAPBOX_TOKEN/);
  // The origin is not the problem at 401 and naming it would send someone to
  // edit a restriction list that is not what refused them.
  assert.ok(!said.includes(ORIGIN), `401 must not blame the origin, said: ${said}`);
});

test('the two are told apart, not merged into one "check your key"', () => {
  assert.notEqual(mapboxRefusal(401, ORIGIN), mapboxRefusal(403, ORIGIN));
});

test('everything transient stays silent', () => {
  // A 429 clears on its own and a 404 is one tile. Both would otherwise put a
  // permanent-sounding sentence over a map that is working.
  for (const status of [200, 404, 429, 500, 503, undefined, null, NaN]) {
    assert.equal(mapboxRefusal(status, ORIGIN), null, `status ${status} should say nothing`);
  }
});

test('both refusals end in something to do', () => {
  for (const status of [401, 403]) {
    const said = mapboxRefusal(status, ORIGIN);
    assert.match(said, /Check|Add|use/, `${status} names no action: ${said}`);
    // One line in a status strip, not a paragraph.
    assert.ok(said.length < 200, `${status} is ${said.length} chars, too long for the panel`);
  }
});

test('the host guard names the host the errors actually come from', () => {
  // src/ground.js compares `new URL(error.url).host` against this, so a scheme or a
  // trailing slash here would silently match nothing and restore the black
  // rectangle. Measured value from a live 403.
  assert.equal(MAPBOX_HOST, 'api.mapbox.com');
  assert.equal(new URL('https://api.mapbox.com/v4/x/1/2/3.vector.pbf?a=b').host, MAPBOX_HOST);
});

// --- who gets the detail ----------------------------------------------------

test('a visitor gets the plain line; dev and ?debug get the detail', () => {
  // The detailed sentences above quote a token's configuration back. On the
  // deployed site that is read by the public, who can do nothing with it.
  const detail = mapboxRefusal(403, ORIGIN);
  const visitor = { dev: false, location: { search: '', hash: '' } };
  assert.equal(forVisitor(detail, PLAIN_MAP_PROBLEM, visitor), PLAIN_MAP_PROBLEM);
  assert.equal(forVisitor(detail, PLAIN_MAP_PROBLEM, { ...visitor, dev: true }), detail);
  assert.equal(forVisitor(detail, PLAIN_MAP_PROBLEM, { dev: false, location: { search: '?debug' } }), detail);
  assert.equal(forVisitor(detail, PLAIN_MAP_PROBLEM, { dev: false, location: { hash: '#debug' } }), detail);
});

test('?debug is read as a key, so a value that says debug does not count', () => {
  assert.equal(showsDetail({ dev: false, location: { search: '?q=debug' } }), false);
  assert.equal(showsDetail({ dev: false, location: { search: '?x=1&debug=1' } }), true);
});

test('with no Vite and no location, this is a visitor', () => {
  // Node has neither, so this is the default the module falls back to — and
  // importing it without `import.meta.env` did not throw to get here.
  assert.equal(showsDetail({ location: undefined }), false);
});

test('the plain lines name no configuration', () => {
  for (const plain of [PLAIN_MAP_PROBLEM, PLAIN_GOOGLE_FALLBACK, PLAIN_AERIAL_PROBLEM]) {
    assert.doesNotMatch(plain, /token|key|origin|VITE_|HTTP|referrer|restriction/i, plain);
    assert.ok(plain.length < 120, `${plain.length} chars is too long for the strip`);
  }
});

// --- the refused 3D root, reported once -------------------------------------

const ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';

test('the refused root is recognised by its URL, key and all', () => {
  // loaders.gl's FetchError carries the URL that failed, which is the root with
  // our key appended — see keyedFetch in src/flyover-view.js.
  const reason = Object.assign(new Error('403 Forbidden'), {
    url: 'https://tile.googleapis.com/v1/3dtiles/root.json?key=k&session=s',
  });
  assert.equal(isTilesetRootFailure(reason, ROOT), true);
});

test('nothing else is swallowed', () => {
  // A tile under the root, another host, an error with no URL at all: each of
  // those is a real failure somebody should still see in the console.
  const child = { url: 'https://tile.googleapis.com/v1/3dtiles/datasets/abc/files/x.glb' };
  const elsewhere = { url: 'https://example.com/v1/3dtiles/root.json' };
  for (const reason of [child, elsewhere, new Error('boom'), null, undefined, 'string', { url: 'not a url' }]) {
    assert.equal(isTilesetRootFailure(reason, ROOT), false, String(reason?.url ?? reason));
  }
});
