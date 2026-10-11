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
import {
  createApi, withRetry, RETRY_DELAYS_MS, UNREACHABLE, ROUTING_OUTAGE, unreachableFor,
} from '../src/api.js';

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
  for (const status of [400, 500, 502]) {
    const { request } = fakeFetch(jsonResponse(status, {}));
    await assert.rejects(
      () => createApi({ request }).route([0, 0], [1, 1]),
      (error) => error.message.includes(String(status)),
      `status ${status}`,
    );
  }
});

test('429 is a refusal in the server\'s words, not an outage', async () => {
  // It used to throw with the rest, and the caller turned every throw into
  // "routing server unreachable" — so our own rate limit told people the
  // server was down. The server is up; it is asking them to wait.
  const said = 'too many route requests — try again shortly';
  const { request } = fakeFetch(jsonResponse(429, { error: said }));
  assert.deepEqual(await createApi({ request }).route([0, 0], [1, 1]), { refused: said });
});

test('a 429 whose body cannot be read still says to wait', async () => {
  const { request } = fakeFetch({
    status: 429,
    ok: false,
    json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
  });
  const answer = await createApi({ request }).route([0, 0], [1, 1]);
  assert.ok(answer.refused);
  assert.match(answer.refused, /try again/i);
});

test('a route request carries a timeout where the platform has one', async () => {
  // A connection that has silently dropped would otherwise hold "Calculating
  // route…" for the browser's own timeout, which is minutes.
  const fake = fakeFetch(jsonResponse(200, ROUTE));
  await createApi({ request: fake.request }).route([0, 0], [1, 1]);
  if (typeof AbortSignal.timeout === 'function') {
    assert.ok(fake.calls[0].options.signal instanceof AbortSignal, 'no signal on the request');
  }
});

test('a route is asked for once, never retried behind the visitor\'s back', async () => {
  const fake = fakeFetch(jsonResponse(503, {}));
  await assert.rejects(() => createApi({ request: fake.request, sleep: async () => {} }).route([0, 0], [1, 1]));
  assert.equal(fake.calls.length, 1);
});

test('the unreachable sentence only mentions the dev server in dev', () => {
  // Everybody on the deployed site was being asked whether `npm run dev` was
  // still running. None of them can run it.
  assert.match(unreachableFor(true), /npm run dev/);
  assert.doesNotMatch(unreachableFor(false), /npm|server/i);
  assert.match(unreachableFor(false), /try again/i);
  // Node has no Vite in front of it, so this is the production sentence — and
  // importing the module without `import.meta.env` did not throw to get here.
  assert.equal(UNREACHABLE, unreachableFor(false));
  assert.match(ROUTING_OUTAGE, /reload/i);
  assert.doesNotMatch(ROUTING_OUTAGE, /npm/);
});

/** Instant waits, recorded, so a retry schedule can be read without sitting through it. */
function fakeSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('the three overlay endpoints throw on anything but success', async () => {
  // A missing overlay is a deployment problem, not an answer. The caller logs it
  // and steps over that one layer — but it has to be told.
  const api = (status) => createApi({
    request: fakeFetch(jsonResponse(status, {})).request,
    sleep: async () => {},
  });
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
    await assert.rejects(() => createApi({ request, sleep: async () => {} }).overlay(name), new RegExp(name));
  }
});

test('a 5xx at boot is retried on the schedule, and then reported', async () => {
  // A machine restarting under a deploy answers 502 for a second or two. One
  // failed attempt used to cost the layer — or, for the network, every route —
  // for the rest of the session.
  const fake = fakeFetch(jsonResponse(502, {}));
  const { waits, sleep } = fakeSleep();
  await assert.rejects(() => createApi({ request: fake.request, sleep }).network(), /502/);
  assert.equal(fake.calls.length, RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(waits, RETRY_DELAYS_MS);
  assert.deepEqual(RETRY_DELAYS_MS, [500, 1500, 4000]);
});

test('a request that never reached the server is retried until it does', async () => {
  let attempts = 0;
  const request = async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('Failed to fetch');
    return jsonResponse(200, { type: 'FeatureCollection', features: [] });
  };
  const { waits, sleep } = fakeSleep();
  const places = await createApi({ request, sleep }).overlay('places');
  assert.equal(places.type, 'FeatureCollection');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [500, 1500]);
});

test('a 404 is not retried: it will be a 404 every time', async () => {
  const fake = fakeFetch(jsonResponse(404, {}));
  const { waits, sleep } = fakeSleep();
  await assert.rejects(() => createApi({ request: fake.request, sleep }).overlay('buildings'));
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(waits, []);
});

test('withRetry rethrows anything not marked transient at once', async () => {
  let calls = 0;
  const { waits, sleep } = fakeSleep();
  await assert.rejects(
    () => withRetry(async () => { calls += 1; throw new SyntaxError('bad JSON'); }, { sleep }),
    SyntaxError,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
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
