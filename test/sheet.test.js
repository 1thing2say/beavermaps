// Where a released bottom sheet lands.
//
// The rest of src/sheet.js is pointer plumbing and needs a browser to say
// anything about. This is the part that decides how the thing FEELS, and it is
// arithmetic: given the height the finger let go at, how fast it was moving and
// the three heights the sheet is allowed to rest at, which one does it belong
// to. Every complaint anybody has ever had about a bottom sheet — "it won't
// open", "it snaps back", "it flies past the middle" — is this function.

import test from 'node:test';
import assert from 'node:assert/strict';
import { claims, createSheet, snapTo } from '../src/sheet.js';

/** A phone-shaped set: collapsed head, half the screen, most of the screen. */
const DETENTS = [122, 422, 748];
const [REST, HALF, FULL] = DETENTS;

const release = (height, velocity, from = REST) =>
  snapTo({ height, velocity, detents: DETENTS, from });

// THE HEIGHT A DRAG STARTED FROM IS NOT ONE OF THE DETENTS, quite.
//
// `from` is read off getBoundingClientRect() and the detents are rounded, so on
// a real phone the drag that started exactly at rest starts at 523.28 and rest
// is 523. Both halves of the flick rescue compared the two as if they were the
// same number: the guard never matched, and when it did, indexOf answered -1
// and the step landed on the lowest stop. A sheet thrown open settled shut.

test('a flick out of a detent is rescued even from a fractional height', () => {
  // Straight off a phone: rest measured at 523.28, thrown upward at 0.53px/ms
  // from a height the max-height cap had pinned at rest. Projected it reaches
  // 587, which is nearest rest — so the rescue is the only thing that can carry
  // it, and it has to recognise 523.28 as rest to do so.
  assert.equal(
    snapTo({ height: 523, velocity: 0.53, detents: [523, 748], from: 523.28 }),
    748,
    'a sheet thrown open settled back shut',
  );
  // ...and the same the other way, off the top detent.
  assert.equal(
    snapTo({ height: 748, velocity: -0.53, detents: [523, 748], from: 748.4 }),
    523,
  );
});

test('a fractional start does not invent a step that was not asked for', () => {
  // Slow, so there is no flick to rescue: it lands where it is nearest and the
  // fractional `from` changes nothing.
  assert.equal(
    snapTo({ height: 530, velocity: 0.1, detents: [523, 748], from: 523.28 }),
    523,
  );
});

test('a slow release lands at the nearest detent', () => {
  assert.equal(release(140, 0), REST, 'a sheet barely lifted did not fall back');
  assert.equal(release(300, 0), HALF, 'past the midpoint did not reach half');
  assert.equal(release(410, 0), HALF);
  assert.equal(release(700, 0, HALF), FULL);
});

test('a release is carried by its own speed', () => {
  // 240px short of half, drifting up at 0.3px/ms. Projected 36px it is still
  // nearest rest — this is a drag that was allowed to stop, and it stops.
  assert.equal(release(182, 0.3), REST);
  // The same place, thrown. 0.9px/ms projects 108px and the sheet commits.
  assert.equal(release(290, 0.9), HALF);
});

test('a flick always gets you somewhere', () => {
  // The case a projection alone gets wrong, and the reason `from` is a
  // parameter. A fast short throw off the resting height covers 20px and
  // projects 66 more: nearest is still rest, and a sheet that returns to where
  // it started reads as one that refused the gesture.
  assert.equal(release(142, 0.55), HALF, 'a flick up did not open the sheet');
  // And in the other direction, off the top.
  assert.equal(release(726, -0.55, FULL), HALF, 'a flick down did not close it');
});

test('a flick cannot leave the sheet', () => {
  // There is nothing above full or below rest, and a gesture that asks for one
  // gets the end of the range rather than an undefined height.
  assert.equal(release(748, 2, FULL), FULL);
  assert.equal(release(122, -2, REST), REST);
});

test('two detents that measure the same are one detent', () => {
  // A short screen, or a sheet whose contents already fill half of it: `rest`
  // and `half` can come out within a few pixels of each other, and a sheet with
  // two stops at the same height has a tap that appears to do nothing.
  const squashed = [300, 306, 700];
  const at = (height, velocity) =>
    snapTo({ height, velocity, detents: squashed, from: 300 });
  assert.equal(at(302, 0), 300);
  assert.equal(at(690, 0), 700);
});

