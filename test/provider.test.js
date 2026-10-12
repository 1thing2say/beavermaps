// src/provider.js and the one judgement in src/google-tiles.js it leans on —
// whether falling back from Google to Mapbox is remembered.
//
// It used to be remembered every time. Any rejection while minting a Google
// session wrote 'mapbox' into storage, and preferredProvider read that back on
// every later visit — so a phone that opened the map on a dropped connection,
// or behind a captive portal, was opted out of the default ground for good.
// Only a refusal should outlive the page: a key Google turned down will be
// turned down again tomorrow; a request that never got an answer says nothing
// about tomorrow at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { isRefusal } from '../src/google-tiles.js';

// provider.js reaches the spinner, and the spinner imports its package's
// stylesheet for Vite to bundle. Node has no loader for a .css file, so this
// one answers every stylesheet with an empty module. Registered before the
// dynamic import below, and only for this file's own process.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  }
`)}`);
const { createProviderToggle, preferredProvider } = await import('../src/provider.js');

/** A browser's storage and its root element, for the length of one test. */
function withBrowser(body) {
  const map = new Map();
  const store = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  const hadStore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const hadDocument = globalThis.document;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => store });
  globalThis.document = { documentElement: { dataset: {} } };
  try {
    body(map);
  } finally {
    if (hadStore) Object.defineProperty(globalThis, 'localStorage', hadStore);
    else delete globalThis.localStorage;
    if (hadDocument === undefined) delete globalThis.document;
    else globalThis.document = hadDocument;
  }
}

function toggle() {
  const surface = {
    button: { addEventListener() {}, setAttribute() {} },
    icon: { innerHTML: '' },
    label: { textContent: '' },
  };
  return createProviderToggle({ surfaces: [surface], onChange() {} });
}

test('a fallback that is not to be kept leaves Google the default next time', () => {
  withBrowser((stored) => {
    const control = toggle();
    control.revert({ persist: false });
    assert.equal(stored.has('mapper-provider'), false, 'the fallback was written down');
    assert.equal(preferredProvider(), 'google');
    // And this page is on Mapbox all the same.
    assert.equal(globalThis.document.documentElement.dataset.provider, 'mapbox');
  });
});

test('a refusal is still remembered, so the next visit does not ask again', () => {
  withBrowser(() => {
    toggle().revert();
    assert.equal(preferredProvider(), 'mapbox');
  });
});

test('Google saying no is a refusal', () => {
  // Key invalid, API not enabled, referrer not allowed: all 4xx.
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isRefusal(Object.assign(new Error('no'), { status })), true, `${status}`);
  }
  assert.equal(isRefusal({ refused: true }), true, 'a missing key');
});

test('a request that never got an answer is not', () => {
  // fetch's own rejection: offline, DNS, a reset connection.
  assert.equal(isRefusal(new TypeError('Failed to fetch')), false);
  for (const status of [408, 429, 500, 502, 503]) {
    assert.equal(isRefusal(Object.assign(new Error('later'), { status })), false, `${status}`);
  }
  // A 200 that was a captive portal's page rather than Google's answer.
  assert.equal(isRefusal(new Error('createSession returned no session token')), false);
  assert.equal(isRefusal(undefined), false);
});
