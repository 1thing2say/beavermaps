// src/api.js — what each non-200 from our own server MEANS.
//
// Four endpoints, and they do not agree about failure. A 404 from /api/route is
// an ANSWER — "both ends are on the graph and nothing joins them" — while a 404
// from /api/buildings is a deployment that lost a file. Reading them as the
// same thing is how a missing overlay becomes a silent empty layer and a
// genuine routing failure becomes an exception nobody catches.
//
// None of this could be exercised inside startApp(), because `fetch` was
// reached for directly. Here it is an argument.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';

/** A fetch that answers with one canned response and records what it was asked. */
function fakeFetch(response) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  return { request, calls };
}

const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const ROUTE = {
  geometry: { type: 'LineString', coordinates: [[-121.3465, 38.6486], [-121.3455, 38.6486]] },
  distanceFeet: 240,
  maneuvers: [{ index: 0, type: 'depart' }, { index: 1, type: 'arrive' }],
};

test('a route comes back as the server sent it', async () => {
  const { request } = fakeFetch(jsonResponse(200, ROUTE));
  const api = createApi({ request });
  assert.deepEqual(await api.route([0, 0], [1, 1]), ROUTE);
});

test('a route is asked for by POST, as JSON, with both ends', async () => {
  const fake = fakeFetch(jsonResponse(200, ROUTE));
  await createApi({ request: fake.request }).route([-121.3465, 38.6486], [-121.3455, 38.6486]);

  const [call] = fake.calls;
  assert.equal(call.url, '/api/route');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.options.body), {
    from: [-121.3465, 38.6486],
    to: [-121.3455, 38.6486],
  });
});

test('404 from the router is null — an answer, not a failure', async () => {
  // Both ends are on the graph; the graph does not join them. The caller says
  // "No path found between those two points" and stays running.
  const { request } = fakeFetch(jsonResponse(404, { error: 'no path found on the network' }));
  assert.equal(await createApi({ request }).route([0, 0], [1, 1]), null);
});

test('422 is a refusal, and the server keeps the wording', async () => {
  // Two different things come back 422 — an end too far to snap to, and both
  // ends in the same place — and only the server knows which.
  const said = 'Start and destination are the same place — pick a destination further off.';
  const { request } = fakeFetch(jsonResponse(422, { error: said, reason: 'same-place' }));
  assert.deepEqual(await createApi({ request }).route([0, 0], [0, 0]), { refused: said });
});

test('a 422 whose body cannot be read still refuses, vaguely', async () => {
  // The fallback only runs when the body is unreadable, and a specific guess
  // there would be a specific guess.
  const { request } = fakeFetch({
    status: 422,
    ok: false,
    json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
  });
  const answer = await createApi({ request }).route([0, 0], [1, 1]);
  assert.ok(answer.refused);
  assert.doesNotMatch(answer.refused, /too far/i, 'it guessed which kind of 422 this was');
});

test('any other route failure throws, with the status in it', async () => {
  for (const status of [400, 429, 500, 502]) {
    const { request } = fakeFetch(jsonResponse(status, {}));
    await assert.rejects(
      () => createApi({ request }).route([0, 0], [1, 1]),
      (error) => error.message.includes(String(status)),
      `status ${status}`,
    );
  }
});

test('the three overlay endpoints throw on anything but success', async () => {
  // A missing overlay is a deployment problem, not an answer. The caller logs it
  // and steps over that one layer — but it has to be told.
  const api = (status) => createApi({ request: fakeFetch(jsonResponse(status, {})).request });
  for (const status of [404, 500]) {
    await assert.rejects(() => api(status).network(), /network request failed/);
    await assert.rejects(() => api(status).vertices(), /vertex request failed/);
    await assert.rejects(() => api(status).overlay('buildings'), /buildings request failed/);
  }
});

test('an overlay names itself in its own failure', async () => {
  // Four of these are fetched together at boot and logged by one handler, so
  // "request failed" without the name says nothing about which file is missing.
  for (const name of ['buildings', 'basemap', 'amenities', 'places']) {
    const { request } = fakeFetch(jsonResponse(500, {}));
    await assert.rejects(() => createApi({ request }).overlay(name), new RegExp(name));
  }
});

test('network and vertices are different requests', async () => {
  // /api/network is what gets DRAWN — the campus's own linework. /api/vertices
  // is what gets SNAPPED TO, and includes the surrounding streets, or a click
  // on the pavement outside lands on the far side of a car park.
  const fake = fakeFetch(jsonResponse(200, { type: 'FeatureCollection', features: [] }));
  const api = createApi({ request: fake.request });
  await api.network();
  await api.vertices();
  assert.deepEqual(fake.calls.map((c) => c.url), ['/api/network', '/api/vertices']);
});

test('an overlay is fetched from its own path', async () => {
  const fake = fakeFetch(jsonResponse(200, {}));
  await createApi({ request: fake.request }).overlay('directory');
  assert.equal(fake.calls[0].url, '/api/directory');
});
