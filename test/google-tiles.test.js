// src/google-tiles.js — a Google that never answers.
//
// Google is the default provider over a blank style, so until a session is
// minted there is no ground at all, and src/ground.js only falls back to Mapbox
// when the session REJECTS. A network that silently drops googleapis.com
// traffic never rejects: the request used to hang for the browser's own socket
// timeout, minutes of a spinner over an empty canvas. These hold it to a
// deadline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { googleGround, GOOGLE_TIMEOUT_MS } from '../src/google-tiles.js';

globalThis.window ??= { devicePixelRatio: 1 };

const BOUNDS = [[-121.36, 38.64], [-121.34, 38.66]];

/**
 * A fetch that never answers, but lets go when its signal aborts. The interval
 * stands in for the open socket: Node 20 unrefs the timer behind
 * AbortSignal.timeout, so without a handle holding the loop the test would end
 * before the deadline fires.
 */
function hangingFetch(calls) {
  return (url, options = {}) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      const socket = setInterval(() => {}, 1_000);
      options.signal?.addEventListener('abort', () => {
        clearInterval(socket);
        reject(options.signal.reason);
      });
    });
  };
}

function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  return run().finally(() => { globalThis.fetch = real; });
}

test('the deadline is a matter of seconds, not the socket timeout', () => {
  assert.ok(GOOGLE_TIMEOUT_MS >= 5_000 && GOOGLE_TIMEOUT_MS <= 20_000);
});

test('a createSession that never answers rejects, in words', async () => {
  const calls = [];
  await withFetch(hangingFetch(calls), async () => {
    const started = Date.now();
    await assert.rejects(
      googleGround({
        key: 'k', basemap: 'map', theme: 'light', skin: 'apple', bounds: BOUNDS, timeoutMs: 30,
      }),
      { message: 'Google did not answer in time' },
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(calls.length, 1);
  });
});

test('a timed-out session is not cached, so the next request asks again', async () => {
  const calls = [];
  await withFetch(hangingFetch(calls), async () => {
    const ask = () => googleGround({
      key: 'k', basemap: 'satellite', theme: 'dark', skin: 'apple', bounds: BOUNDS, timeoutMs: 20,
    });
    await assert.rejects(ask());
    await assert.rejects(ask());
    assert.equal(calls.length, 2);
  });
});

test('an attribution call that never answers falls back rather than holding the ground', async () => {
  const fake = (url, options = {}) => {
    if (url.includes('createSession')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ session: 'tok', expiry: String(Math.floor(Date.now() / 1000) + 3600) }),
      });
    }
    return hangingFetch([])(url, options);
  };
  await withFetch(fake, async () => {
    const source = await googleGround({
      key: 'k', basemap: 'map', theme: 'dark', skin: 'classic', bounds: BOUNDS, timeoutMs: 20,
    });
    assert.equal(source.type, 'raster');
    assert.equal(source.attribution, 'Map data ©Google');
  });
});
