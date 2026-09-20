// src/setup-problem.js — what the app says when it cannot start.
//
// This used to be `console.warn("Please add your Mapbox Access Token…")` with
// the entire application in the `else` branch behind it. Everything after that
// check — the map, the chrome, the search field — is inside the branch that did
// not run, so a deploy with a missing --build-arg produced the blank page
// index.html starts as, and the one sentence explaining it was in a console the
// person holding the phone does not have open.
//
// Same rule these tests hold the other refusals to (basemap-problem.js,
// directions.js): a refusal names the way forward.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenRefusal, showSetupProblem } from '../src/setup-problem.js';

test('a real token is not a problem', () => {
  assert.equal(tokenRefusal('pk.eyJ1IjoiZXhhbXBsZSJ9.abc'), null);
});

test('an absent token is refused, and names where the value comes from', () => {
  for (const nothing of [undefined, '', null]) {
    const said = tokenRefusal(nothing);
    assert.ok(said, `${JSON.stringify(nothing)} produced no message`);
    assert.match(said, /VITE_MAPBOX_TOKEN/);
  }
});

test('an absent token says the token is inlined at BUILD time', () => {
  // The whole of what makes this failure confusing on a deploy: restarting the
  // machine cannot fix it, because the value was baked into the bundle. A
  // message that does not say so sends somebody to restart the machine.
  assert.match(tokenRefusal(undefined), /build.time|build-arg/);
});

test('the placeholder gets its own sentence', () => {
  // "I did the setup step but not the one after it" is a different state from
  // "I never made the file", and it is a state the README's own instructions
  // walk people into.
  const said = tokenRefusal('YOUR_MAPBOX_TOKEN_HERE');
  assert.ok(said);
  assert.match(said, /placeholder/i);
  assert.notEqual(said, tokenRefusal(undefined));
});

// --- putting it on screen ---------------------------------------------------

/** Just enough DOM to see what the renderer did. */
function fakeElement() {
  const node = {
    children: [],
    attributes: {},
    style: { cssText: '' },
    textContent: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
  };
  return node;
}

function withDocument(body) {
  const had = globalThis.document;
  globalThis.document = { createElement: () => fakeElement(), getElementById: () => null };
  try {
    return body();
  } finally {
    if (had === undefined) delete globalThis.document;
    else globalThis.document = had;
  }
}

/** Every string anywhere in the tree, so the message can be looked for. */
function textOf(node) {
  return [node.textContent, ...node.children.map(textOf)].join(' ');
}

test('the message is rendered into the container', () => {
  withDocument(() => {
    const container = fakeElement();
    showSetupProblem('the sky is falling', container);
    assert.equal(container.children.length, 1);
    assert.match(textOf(container.children[0]), /the sky is falling/);
  });
});

test('it REPLACES the container rather than adding to it', () => {
  // There is no degraded mode for this failure — without a token there is no
  // map to put a message on top of. Appending would leave whatever half-built
  // thing was there underneath.
  withDocument(() => {
    const container = fakeElement();
    container.children = [fakeElement(), fakeElement()];
    showSetupProblem('gone', container);
    assert.equal(container.children.length, 1);
  });
});

test('it is announced, not just painted', () => {
  withDocument(() => {
    const container = fakeElement();
    const box = showSetupProblem('gone', container);
    assert.equal(box.attributes.role, 'alert');
  });
});

test('it carries its own colours, because the stylesheet may be what failed', () => {
  withDocument(() => {
    const box = showSetupProblem('gone', fakeElement());
    assert.match(box.style.cssText, /background:/);
    assert.match(box.style.cssText, /font:/);
  });
});

test('no container is not a crash', () => {
  // getElementById returns null in the fake document, which is also what a real
  // one does if index.html ever stops having a #map. A failure handler that
  // throws is worse than no failure handler.
  withDocument(() => {
    assert.doesNotThrow(() => showSetupProblem('gone'));
    assert.equal(showSetupProblem('gone'), null);
  });
});