test('the detents need not arrive in order', () => {
  // `rest` is measured off the DOM and can exceed `half` — a place card open at
  // the 62dvh cap is taller than half the screen. The sheet still has three
  // stops and they still sort.
  const tall = [523, 422, 748];
  assert.equal(snapTo({ height: 430, velocity: 0, detents: tall, from: 523 }), 422);
  assert.equal(snapTo({ height: 520, velocity: 0, detents: tall, from: 523 }), 523);
});

// ---------------------------------------------------------------------------
// ...and who the gesture belonged to in the first place.
//
// `snapTo` decides where a drag ends. This decides whether there is a drag at
// all, and until it existed as a function the answer was reached twice: once in
// `onMove` for us, and — because a scroller claims a vertical drag at the
// compositor before any handler is consulted — never at all for the browser,
// which took every touch gesture off the sheet and cancelled the pointer. The
// sheet answered a finger nowhere but its 26px grabber.
//
// So the rules are here, one copy, read by both callers. The cases below are
// the four corners of the thing: a scroller at its top, at its bottom, in the
// middle, and not a scroller at all.

/** A sheet holding a long list: 900px of content in a 400px box. */
const LONG = { fromGrip: false, scrolled: 0, room: 500 };
/** ...and one holding less than it can show. */
const SHORT = { fromGrip: false, scrolled: 0, room: 0 };

const down = { dx: 0, dy: 40 };
const up = { dx: 0, dy: -40 };

test('at the top of a long list, down is the sheet and up is the scroller', () => {
  assert.equal(claims({ ...LONG, ...down }), true, 'a full sheet could not be dragged shut');
  assert.equal(claims({ ...LONG, ...up }), false, 'the list could not be scrolled');
});

test('at the bottom of a long list, the two swap over', () => {
  const end = { ...LONG, scrolled: 500 };
  assert.equal(claims({ ...end, ...up }), true);
  assert.equal(claims({ ...end, ...down }), false);
});

test('in the middle of a long list, neither direction is the sheet', () => {
  const mid = { ...LONG, scrolled: 250 };
  assert.equal(claims({ ...mid, ...up }), false);
  assert.equal(claims({ ...mid, ...down }), false);
});

test('a sheet with nothing to scroll takes both directions', () => {
  assert.equal(claims({ ...SHORT, ...up }), true);
  assert.equal(claims({ ...SHORT, ...down }), true);
});

test('the grabber is always the sheet, whatever is under it', () => {
  // The case the grabber exists for: a list scrolled into its middle, where
  // every rule above gives the gesture away.
  const mid = { fromGrip: true, scrolled: 250, room: 500 };
  assert.equal(claims({ ...mid, ...up }), true);
  assert.equal(claims({ ...mid, ...down }), true);
});

test('sideways is never the sheet, not even off the grabber', () => {
  // The shortcut shelf across the sheet's head scrolls horizontally, and it
  // sits close enough to the grabber that a flick along it can start inside
  // one. Either way it has to reach the browser: the sheet has no answer for a
  // sideways drag, and swallowing one stops the chips moving.
  assert.equal(claims({ ...SHORT, dx: 40, dy: 4 }), false);
  assert.equal(claims({ fromGrip: true, scrolled: 0, room: 0, dx: -40, dy: 4 }), false);
  // Equal parts is not sideways: a diagonal drag on a sheet that owns both
  // directions is still a drag on the sheet.
  assert.equal(claims({ ...SHORT, dx: 20, dy: 20 }), true);
});

test('the first move of a gesture is only a pixel or two', () => {
  // This is asked before START, on whatever the first touchmove reports, so it
  // has to answer off numbers far too small to threshold.
  assert.equal(claims({ ...LONG, dx: 0, dy: 1 }), true, 'a downward gesture was given away');
  assert.equal(claims({ ...LONG, dx: 1, dy: -1 }), false);
});

