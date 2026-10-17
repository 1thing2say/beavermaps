// Where keyboard focus goes, and what a list says when it has nothing to say.
//
// Two bugs, one shape. Picking a search result called `blur()` on the field,
// and closing a card emptied the panel the focused Close button lived in — and
// in both cases a keyboard or screen reader user was put back on <body>, at
// the top of the document, with no word about where the thing they had just
// asked for had gone. And a typed query that matched nothing closed the list,
// which looks exactly like a list that has not caught up yet.
//
// Run against the real src/search-box.js and src/building-popup.js over a
// fake DOM that is a little richer than test/fake-dom.js — these need
// attributes, focus and `closest`, which nothing else under test has wanted.
// It is built here rather than added there so the shared one stays the sixty
// lines it argues for; when a second suite needs focus it should move.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { element } from './fake-dom.js';

// src/search-box.js imports rooms.json the way Vite allows, without an import
// attribute, and Node refuses JSON that does not say `with { type: 'json' }`.
// Loading the file as a module whose default export is that JSON is what Vite
// does with it anyway, and doing it here is narrower than teaching the source
// a syntax nothing else that imports it needs.
registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.json')) {
      const json = readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', source: `export default ${json};`, shortCircuit: true };
    }
    return next(url, context);
  },
});

// -------------------------------------------------------------- the fake DOM

let doc;

/** fake-dom's element, plus attributes, focus, `closest` and visibility. */
function node(className = '', tag = 'div', id = '') {
  const el = element(className, tag);
  const attrs = new Map();
  el.id = id;
  el.value = '';
  el.visible = true;
  el.setAttribute = (name, value) => attrs.set(name, String(value));
  el.getAttribute = (name) => (attrs.has(name) ? attrs.get(name) : null);
  el.removeAttribute = (name) => attrs.delete(name);
  el.hasAttribute = (name) => attrs.has(name);
  el.scrollIntoView = () => {};
  // A browser ignores focus() on an element it is not drawing, without a
  // word, and that silence is the bug this file had to learn about the hard
  // way: see 'picking a result…' below. So the fake ignores it too.
  el.focus = (options) => {
    if (!rendered(el)) return;
    doc.activeElement = el;
    el.focusOptions = options;
  };
  el.blur = () => { if (doc.activeElement === el) doc.activeElement = doc.body; el.blurred = true; };
  el.contains = (other) => other === el || [...el.descendants()].includes(other);
  el.closest = (selector) => {
    for (let at = el; at; at = at.parent) if (matches(at, selector)) return at;
    return null;
  };
  el.matches = (selector) => matches(el, selector);
  el.getClientRects = () => (rendered(el) ? [{}] : []);
  Object.defineProperty(el, 'isConnected', {
    get() {
      let at = el;
      while (at.parent) at = at.parent;
      return at === doc.body;
    },
  });
  // A real event's preventDefault, and listeners that get the event.
  el.dispatch = (type, extra = {}) => {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    (el.listeners.get(type) ?? []).forEach((fn) => fn(event));
    return event;
  };
  return el;
}

/**
 * Whether the browser would be drawing this: it and every box around it.
 *
 * `visible` is the fake's stand-in for the stylesheet, which this DOM does not
 * have — false is display:none from whatever rule would say so.
 */
function rendered(el) {
  for (let at = el; at; at = at.parent) if (at.visible === false) return false;
  return true;
}

/** Just enough selector: `.class`, `#id`, a tag list, and `[role="…"]`. */
function matches(el, selector) {
  return selector.split(',').map((s) => s.trim()).some((one) => {
    if (one.startsWith('.')) return el.classList.contains(one.slice(1));
    if (one.startsWith('#')) return el.id === one.slice(1);
    const role = one.match(/^\[role="([^"]+)"\]$/);
    if (role) return el.getAttribute?.('role') === role[1];
    return el.tag === one;
  });
}

