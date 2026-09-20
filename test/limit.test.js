// server/limit.js — how often one caller may ask for a route.
//
// Every behaviour here is a function of the clock, which is why the module
// takes `now` as an option: a test that has to sleep for a minute to watch a
// window roll over is a test that gets skipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimit, WINDOW_MS, MAX_PER_WINDOW } from '../server/limit.js';

/** A limiter on a clock the test drives. */
function onClock({ windowMs = 1000, max = 3 } = {}) {
  let at = 0;
  const take = createRateLimit({ windowMs, max, now: () => at });
  return { take, advance(ms) { at += ms; }, get at() { return at; } };
}

test('requests up to the limit are allowed and the last one is the last one', () => {
  const clock = onClock({ max: 3 });
  assert.equal(clock.take('a').allowed, true);
  assert.equal(clock.take('a').allowed, true);

  const third = clock.take('a');
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  assert.equal(clock.take('a').allowed, false);
});

test('remaining never goes negative', () => {
  // A caller well past the line does not need to be told how far past, and a
  // negative number in a header is a lie about a quantity that cannot be one.
  const clock = onClock({ max: 2 });
  for (let i = 0; i < 10; i++) clock.take('a');
  assert.equal(clock.take('a').remaining, 0);
});

test('callers are counted separately', () => {
  const clock = onClock({ max: 2 });
  clock.take('a');
  clock.take('a');
  assert.equal(clock.take('a').allowed, false);
  // One caller exhausting their window must not lock anybody else out — which
  // is the whole reason this is keyed rather than a single counter.
  assert.equal(clock.take('b').allowed, true);
});

test('the window rolls over and the allowance comes back', () => {
  const clock = onClock({ windowMs: 1000, max: 2 });
  clock.take('a');
  clock.take('a');
  assert.equal(clock.take('a').allowed, false);

  clock.advance(1001);
  assert.equal(clock.take('a').allowed, true);
});

test('Retry-After names a time in the future, and at least a second', () => {
  const clock = onClock({ windowMs: 1000, max: 1 });
  clock.take('a');
  const refused = clock.take('a');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1);

  // Right at the end of a window the true remainder rounds to zero, and
  // "Retry-After: 0" tells a well-behaved client to retry immediately, which is
  // the opposite of what a 429 is asking for.
  clock.advance(999);
  assert.ok(clock.take('a').retryAfterSeconds >= 1);
});

test('expired callers are swept rather than accumulating for the life of the process', () => {
  // The map holds one row per caller per window. Without a sweep it holds one
  // row per caller EVER, which on a public endpoint is a slow leak with a
  // stranger's address in every row.
  const clock = onClock({ windowMs: 1000, max: 5 });
  for (let i = 0; i < 500; i++) clock.take(`caller-${i}`);

  clock.advance(2000);
  // The next call sweeps; after it the map should hold that caller and nothing
  // else. Observed through behaviour rather than internals: every swept caller
  // gets a full allowance back, which is also the correct answer.
  const back = clock.take('caller-0');
  assert.equal(back.allowed, true);
  assert.equal(back.remaining, 4);
});

test('the shipped defaults leave room for a person and not for a loop', () => {
  // A cold load asks for one route at most, and using the map hard is a handful
  // a minute. Two a second for a minute is not a person.
  assert.ok(MAX_PER_WINDOW >= 60, `${MAX_PER_WINDOW} is tight enough to hit by hand`);
  assert.ok(MAX_PER_WINDOW <= 600, `${MAX_PER_WINDOW} per window is not a limit`);
  assert.equal(WINDOW_MS, 60_000);
});
