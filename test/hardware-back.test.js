// src/hardware-back.js — the phone's Back closing the sheet, not the app.
//
// The browser is faked rather than run: what matters is the shape of the
// session history (which entries exist, which one is current, what state each
// carries) and the one asynchronous edge in it — `history.back()` returns at
// once and the `popstate` it causes arrives a task later. The fake keeps both,
// so a test that forgets to wait for the popstate fails here the way the app
// would misbehave on a phone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHardwareBack } from '../src/hardware-back.js';

/** Session history with one entry, the page, and the URL arguments recorded. */
function fakeBrowser(initial = [{ state: null }]) {
  const entries = initial.map((e) => ({ ...e }));
  let index = entries.length - 1;
  const listeners = [];
  const urls = [];
  const fire = () => listeners.forEach((fn) => fn({ state: entries[index].state }));

  const history = {
    get state() { return entries[index].state; },
    pushState(state, _title, url) {
      urls.push(url);
      entries.splice(index + 1);
      entries.push({ state: structuredClone(state) });
      index++;
    },
    replaceState(state, _title, url) {
      urls.push(url);
      entries[index] = { state: structuredClone(state) };
    },
    back() {
      if (index === 0) { browser.left = true; return; }
      index--;
      setTimeout(fire, 0);
    },
  };
  const browser = {
    history,
    target: { addEventListener: (type, fn) => { if (type === 'popstate') listeners.push(fn); } },
    entries,
    urls,
    left: false,
    get index() { return index; },
    /** The user pressing Back: exactly what history.back() does. */
    pressBack: () => history.back(),
    /** A typed `#debug`: a new entry with no state, and a popstate for it. */
    fragment() {
      entries.splice(index + 1);
      entries.push({ state: null });
      index++;
      fire();
    },
  };
  return browser;
}

/**
 * The sheet stack, as far as this module can see it. Depth changes are
 * announced a microtask later, which is when src/sheet-stack.js's
 * MutationObserver hears them.
 */
function fakeStack() {
  const open = [];
  const listeners = [];
  const announce = () => queueMicrotask(() => listeners.forEach((fn) => fn(open.length)));
  const stack = {
    open,
    backs: 0,
    get depth() { return open.length; },
    onDepth: (fn) => listeners.push(fn),
    back() { stack.backs++; open.pop(); announce(); },
    show(name) { open.push(name); announce(); },
    /** Its own × — not through back(). */
    close(name) { open.splice(open.indexOf(name), 1); announce(); },
  };
  return stack;
}

/** Long enough for the microtasks and the popstate's task to have run. */
const settle = () => new Promise((done) => setTimeout(done, 5));

function setup(initial) {
  const browser = fakeBrowser(initial);
  const stack = fakeStack();
  const back = createHardwareBack({ stack, history: browser.history, target: browser.target });
  return { browser, stack, back };
}

test('nothing open, nothing pushed — Back leaves the page as it always did', async () => {
  const { browser } = setup();
  await settle();
  assert.equal(browser.entries.length, 1);
  browser.pressBack();
  assert.equal(browser.left, true);
});

test('the first panel puts one entry up, and the second does not add another', async () => {
  const { browser, stack } = setup();
  stack.show('category');
  await settle();
  assert.equal(browser.entries.length, 2);
  assert.equal(browser.index, 1);

  stack.show('place');
  await settle();
  assert.equal(browser.entries.length, 2, 'one entry per panel is a stack to keep in step');
});

test('Back closes the front panel, then the next, then leaves', async () => {
  const { browser, stack } = setup();
  stack.show('category');
  stack.show('place');
  await settle();

  browser.pressBack();
  await settle();
  assert.deepEqual(stack.open, ['category'], 'Back did not close the card on top');
  assert.equal(browser.index, 1, 'nothing was put back up for the list underneath');

  browser.pressBack();
  await settle();
  assert.deepEqual(stack.open, []);
  assert.equal(browser.index, 0);
  assert.equal(browser.left, false);

  browser.pressBack();
  assert.equal(browser.left, true, 'with the sheet empty, Back is the browser\'s again');
  assert.equal(stack.backs, 2);
});

test('closing with × takes the entry down, without closing anything else', async () => {
  const { browser, stack } = setup();
  stack.show('place');
  await settle();
  stack.close('place');
  await settle();
  assert.equal(browser.index, 0, 'a dead entry was left for the next Back to do nothing with');
  assert.equal(stack.backs, 0, 'tidying up was taken for the user pressing Back');

  // And the next panel gets a fresh one.
  stack.show('category');
  await settle();
  assert.equal(browser.index, 1);
});

test('closing and reopening in a hurry still ends with exactly one entry up', async () => {
  // The reopen lands while our own history.back() is still in flight.
  const { browser, stack } = setup();
  stack.show('place');
  await settle();
  stack.close('place');
  await Promise.resolve();
  await Promise.resolve();
  stack.show('category');
  await settle();
  assert.equal(browser.index, 1);
  assert.equal(browser.entries.length, 2);
  assert.equal(stack.backs, 0);

  browser.pressBack();
  await settle();
  assert.deepEqual(stack.open, []);
});

test('the address is never touched', async () => {
  // No URL argument at all: `?debug`, `#debug` and anything a later version
  // puts in the address survive a panel being open and closed.
  const { browser, stack } = setup();
  stack.show('place');
  await settle();
  browser.pressBack();
  await settle();
  assert.ok(browser.urls.length > 0);
  assert.ok(browser.urls.every((url) => url === undefined), `a URL was written: ${browser.urls}`);
});

test('a typed fragment is not a Back', async () => {
  const { browser, stack } = setup();
  stack.show('place');
  await settle();
  browser.fragment();
  await settle();
  assert.deepEqual(stack.open, ['place'], 'navigating to #debug closed the card');
});

test('a reload with the entry still up takes it down', async () => {
  const { browser, stack } = setup([
    { state: { beavermapsPage: true } },
    { state: { beavermapsSheet: true } },
  ]);
  await settle();
  assert.equal(browser.index, 0);
  assert.equal(stack.backs, 0);
});
