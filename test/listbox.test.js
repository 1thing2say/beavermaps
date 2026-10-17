// src/listbox.js — the keyboard cursor every results list shares.
//
// The route panel's Start and Destination fields had their own cursor that
// only toggled aria-selected: no aria-activedescendant for a screen reader to
// follow, no scrolling, and no `is-navigating`, which is the class a phone
// needs before it paints the selected row at all. These drive the helper the
// way both fields now do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { element } from './fake-dom.js';
import { markOption, stepOption } from '../src/listbox.js';

/** fake-dom's element with the attribute and scroll calls a listbox makes. */
function node(className = '', tag = 'div') {
  const el = element(className, tag);
  const attrs = new Map();
  el.setAttribute = (k, v) => attrs.set(k, String(v));
  el.getAttribute = (k) => (attrs.has(k) ? attrs.get(k) : null);
  el.removeAttribute = (k) => attrs.delete(k);
  el.scrolled = 0;
  el.scrollIntoView = () => { el.scrolled += 1; };
  return el;
}

function field(count) {
  const input = node('', 'input');
  const list = node('g-results', 'ul');
  list.id = 'start-results';
  list.replaceChildren(...Array.from({ length: count }, (_, i) => {
    const li = node('', 'li');
    li.id = `${list.id}-${i}`;
    return li;
  }));
  return { input, list };
}

const selected = (list) => list.children.map((li) => li.getAttribute('aria-selected'));

test('an arrow press moves the cursor a screen reader and a phone can both see', () => {
  const { input, list } = field(3);
  markOption({ input, list, index: 0 });
  assert.equal(input.getAttribute('aria-activedescendant'), 'start-results-0');
  assert.ok(!list.classList.contains('is-navigating'), 'navigating before any key was pressed');

  const next = stepOption({ input, list, key: 'ArrowDown', from: 0, count: 3 });
  assert.equal(next, 1);
  assert.equal(input.getAttribute('aria-activedescendant'), 'start-results-1');
  assert.deepEqual(selected(list), ['false', 'true', 'false']);
  assert.ok(list.classList.contains('is-navigating'), 'a phone would draw no highlight');
  assert.equal(list.children[1].scrolled, 1, 'the active row was not scrolled into view');
});

test('the cursor wraps at both ends, and up from nothing lands on the last row', () => {
  const { input, list } = field(3);
  assert.equal(stepOption({ input, list, key: 'ArrowDown', from: 2, count: 3 }), 0);
  assert.equal(stepOption({ input, list, key: 'ArrowUp', from: 0, count: 3 }), 2);
  assert.equal(stepOption({ input, list, key: 'ArrowUp', from: -1, count: 3 }), 2);
  assert.equal(stepOption({ input, list, key: 'ArrowDown', from: -1, count: 3 }), 0);
});

test('any other key is left to the caller, and taking the cursor off says so', () => {
  const { input, list } = field(2);
  assert.equal(stepOption({ input, list, key: 'Enter', from: 0, count: 2 }), null);
  assert.ok(!list.classList.contains('is-navigating'));
  markOption({ input, list, index: 1 });
  markOption({ input, list, index: -1 });
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  assert.deepEqual(selected(list), ['false', 'false']);
});
