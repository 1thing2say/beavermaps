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
import { snapTo } from '../src/sheet.js';

/** A phone-shaped set: collapsed head, half the screen, most of the screen. */
const DETENTS = [122, 422, 748];
const [REST, HALF, FULL] = DETENTS;

const release = (height, velocity, from = REST) =>
  snapTo({ height, velocity, detents: DETENTS, from });

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
