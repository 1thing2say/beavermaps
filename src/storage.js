// Reading and writing the visitor's preferences, without betting the app on it.
//
// `localStorage` is not a property bag that is always there. It is a DOM API
// behind the same-origin policy, and every one of its methods — getItem
// included — THROWS rather than returning null when the browser has decided
// this origin may not have storage. Safari with "Block all cookies" does that.
// So does a Chromium embedded webview with storage disabled, and so does any
// third-party iframe under storage partitioning.
//
// Three of the seven modules that persist something already knew this and
// wrapped every access, each with its own try/catch and its own comment saying
// why. The other four — theme, basemap, provider and skin — did not, and those
// four are read at src/main.js:179-187, which is the first thing that runs
// after the token check. An exception there is thrown during module evaluation:
// no map, no chrome, no error on screen, a white page and a line in a console
// nobody has open. A blank map is a high price for remembering which of two
// basemaps somebody last looked at.
//
// So the guard lives in one place and everything goes through it. A preference
// that cannot be read is a preference that was never set, which is exactly the
// default path every one of these callers already has.

/** The store, or null where touching it is itself an error. */
function store() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Accessing the PROPERTY throws in a partitioned iframe, before any method
    // is called on it. This is not the same failure as getItem throwing, and a
    // guard around only the call sites would not have caught it.
    return null;
  }
}

/** A stored string, or null — never a throw. */
export function readText(key) {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * A stored JSON value, or null.
 *
 * Null for absent, unreadable AND malformed alike, because every caller treats
 * all three the same way: fall back to the default and carry on. These keys are
 * hand-editable and worth nothing — a corrupt one should cost a visitor their
 * suggestion order or their bench settings, not their map.
 */
export function readJson(key) {
  const raw = readText(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Persist a string. Returns whether it stuck, for the one caller that cares.
 *
 * The absent-store case returns false rather than sailing past on an optional
 * call. `store()?.setItem(…)` followed by `return true` type-checks, runs
 * clean, writes nothing and reports success — which is a worse answer than
 * throwing, because it is the answer a caller would act on.
 */
export function writeText(key, value) {
  try {
    const held = store();
    if (!held) return false;
    held.setItem(key, value);
    return true;
  } catch {
    // Private browsing, or a full quota. Neither is worth a throw in the middle
    // of opening a place card.
    return false;
  }
}

/** Persist a JSON value. */
export const writeJson = (key, value) => writeText(key, JSON.stringify(value));

/** Forget a key. */
export function removeKey(key) {
  try {
    store()?.removeItem(key);
  } catch { /* nothing to do about it and nothing depends on it */ }
}