function makeDocument() {
  const body = node('', 'body');
  doc = {
    body,
    activeElement: body,
    createElement: (tag) => node('', tag),
    getElementById: (id) => [...body.descendants()].find((el) => el.id === id) ?? null,
    querySelector: (selector) => {
      // "#place-panel .g-panel-title" is the one descendant selector used.
      const [outer, inner] = selector.split(' ');
      const scope = inner ? doc.querySelector(outer) : body;
      if (!scope) return null;
      return [...scope.descendants()].find((el) => matches(el, inner ?? outer)) ?? null;
    },
  };
  globalThis.document = doc;
  return doc;
}

/** The markup createSearchBox looks up, shaped the way index.html has it. */
function page() {
  makeDocument();
  const add = (parent, className, tag, id) => {
    const el = node(className, tag, id);
    parent.appendChild(el);
    return el;
  };
  const input = add(doc.body, 'g-search-input', 'input', 'place-search');
  input.setAttribute('role', 'combobox');
  const results = add(doc.body, 'g-results hidden', 'ul', 'place-results');
  const clear = add(doc.body, 'g-search-clear hidden', 'button', 'place-clear');
  const shortcuts = add(doc.body, 'g-shortcuts hidden', 'div', 'place-shortcuts');
  const status = add(doc.body, 'sr-only', 'div', 'sr-status');
  const panel = add(doc.body, 'g-card g-panel hidden', 'div', 'place-panel');
  const searchGo = add(doc.body, 'g-search-icon', 'button', 'search-go');
  const endInput = add(doc.body, 'g-endpoint-input', 'input', 'end-coord');
  endInput.setAttribute('role', 'combobox');
  const endList = add(doc.body, 'g-results g-endpoint-results hidden', 'ul', 'end-results');
  return { input, results, clear, shortcuts, status, panel, searchGo, endInput, endList };
}

const FEATURES = [
  { properties: { name: 'Library', description: 'Books.' }, geometry: { coordinates: [-121.35, 38.65] } },
  { properties: { name: 'Student Center', description: 'Food.' }, geometry: { coordinates: [-121.351, 38.651] } },
];

async function searchBox(dom, { openPlace = () => {} } = {}) {
  const { createSearchBox } = await import('../src/search-box.js');
  const opened = [];
  const box = createSearchBox({
    places: () => ({ features: FEATURES }),
    directory: () => null,
    afterExit: (_el, empty) => empty(),
    openPlace: (place) => {
      opened.push(place);
      // What main.js's openPlace ends in: a card with an <h2> in the panel.
      const heading = node('g-panel-title', 'h2');
      heading.tabIndex = -1;
      dom.panel.replaceChildren(heading);
      dom.panel.classList.remove('hidden');
      // ...in a column that does not show it yet. The panel is open but not
      // `data-front`, which src/input.css draws as display:none, and
      // src/sheet-stack.js only marks it front from a MutationObserver — a
      // microtask, after the task that opened it has finished. Queued the same
      // way here so the fake gets the order the browser does.
      dom.panel.visible = false;
      queueMicrotask(() => { dom.panel.visible = true; });
      openPlace(place);
    },
    directoryRow: () => null,
    buildingSub: () => null,
    measureFrom: () => [-121.35, 38.65],
    setStatus: () => {},
  });
  box.buildIndex();
  return { box, opened };
}

function type(input, text) {
  input.value = text;
  input.dispatch('input');
}

// --------------------------------------------------------------- the search

