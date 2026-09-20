// src/long-press.js — the gesture that replaced tap-to-route.
//
// Four rules, none of which had ever been checked: a hold is half a second, a
// finger may wander ten pixels first, six different events end a press, and the
// click that arrives at the end of a completed hold has to be eaten or the same
// finger drops a pin and then clears it again on the way up.
//
// Timers are mocked. The real thing waits 500 ms per case and there are eleven
// cases here.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLongPress, LONG_PRESS_MS, LONG_PRESS_SLOP, CANCEL_EVENTS,
} from '../src/long-press.js';
import { element, withDocument } from './fake-dom.js';

/** A map that records its handlers so a test can fire them. */
function fakeMap() {
  const handlers = new Map();
  const container = element('map-container');
  return {
    container,
    handlers,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    fire(type, event) {
      (handlers.get(type) ?? []).forEach((fn) => fn(event));
    },
    getContainer: () => container,
  };
}

const mouseDown = (x, y) => ({
  point: { x, y },
  lngLat: { lng: -121.3465, lat: 38.6486 },
  originalEvent: { button: 0 },
});

function harness({ enabled = () => true } = {}) {
  const map = fakeMap();
  const held = [];
  const press = createLongPress({ map, enabled, onHold: (at) => held.push(at) });
  return { map, press, held };
}

/**
 * Run `body` with a fake document and mocked timers.
 *
 * The two tests below that sweep a list call this several times within one
 * test, and mock.timers throws rather than no-opping when it is already on —
 * which is the right call for a test that enables it twice by accident and the
 * wrong one here.
 */
function scene(t, body) {
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
  } catch {
    // Already on, from an earlier pass through the same test.
  }
  return withDocument(() => body(harness()));
}

test('a held press drops a pin where the finger was', (t) => {
  scene(t, (h) => {
    h.map.fire('mousedown', mouseDown(100, 100));
    assert.deepEqual(h.held, [], 'it fired before the hold was complete');

    t.mock.timers.tick(LONG_PRESS_MS);
    assert.equal(h.held.length, 1);
    assert.deepEqual(h.held[0], { lng: -121.3465, lat: 38.6486 });
  });
});

test('letting go early drops nothing', (t) => {
  scene(t, (h) => {
    h.map.fire('mousedown', mouseDown(100, 100));
    t.mock.timers.tick(LONG_PRESS_MS - 50);
    h.map.fire('mouseup');
    t.mock.timers.tick(LONG_PRESS_MS);
    assert.deepEqual(h.held, []);
  });
});

test('a finger that wanders past the slop is panning, not holding', (t) => {
  scene(t, (h) => {
    h.map.fire('mousedown', mouseDown(100, 100));
    h.map.fire('mousemove', { point: { x: 100 + LONG_PRESS_SLOP + 1, y: 100 } });
    t.mock.timers.tick(LONG_PRESS_MS);
    assert.deepEqual(h.held, []);
  });
});

test('a hand that wobbles within the slop is still holding', (t) => {
  // The case the constant exists for: somebody standing still, holding a phone
  // in one hand, moving a few pixels the whole time.
  scene(t, (h) => {
    h.map.fire('mousedown', mouseDown(100, 100));
    for (const [dx, dy] of [[2, 1], [-3, 2], [1, -3], [4, 4]]) {
      assert.ok(Math.hypot(dx, dy) <= LONG_PRESS_SLOP, 'test premise');
      h.map.fire('mousemove', { point: { x: 100 + dx, y: 100 + dy } });
    }
    t.mock.timers.tick(LONG_PRESS_MS);
    assert.equal(h.held.length, 1);
  });
});

test('every cancel event ends a press', (t) => {
  // dragstart and zoomstart are not redundant with the movement test: a
  // momentum pan or a pinch moves the map without the pointer travelling.
  for (const ending of CANCEL_EVENTS) {
    scene(t, (h) => {
      h.map.fire('mousedown', mouseDown(100, 100));
      assert.equal(h.press.isPressing(), true, ending);
      h.map.fire(ending, {});
      assert.equal(h.press.isPressing(), false, `${ending} did not end the press`);
      t.mock.timers.tick(LONG_PRESS_MS);
      assert.deepEqual(h.held, [], `${ending} let the hold fire anyway`);
    });
  }
});

