// The sentences shown when the ground will not draw.
//
// Worth testing for the same reason the routing refusals in directions.test.js
// are: these are the only output of a code path that, by definition, only runs
// when something is already wrong, and a refusal that does not name the way
// forward is barely better than the black rectangle it replaced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mapboxRefusal, MAPBOX_HOST } from '../src/basemap-problem.js';

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