test('a typed query that matches nothing says so, in a row that cannot be picked', async () => {
  const dom = page();
  const { opened } = await searchBox(dom);

  // Markup in the query, to show it lands as text rather than as markup.
  type(dom.input, '<b>zzqx');

  assert.equal(dom.results.classList.contains('hidden'), false, 'the list stays open');
  assert.equal(dom.results.children.length, 1);
  const [row] = dom.results.children;
  assert.equal(row.className, 'g-result-empty');
  assert.equal(row.textContent, 'No results for “<b>zzqx”');
  assert.equal(row.innerHTML, '', 'never written as markup');
  assert.equal(row.getAttribute('aria-disabled'), 'true');
  assert.equal(row.getAttribute('role'), 'option');
  assert.equal(dom.input.getAttribute('aria-expanded'), 'true');
  assert.equal(dom.input.hasAttribute('aria-activedescendant'), false);

  // Nothing on the keyboard reaches it...
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) dom.input.dispatch('keydown', { key });
  // ...and a press on it neither picks anything nor lets the field blur.
  assert.equal(row.dispatch('mousedown').defaultPrevented, true);
  assert.deepEqual(opened, []);

  assert.equal(dom.status.textContent, 'No results');
});

test('an empty field still closes the list rather than saying nothing matched', async () => {
  const dom = page();
  await searchBox(dom);
  type(dom.input, 'zzqx');
  type(dom.input, '   ');
  // Whitespace normalises to nothing: there was no query to have failed.
  assert.equal(dom.results.classList.contains('hidden'), true);
  assert.equal(dom.results.children.length, 0);
  assert.equal(dom.input.getAttribute('aria-expanded'), 'false');
});

test('a query that matches is announced as a count, not read out row by row', async () => {
  const dom = page();
  await searchBox(dom);
  type(dom.input, 'library');
  assert.equal(dom.status.textContent, '1 result');
  assert.equal(dom.results.children[0].getAttribute('role'), 'option');
  assert.equal(dom.results.children[0].className, '');
});

// A turn of the event loop, and then some: what anything deferred with
// setTimeout(…, 0) has had time to do.
const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });

test('picking a result puts focus on the card it opened, not on <body>', async () => {
  const dom = page();
  const { opened } = await searchBox(dom);
  dom.input.focus();
  type(dom.input, 'library');
  dom.input.dispatch('keydown', { key: 'Enter' });

  assert.equal(opened.length, 1);
  assert.equal(opened[0].name, 'Library');
  // The field lets go at once — that is what puts a phone's keyboard down —
  // whether or not the card is on screen yet.
  assert.equal(dom.input.blurred, true);
  assert.notEqual(doc.activeElement, dom.input);

  // And the heading takes focus once the stack has brought the card to the
  // front, which a focus() on the same line as the open could not.
  await tick();
  const heading = dom.panel.children[0];
  assert.equal(doc.activeElement, heading, 'focus is on the card heading');
  assert.deepEqual(heading.focusOptions, { preventScroll: true });
});

test('a pick does not take focus back from wherever it went in the meantime', async () => {
  const dom = page();
  await searchBox(dom);
  dom.input.focus();
  type(dom.input, 'library');
  dom.input.dispatch('keydown', { key: 'Enter' });
  // Somebody tabbed or tapped somewhere before the turn came round.
  const elsewhere = node('', 'button');
  doc.body.appendChild(elsewhere);
  elsewhere.focus();
  await tick();
  assert.equal(doc.activeElement, elsewhere);
});

test('the route fields show the same row and cannot pick it', async () => {
  const dom = page();
  const { box } = await searchBox(dom);
  const picks = [];
  box.wireEndpointField({
    input: dom.endInput,
    list: dom.endList,
    offerHere: false,
    onPick: (...args) => picks.push(args),
  });

  type(dom.endInput, 'zzqx');
  assert.equal(dom.endList.classList.contains('hidden'), false);
  assert.equal(dom.endList.children.length, 1);
  assert.equal(dom.endList.children[0].className, 'g-result-empty');
  assert.equal(dom.endList.children[0].textContent, 'No results for “zzqx”');
  dom.endInput.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  assert.deepEqual(picks, []);
  assert.equal(dom.status.textContent, 'No results');

  // And an empty field closes, as it always did.
  type(dom.endInput, '');
  assert.equal(dom.endList.classList.contains('hidden'), true);
});