// ---------------------------------------------------------------------------
// The sheet itself, driven through its own listeners.
//
// Not a browser — nothing here lays anything out — but a browser's one rule
// that matters to what follows is small enough to state: a box's scrollTop is
// clamped to how far it can scroll, and that is decided at layout, which is
// whenever something asks how big the box is. `measure` makes the sheet
// briefly its resting self to ask exactly that, so this is the rule that
// threw a scrolled sheet back to its top on every press.
// ---------------------------------------------------------------------------

/** A phone: 664px of visible viewport, a sheet 1187px tall when open, 131 at rest. */
function fakeSheet({ scrolled = 0, detent = 'full', height = '568px' } = {}) {
  const listeners = {};
  let scroll = scrolled;
  const captured = [];
  const el = {
    dataset: { detent },
    style: { height },
    classList: { add() {}, remove() {} },
    // What the content measures, which the stylesheet decides per detent.
    get scrollHeight() { return el.dataset.detent === 'rest' ? 131 : 1187; },
    get clientHeight() { return el.style.height ? parseFloat(el.style.height) : 131; },
    get scrollTop() { return scroll; },
    set scrollTop(v) { scroll = v; layout(); },
    getBoundingClientRect() {
      layout();
      return { height: el.clientHeight, top: 664 - el.clientHeight, bottom: 664 };
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    setPointerCapture(id) { captured.push(id); },
  };
  function layout() {
    scroll = Math.max(0, Math.min(scroll, el.scrollHeight - el.clientHeight));
  }
  const gripNode = {};
  const grip = {
    contains: (node) => node === gripNode,
    setAttribute() {},
    addEventListener() {},
  };
  const press = (target = {}) => listeners.pointerdown({
    pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0,
    clientX: 195, clientY: 400, timeStamp: 0, target,
  });
  return { el, grip, gripNode, press, captured };
}

/** Run `body` with a phone-sized `window`, then put back whatever was there. */
function onPhone(body) {
  const had = globalThis.window;
  globalThis.window = { innerHeight: 664, visualViewport: { height: 664 } };
  try { return body(); } finally {
    if (had === undefined) delete globalThis.window; else globalThis.window = had;
  }
}

test('pressing a scrolled sheet leaves it scrolled where it was', () => onPhone(() => {
  // The bug, as measured: full detent, scrolled 420px to the Browse buildings
  // grid, a finger on Library. The press measured the resting sheet — 131px,
  // nothing to scroll — the position clamped to 0, and the tap that finished
  // the press opened Restrooms, which had scrolled in under the finger.
  const { el, grip, press } = fakeSheet({ scrolled: 420 });
  createSheet({ el, grip, enabled: () => true });
  press();
  assert.equal(el.scrollTop, 420, 'the sheet jumped to its top under the finger');
}));

test('the full detent stops below whatever is pinned to the top of the screen', () => onPhone(() => {
  // A notched phone on the home screen: layers and locate pushed down by the
  // 47px inset, ending at 146. The fixed 96px strip put the sheet over both.
  const { el, grip } = fakeSheet({ detent: 'rest', height: '' });
  const sheet = createSheet({ el, grip, enabled: () => true, reserve: () => 156 });
  sheet.apply('full');
  assert.equal(el.style.height, `${664 - 156}px`);
}));

test('with nothing pinned up there, the strip is still the strip', () => onPhone(() => {
  const { el, grip } = fakeSheet({ detent: 'rest', height: '' });
  const sheet = createSheet({ el, grip, enabled: () => true, reserve: () => 0 });
  sheet.apply('full');
  assert.equal(el.style.height, `${664 - 96}px`);
}));

test('a press on the grabber takes the pointer at once', () => onPhone(() => {
  // A mouse has no implicit capture, and the grabber is 26px tall: a quick
  // drag left it on its first move and the sheet never heard the rest.
  const { el, grip, gripNode, press, captured } = fakeSheet();
  createSheet({ el, grip, enabled: () => true });
  press(gripNode);
  assert.deepEqual(captured, [7]);
  // ...and only there. Anywhere else a press may still be a scroll or a tap,
  // and capturing it would take it from whatever it landed on.
  press({});
  assert.deepEqual(captured, [7]);
}));