test('a right-press is the context menu, not a hold', (t) => {
  scene(t, (h) => {
    h.map.fire('mousedown', { ...mouseDown(100, 100), originalEvent: { button: 2 } });
    t.mock.timers.tick(LONG_PRESS_MS);
    assert.deepEqual(h.held, []);
  });
});

test('two fingers is a pinch, not a hold', (t) => {
  scene(t, (h) => {
    const two = { points: [{ x: 100, y: 100 }, { x: 140, y: 140 }], lngLat: {} };
    h.map.fire('touchstart', two);
    t.mock.timers.tick(LONG_PRESS_MS);
    assert.deepEqual(h.held, []);

    h.map.fire('touchstart', { points: [{ x: 100, y: 100 }], point: { x: 100, y: 100 }, lngLat: {} });
    t.mock.timers.tick(LONG_PRESS_MS);
    assert.equal(h.held.length, 1);
  });
});

test('the gesture does nothing while it is switched off', (t) => {
  // During navigation, and before the network has landed — there is nothing to
  // snap a dropped pin to until it has.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withDocument(() => {
    const h = harness({ enabled: () => false });
    h.map.fire('mousedown', mouseDown(100, 100));
    t.mock.timers.tick(LONG_PRESS_MS);
    assert.deepEqual(h.held, []);
    assert.equal(h.map.container.children.length, 0, 'it drew a ring anyway');
  });
});

test('the ring grows under the finger for exactly as long as the hold', (t) => {
  // The animation IS the progress bar. If its duration and the timer ever
  // disagree, the ring finishes early and the gesture looks broken.
  scene(t, (h) => {
    h.map.fire('mousedown', mouseDown(220, 140));
    assert.equal(h.map.container.children.length, 1);

    const ring = h.map.container.children[0];
    assert.ok(ring.classList.contains('g-press-ring'));
    assert.equal(ring.style.left, '220px');
    assert.equal(ring.style.top, '140px');
    assert.equal(ring.style.animationDuration, `${LONG_PRESS_MS}ms`);
  });
});

test('the ring is taken down by whichever end comes first', (t) => {
  for (const ending of ['mouseup', 'dragstart']) {
    scene(t, (h) => {
      h.map.fire('mousedown', mouseDown(100, 100));
      h.map.fire(ending, {});
      assert.equal(h.map.container.children.length, 0, `${ending} left the ring up`);
    });
  }
  // ...including a hold that completes.
  scene(t, (h) => {
    h.map.fire('mousedown', mouseDown(100, 100));
    t.mock.timers.tick(LONG_PRESS_MS);
    assert.equal(h.map.container.children.length, 0, 'a completed hold left its ring up');
  });
});

test('the click at the end of a completed hold is swallowed once', (t) => {
  scene(t, (h) => {
    assert.equal(h.press.consumeClick(), false, 'it swallowed a click with no hold behind it');

    h.map.fire('mousedown', mouseDown(100, 100));
    t.mock.timers.tick(LONG_PRESS_MS);

    assert.equal(h.press.consumeClick(), true);
    // Once. A second tap is a real tap.
    assert.equal(h.press.consumeClick(), false);
  });
});

test('a hold that ends without a click does not eat the next real tap', (t) => {
  // A finger lifted over the sidebar, or outside the window: no click arrives,
  // so the flag is still set. The next press is what clears it.
  scene(t, (h) => {
    h.map.fire('mousedown', mouseDown(100, 100));
    t.mock.timers.tick(LONG_PRESS_MS);
    // ...no click...
    h.map.fire('mousedown', mouseDown(300, 300));
    assert.equal(h.press.consumeClick(), false, 'the stale flag ate a real tap');
  });
});

test('the flag is set before the hold runs, not after', (t) => {
  // What a hold does is asynchronous and the finger comes up long before it
  // settles, so a flag set on the far side of it would be set after the click
  // it exists to swallow.
  let atFireTime = null;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withDocument(() => {
    const map = fakeMap();
    const press = createLongPress({
      map,
      enabled: () => true,
      onHold: () => { atFireTime = press.consumeClick(); },
    });
    map.fire('mousedown', mouseDown(100, 100));
    t.mock.timers.tick(LONG_PRESS_MS);
  });
  assert.equal(atFireTime, true);
});
