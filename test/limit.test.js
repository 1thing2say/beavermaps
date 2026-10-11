// server/limit.js — how often one caller may ask for a route.
//
// Every behaviour here is a function of the clock, which is why the module
// takes `now` as an option: a test that has to sleep for a minute to watch a
// window roll over is a test that gets skipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimit, clientKey, WINDOW_MS, MAX_PER_WINDOW } from '../server/limit.js';

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

test('a new window sweeps out the callers of the last one', () => {
  // The bound the once-per-window sweep keeps: a row lives one window and waits
  // at most one more for the next sweep.
  const clock = onClock({ windowMs: 1000, max: 5 });
  for (let i = 0; i < 300; i++) clock.take(`early-${i}`);
  clock.advance(1000);
  for (let i = 0; i < 300; i++) clock.take(`late-${i}`);
  assert.equal(clock.take.size, 300, 'the expired window was not swept out');

  // Halfway through: nobody has expired, and nobody live may be dropped.
  clock.advance(500);
  clock.take('now');
  assert.equal(clock.take.size, 301);
});

test('the sweep runs at most once per window, not once per new caller', () => {
  // It walks the whole map. Run on every new key, n new callers in a minute
  // cost n walks of up to n rows; that is the O(n²) this replaced. Observed
  // through the one thing a skipped sweep leaves behind: an expired row that
  // is still there.
  const clock = onClock({ windowMs: 1000, max: 5 });
  clock.take('a');                 // t=0: sweeps (first ever), next due at 1000
  clock.advance(999);
  clock.take('b');                 // t=999: no sweep due; b lives until 1999
  clock.advance(1);
  clock.take('c');                 // t=1000: sweeps, a (until 1000) goes
  assert.equal(clock.take.size, 2);

  clock.advance(999);              // t=1999: b has just expired...
  clock.take('d');                 // ...but the next sweep is not due until 2000
  assert.equal(clock.take.size, 3, 'swept again inside the same window');

  clock.advance(1);                // t=2000: due, and b and c both go
  clock.take('e');
  assert.equal(clock.take.size, 2);
});

test('a full map does not turn new callers away', () => {
  // A cap that refused new keys would hand the endpoint to whoever filled it.
  const clock = onClock({ windowMs: 1000, max: 1 });
  for (let i = 0; i < 20_000; i++) clock.take(`flood-${i}`);
  assert.equal(clock.take('somebody-real').allowed, true);
});

test('clientKey: Fly-Client-IP on Fly, req.ip everywhere else', () => {
  const req = (headers, ip) => ({ ip, get: (name) => headers[name.toLowerCase()] });
  const behindFly = req({ 'fly-client-ip': '203.0.113.7' }, '172.16.0.2');

  assert.equal(clientKey(behindFly, { FLY_APP_NAME: 'beavermaps' }), '203.0.113.7');
  // Off Fly the header is the client's own writing, and is not believed.
  assert.equal(clientKey(behindFly, {}), '172.16.0.2');
  assert.equal(clientKey(behindFly, { FLY_APP_NAME: '' }), '172.16.0.2');
  // On Fly without the header (a health check from inside, say) req.ip stands.
  assert.equal(clientKey(req({}, '172.16.0.2'), { FLY_APP_NAME: 'beavermaps' }), '172.16.0.2');
  assert.equal(clientKey(req({}, undefined), {}), 'unknown');
});

test('the shipped defaults leave room for a person and not for a loop', () => {
  // A cold load asks for one route at most, and using the map hard is a handful
  // a minute. Two a second for a minute is not a person.
  assert.ok(MAX_PER_WINDOW >= 60, `${MAX_PER_WINDOW} is tight enough to hit by hand`);
  assert.ok(MAX_PER_WINDOW <= 600, `${MAX_PER_WINDOW} per window is not a limit`);
  assert.equal(WINDOW_MS, 60_000);
});
