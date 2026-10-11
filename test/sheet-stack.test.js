// src/sheet-stack.js — the part the hardware Back listens to.
//
// The stack watches its panels with a MutationObserver, which Node has not got.
// A stand-in that hands the callback back is all it takes: a test hides or
// shows a panel the way the app does, by its class, then delivers the
// observation itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetStack } from '../src/sheet-stack.js';
import { element } from './fake-dom.js';

function withObserver(body) {
  const had = globalThis.MutationObserver;
  let observed = null;
  globalThis.MutationObserver = class {
    constructor(callback) { observed = callback; }
    observe() {}
  };
  try {
    return body(() => observed());
  } finally {
    if (had === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = had;
  }
}

function panel(name, dismissed) {
  const el = element('hidden');
  el.dataset = {};
  return { el, dismiss: () => { dismissed.push(name); el.classList.add('hidden'); } };
}

test('depth changes are announced, and nothing else is', () => {
  withObserver((observe) => {
    const dismissed = [];
    const place = panel('place', dismissed);
    const list = panel('list', dismissed);
    const sheet = element();
    sheet.dataset = {};
    const stack = createSheetStack({ el: sheet, panels: [place, list], enabled: () => true });
    const heard = [];
    stack.onDepth((depth) => heard.push(depth));

    list.el.classList.remove('hidden');
    observe();
    place.el.classList.remove('hidden');
    observe();
    assert.deepEqual(heard, [1, 2]);

    observe();                                   // a class change that opened nothing
    assert.deepEqual(heard, [1, 2]);

    stack.back();                                // the front one, through its own dismiss
    observe();
    assert.deepEqual(dismissed, ['place']);
    assert.deepEqual(heard, [1, 2, 1]);
    assert.equal(stack.depth, 1);
  });
});

test('a listener can stop listening', () => {
  withObserver((observe) => {
    const p = panel('place', []);
    const sheet = element();
    sheet.dataset = {};
    const stack = createSheetStack({ el: sheet, panels: [p], enabled: () => true });
    const heard = [];
    const stop = stack.onDepth((depth) => heard.push(depth));
    stop();
    p.el.classList.remove('hidden');
    observe();
    assert.deepEqual(heard, []);
  });
});