test('focusing a route field that holds something nobody typed opens no "No results" row', async () => {
  const dom = page();
  const { box } = await searchBox(dom);
  box.wireEndpointField({ input: dom.endInput, list: dom.endList, offerHere: false, onPick: () => {} });

  // What src/endpoints.js writes for a dropped-pin destination.
  for (const held of ['38.5612, -121.4234', 'Dropped pin']) {
    dom.status.textContent = '';
    dom.endInput.value = held;
    dom.endInput.dispatch('focus');
    assert.equal(dom.endList.classList.contains('hidden'), true, `closed for ${held}`);
    assert.equal(dom.endList.children.length, 0);
    assert.equal(dom.endInput.getAttribute('aria-expanded'), 'false');
    assert.equal(dom.status.textContent, '', 'nothing announced on focus');
  }

  // Typing the same text is a query, and does get the row.
  type(dom.endInput, '38.5612, -121.4234');
  assert.equal(dom.endList.children[0]?.className, 'g-result-empty');

  // A held value that IS in the index still opens its suggestions on focus.
  dom.endInput.value = 'Library';
  dom.endInput.dispatch('focus');
  assert.equal(dom.endList.classList.contains('hidden'), false);
  assert.equal(dom.endList.children[0].children[0].textContent, 'Library');
});

// ---------------------------------------------------------------- the card

async function card(dom, { opener }) {
  const { pinCard } = await import('../src/building-popup.js');
  if (opener) opener.focus();
  let closed = 0;
  const built = pinCard(
    { coords: [-121.35, 38.65], kind: 'bike_rack', name: 'Bike rack' },
    {
      onStart: () => {},
      onEnd: () => {},
      // What clearSelection does to the panel: the card leaves the document.
      onClose: () => { closed++; dom.panel.replaceChildren(); dom.panel.classList.add('hidden'); },
    },
  );
  built.className = 'g-place';
  dom.panel.replaceChildren(built);
  dom.panel.classList.remove('hidden');
  const heading = [...built.descendants()].find((el) => el.classList.contains('g-panel-title'));
  const close = [...built.descendants()].find((el) => el.getAttribute('aria-label') === 'Close');
  return { built, heading, close, closed: () => closed };
}

test('a card heading can take focus from script without becoming a Tab stop', async () => {
  const dom = page();
  const { heading } = await card(dom, {});
  assert.equal(heading.tabIndex, -1);
});

test('Close gives focus back to whatever opened the card', async () => {
  const dom = page();
  const row = node('g-row', 'button');
  doc.body.appendChild(row);
  const { close, closed } = await card(dom, { opener: row });

  close.focus();
  close.dispatch('click');
  assert.equal(closed(), 1);
  await tick();
  assert.equal(doc.activeElement, row);
});

test('Close never sends focus back into a text field, which would reopen its list', async () => {
  const dom = page();
  const { close } = await card(dom, { opener: dom.input });
  close.focus();
  close.dispatch('click');
  await tick();
  assert.equal(doc.activeElement, dom.searchGo, 'the search button, not the field');
});

test('Close falls back to the search button when the opener has gone', async () => {
  const dom = page();
  const row = node('g-row', 'button');
  doc.body.appendChild(row);
  const { close } = await card(dom, { opener: row });
  row.remove();
  close.focus();
  close.dispatch('click');
  await tick();
  assert.equal(doc.activeElement, dom.searchGo);
});

test('Close does not take focus that was never in the card', async () => {
  const dom = page();
  const elsewhere = node('', 'button');
  doc.body.appendChild(elsewhere);
  const { close, closed } = await card(dom, {});
  elsewhere.focus();
  // A pointer press in Safari, which does not focus the button it presses.
  close.dispatch('click');
  await tick();
  assert.equal(closed(), 1);
  assert.equal(doc.activeElement, elsewhere);
});
