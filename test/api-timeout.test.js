// src/api.js — a boot request that never answers.
//
// The four GETs the app makes as it loads had no ceiling on the wait. On a
// connection that had silently dropped, fetch neither resolved nor rejected for
// minutes, so "Loading the campus…" spun under its spinner and the routing
// outage sentence — said when /api/network fails — could never be said.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, BOOT_TIMEOUT_MS } from '../src/api.js';

/**
 * A fetch that never answers on its own, and gives up only when its signal says
 * to. The interval stands in for the open socket: Node 20 unrefs the timer
 * behind AbortSignal.timeout, so without a handle holding the loop the test
 * would end before the ceiling fires.
 */
function stalled() {
  const signals = [];
  const request = (url, init) => new Promise((resolve, reject) => {
    signals.push({ url, signal: init?.signal });
    const socket = setInterval(() => {}, 1_000);
    init?.signal?.addEventListener('abort', () => {
      clearInterval(socket);
      reject(init.signal.reason);
    });
  });
  return { request, signals };
}

test('a boot request that never answers fails instead of hanging', async () => {
  const { request, signals } = stalled();
  const api = createApi({ request, bootTimeoutMs: 20 });
  const isTimeout = (error) => error?.name === 'TimeoutError';
  await assert.rejects(api.network(), isTimeout);
  await assert.rejects(api.vertices(), isTimeout);
  await assert.rejects(api.overlay('places'), isTimeout);
  assert.deepEqual(signals.map((s) => s.url), ['/api/network', '/api/vertices', '/api/places']);
});

test('each request gets a signal of its own', async () => {
  // A timeout signal starts counting when it is made, so one shared between
  // requests would cut the later ones short.
  const { request, signals } = stalled();
  const api = createApi({ request, bootTimeoutMs: 20 });
  await Promise.allSettled([api.network(), api.overlay('buildings')]);
  assert.ok(signals.every((s) => s.signal instanceof AbortSignal));
  assert.notEqual(signals[0].signal, signals[1].signal);
});

test('an answer inside the ceiling is unaffected by it', async () => {
  const api = createApi({
    request: async () => ({ ok: true, status: 200, json: async () => ({ type: 'FeatureCollection' }) }),
    bootTimeoutMs: 20,
  });
  assert.deepEqual(await api.network(), { type: 'FeatureCollection' });
});

test('the ceiling is long enough for the largest overlay on a slow phone', () => {
  // /api/basemap is about 1.6 MB, and the ceiling covers the body as well.
  assert.ok(BOOT_TIMEOUT_MS >= 15_000);
});
