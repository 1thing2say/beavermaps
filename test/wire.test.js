// server/wire.js — what the API puts on the wire, and how it decides.
//
// The eight overlay payloads were the largest single cost in a cold load and
// they went out uncompressed; these are the rules that fixed that. Every one of
// them is a rule a passing app can still violate silently — a client that gets
// gzip it never asked for reads as a corrupt file, a missing Vary poisons a
// shared cache for everyone behind it, and an ETag that changes with the
// encoding costs a re-download on a file that never changed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { acceptsGzip, etagFor, wireForm, sendWire } from '../server/wire.js';

/** Just enough of an Express response to record what a handler did to one. */
function fakeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    ended: false,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    end(body = null) { this.body = body; this.ended = true; return this; },
  };
}

const send = (wire, headers = {}) => {
  const res = fakeRes();
  sendWire({ headers }, res, wire);
  return res;
};

const SAMPLE = { type: 'FeatureCollection', features: Array.from({ length: 200 }, (_, i) => ({
  type: 'Feature',
  properties: { name: `building ${i}` },
  geometry: { type: 'Point', coordinates: [-121.3355 + i / 1e5, 38.6555 + i / 1e5] },
})) };

test('a wire form carries both encodings and the compressed one is smaller', () => {
  const wire = wireForm(SAMPLE);
  assert.ok(wire.gzip.length < wire.raw.length / 2,
    `gzip ${wire.gzip.length} vs raw ${wire.raw.length} — GeoJSON should halve at worst`);
});

test('both encodings decode to the same value', () => {
  const wire = wireForm(SAMPLE);
  assert.deepEqual(JSON.parse(wire.raw.toString()), SAMPLE);
  assert.deepEqual(JSON.parse(gunzipSync(wire.gzip).toString()), SAMPLE);
});

test('the ETag names the resource, not the encoding it was sent in', () => {
  const wire = wireForm(SAMPLE);
  const gz = send(wire, { 'accept-encoding': 'gzip' });
  const raw = send(wire, {});
  assert.equal(gz.headers.etag, raw.headers.etag);
  // ...and it is the shape Express writes — weak, hex length, 27 base64 chars
  // of sha1 — so a cache filled before this module existed still matches. The
  // real check on that was done against the running old server, which answered
  // for src/basemap.json with the byte-identical tag this produces.
  assert.match(wire.etag, /^W\/"[0-9a-f]+-[\w+/]{27}"$/);
  assert.equal(wire.etag, etagFor(Buffer.from(JSON.stringify(SAMPLE))));
});

test('a different payload gets a different ETag', () => {
  assert.notEqual(wireForm({ a: 1 }).etag, wireForm({ a: 2 }).etag);
});

test('gzip goes only to a client that asked for it', () => {
  const wire = wireForm(SAMPLE);
  assert.equal(send(wire, { 'accept-encoding': 'gzip, deflate, br' }).headers['content-encoding'], 'gzip');
  assert.equal(send(wire, {}).headers['content-encoding'], undefined);
  assert.equal(send(wire, { 'accept-encoding': 'br' }).headers['content-encoding'], undefined);
});

test('`gzip;q=0` is a refusal, not a mention', () => {
  // The bug a substring test would have: the client named the encoding in order
  // to turn it down, and got it anyway.
  assert.equal(acceptsGzip('gzip;q=0'), false);
  assert.equal(acceptsGzip('gzip;q=0.0'), false);
  assert.equal(acceptsGzip('br, gzip;q=0'), false);
  assert.equal(acceptsGzip('gzip;q=0.5'), true);
  assert.equal(acceptsGzip('deflate, gzip'), true);
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip(''), false);
  assert.equal(acceptsGzip(), false);
});

test('every answer carries Vary, so a shared cache cannot mix the two up', () => {
  const wire = wireForm(SAMPLE);
  for (const headers of [{}, { 'accept-encoding': 'gzip' }]) {
    assert.equal(send(wire, headers).headers.vary, 'Accept-Encoding');
  }
});

test('the body sent is the body the headers describe', () => {
  const wire = wireForm(SAMPLE);
  const gz = send(wire, { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-length'], String(wire.gzip.length));
  assert.equal(gz.body.length, wire.gzip.length);

  const raw = send(wire, {});
  assert.equal(raw.headers['content-length'], String(wire.raw.length));
  assert.equal(raw.body.length, wire.raw.length);
});

test('a matching If-None-Match is answered 304 with no body', () => {
  const wire = wireForm(SAMPLE);
  const res = send(wire, { 'if-none-match': wire.etag, 'accept-encoding': 'gzip' });
  assert.equal(res.statusCode, 304);
  assert.equal(res.body, null);
  assert.equal(res.headers['content-encoding'], undefined);
});

test('If-None-Match is a list, and a stale tag in it is not a match', () => {
  const wire = wireForm(SAMPLE);
  assert.equal(send(wire, { 'if-none-match': `W/"old", ${wire.etag}` }).statusCode, 304);
  assert.equal(send(wire, { 'if-none-match': 'W/"old"' }).statusCode, 200);
});

test('the cache is told to revalidate rather than to guess', () => {
  assert.equal(send(wireForm(SAMPLE), {}).headers['cache-control'], 'no-cache');
});
