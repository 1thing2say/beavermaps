// src/storage.js — remembering a preference without betting the app on it.
//
// THE BUG THIS FILE IS ABOUT. `localStorage.getItem` is not a lookup that
// returns null when there is nothing there. It is a DOM API behind the
// same-origin policy, and it THROWS when the browser has decided this origin
// may not have storage — Safari with "Block all cookies", a Chromium webview
// with storage off, any third-party iframe under storage partitioning.
//
// Three of the seven modules that persist something guarded every access.
// theme, basemap, provider and skin did not, and those four are read at the top
// of startApp() before anything is drawn. An exception there is thrown during
// module evaluation, so what a visitor in that browser got was not a map with
// default settings — it was the blank page index.html starts as, and one line
// in a console they do not have open.
//
// So these tests are mostly about the failure modes, because the happy path was
// never the thing that was broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readText, readJson, writeText, writeJson, removeKey } from '../src/storage.js';

/** What a browser throws when an origin may not have storage. */
class StorageBlocked extends Error {}

/** Install a store for the duration of one test, and take it away after. */
function withStore(impl, body) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, get: () => impl(),
  });
  try {
    body();
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
}

/** A working store, the way a browser that allows one behaves. */
function workingStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** Safari with cookies blocked: the object is there, the methods throw. */
const hostileStore = () => ({
  getItem() { throw new StorageBlocked('SecurityError'); },
  setItem() { throw new StorageBlocked('SecurityError'); },
  removeItem() { throw new StorageBlocked('SecurityError'); },
});

/** A partitioned iframe: touching the PROPERTY throws, before any method call. */
const forbiddenProperty = () => { throw new StorageBlocked('SecurityError'); };

test('a value written comes back', () => {
  const store = workingStore();
  withStore(() => store, () => {
    writeText('k', 'apple');
    assert.equal(readText('k'), 'apple');
  });
});

test('an absent key is null, not undefined and not a throw', () => {
  const store = workingStore();
  withStore(() => store, () => assert.equal(readText('nope'), null));
});

test('JSON round-trips', () => {
  const store = workingStore();
  withStore(() => store, () => {
    writeJson('k', { preset: 'dusk', on: true });
    assert.deepEqual(readJson('k'), { preset: 'dusk', on: true });
  });
});

test('a key removed is gone', () => {
  const store = workingStore();
  withStore(() => store, () => {
    writeText('k', 'apple');
    removeKey('k');
    assert.equal(readText('k'), null);
  });
});

// --- the failure modes, which are the point ---------------------------------

test('a store whose methods throw reads as "nothing was ever set"', () => {
  withStore(hostileStore, () => {
    assert.equal(readText('mapper-theme'), null);
    assert.equal(readJson('mapper-debug'), null);
  });
});

test('a store whose methods throw does not throw on write either', () => {
  withStore(hostileStore, () => {
    assert.equal(writeText('mapper-theme', 'dark'), false);
    assert.doesNotThrow(() => writeJson('mapper-debug', { open: true }));
    assert.doesNotThrow(() => removeKey('mapper-popular'));
  });
});

test('a store that cannot even be REACHED is handled', () => {
  // The partitioned-iframe case. A guard wrapped around only the method calls
  // would not have caught this one, because the throw happens on the property
  // access that finds the object to call a method on.
  withStore(forbiddenProperty, () => {
    assert.equal(readText('mapper-skin'), null);
    assert.equal(writeText('mapper-skin', 'classic'), false);
  });
});

test('no store at all is handled — this is also every test run in node', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  delete globalThis.localStorage;
  try {
    assert.equal(readText('anything'), null);
    assert.equal(writeText('anything', 'x'), false);
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
  }
});

test('malformed JSON reads as null rather than throwing', () => {
  // These keys are hand-editable and survive across versions of the app. A
  // corrupt one should cost a visitor their suggestion order, not their map.
  const store = workingStore();
  withStore(() => store, () => {
    store.setItem('k', '{not json');
    assert.equal(readJson('k'), null);
  });
});

test('a JSON value that is legitimately null is not mistaken for a failure', () => {
  const store = workingStore();
  withStore(() => store, () => {
    writeJson('k', null);
    // Both mean "no usable value", which is what every caller acts on. Stated
    // as a test so the ambiguity is deliberate rather than discovered.
    assert.equal(readJson('k'), null);
  });
});

test('the preference modules all go through this, and none touches localStorage directly', async () => {
  // The regression guard for the actual bug: it was not that the guards were
  // wrong, it was that four files did not have them. A new preference module
  // reaching for localStorage itself is the same bug again.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { root } = await import('./helpers.js');

  const offenders = readdirSync(join(root, 'src'))
    .filter((f) => f.endsWith('.js') && f !== 'storage.js')
    .filter((f) => {
      const source = readFileSync(join(root, 'src', f), 'utf8')
        // Comments talk about localStorage all over this codebase and should
        // go on being allowed to.
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return /\blocalStorage\b/.test(source);
    });

  assert.deepEqual(offenders, [],
    `these reach for localStorage directly instead of src/storage.js: ${offenders.join(', ')}`);
});
