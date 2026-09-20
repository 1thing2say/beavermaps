// src/pin-choreography.js — the animation driver, and the clamp inside it.
//
// `overFrames` carries a bug fix whose symptom was one console line per layer
// per chip press:
//
//   icon-opacity: 1.0064705882352856 is greater than the maximum value 1
//
// requestAnimationFrame hands its callback the time the FRAME began, which is
// routinely a millisecond or two BEFORE the `performance.now()` read a moment
// earlier in the same function — so the first tick of every run arrived with a
// NEGATIVE progress, `1 - p` came out above one, Mapbox rejected the paint
// property and dropped the frame. Invisible, and noisy in a console somebody
// was reading for real errors.
//
// The fix is one `Math.max`. Inside startApp() it took a map, a style and a
// pointer to reach; here it takes a fake rAF.

import test from 'node:test';
import assert from 'node:assert/strict';
import { overFrames, PIN_FADE_MS, ENTRANCE_START, RETURN_FACTOR } from '../src/pin-choreography.js';

/**
 * A requestAnimationFrame that hands out the times it is told to, in order.
 *
 * `start` is what `performance.now()` answers when the run begins. Passing a
 * first frame time BELOW it is the real case this exists to reproduce.
 */
function fakeFrames(times, start = times[0]) {
  let i = 0;
  const raf = (cb) => {
    const at = times[Math.min(i, times.length - 1)];
    i += 1;
    queueMicrotask(() => cb(at));
  };
  return { raf, now: () => start };
}

test('progress runs 0 to 1 and settles exactly at 1', async () => {
  const seen = [];
  const { raf, now } = fakeFrames([0, 25, 50, 75, 100], 0);
  await overFrames(100, (p) => seen.push(p), { raf, now });

  assert.deepEqual(seen, [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(seen.at(-1), 1, 'it did not settle on the final value');
});

test('a frame time BEFORE the start does not produce a negative progress', async () => {
  // THE BUG. rAF reports when the frame began; `now()` was read after that.
  const seen = [];
  const { raf, now } = fakeFrames([-2, 50, 100], 0);
  await overFrames(100, (p) => seen.push(p), { raf, now });

  assert.equal(seen[0], 0, `first tick was ${seen[0]}`);
  for (const p of seen) {
    assert.ok(p >= 0 && p <= 1, `progress ${p} is outside 0..1`);
  }
});

test('nothing downstream can exceed 1, which is what Mapbox rejected', async () => {
  // The fades are all written as `1 - p`. A negative p is what put 1.0064 into
  // a paint property.
  const opacities = [];
  const { raf, now } = fakeFrames([-3, -1, 40, 100], 0);
  await overFrames(100, (p) => opacities.push(1 - p), { raf, now });
  for (const value of opacities) {
    assert.ok(value >= 0 && value <= 1, `icon-opacity ${value} would be rejected`);
  }
});

test('a frame past the end is clamped rather than overshooting', async () => {
  const seen = [];
  const { raf, now } = fakeFrames([0, 500], 0);
  await overFrames(100, (p) => seen.push(p), { raf, now });
  assert.deepEqual(seen, [0, 1]);
});

test('a superseded run stops asking for frames and never settles', async () => {
  // Legend rows are a column and people press down it. A superseded run is
  // dropped where it stands; see the comment on `generation` for why that
  // promise is safe to leave pending.
  let steps = 0;
  let settled = false;
  const { raf, now } = fakeFrames([0, 25, 50, 75, 100], 0);

  overFrames(100, () => { steps += 1; }, { raf, now, superseded: () => true })
    .then(() => { settled = true; });

  await new Promise((done) => setTimeout(done, 20));
  assert.equal(steps, 0, 'a superseded run painted a frame');
  assert.equal(settled, false, 'a superseded run settled its promise');
});

test('a run superseded part way stops there', async () => {
  let steps = 0;
  let cancelled = false;
  const { raf, now } = fakeFrames([0, 25, 50, 75, 100], 0);

  overFrames(100, () => { steps += 1; if (steps === 2) cancelled = true; },
    { raf, now, superseded: () => cancelled });

  await new Promise((done) => setTimeout(done, 20));
  assert.equal(steps, 2, `ran ${steps} frames after being cancelled`);
});

test('the timings are the ones the stylesheet and the reference agree on', () => {
  // PIN_FADE_MS is the throat-clearing before an answer arrives; too long and
  // the chip feels unresponsive, too short and the swap it exists to separate
  // is back to being one frame.
  assert.ok(PIN_FADE_MS > 80 && PIN_FADE_MS < 400, `${PIN_FADE_MS}ms`);
  // Coming back is slower than going: it re-places forty labels rather than
  // hiding them, and a campus that snaps back on is the jolt the fade avoided.
  assert.ok(RETURN_FACTOR > 1, 'the return is not slower than the departure');
  // Apple's marker is 23px across at rest and 65.9px lifted. Pins that come
  // from nothing borrow that ratio.
  assert.ok(Math.abs(ENTRANCE_START - 23 / 65.9) < 0.005,
    `${ENTRANCE_START} is not the capture's resting-to-settled ratio`);
});
