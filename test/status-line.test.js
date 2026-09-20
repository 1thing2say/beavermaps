// src/status-line.js — the one line the app speaks in.
//
// Two rules live here that were only ever written in prose, and both of them
// exist because the obvious version was shipped first and was wrong.
//
//   A REFUSAL OUTRANKS PROGRESS. "Loading the campus…" raced every failure the
//   app can report and won: measured against a refused Mapbox token three
//   times, the refusal survived once. The map had no ground on it and the strip
//   said "Tap a building or press and hold anywhere".
//
//   THE SPINNER IS COUNTED, NOT SWITCHED. A route asked for during a cold load
//   overlaps the overlays arriving, and a boolean would let whichever finished
//   first put the spinner away while the other was still waiting.
//
// The second one is also a correction to my own reading. A scan of this
// codebase reported that a stale route response would clear the spinner out
// from under a newer in-flight request. It would not — the count is what stops
// that — and the unconditional `setBusy(false)` in that `finally` is correct as
// written. This is the test that says so, rather than a comment claiming it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusLine, IDLE_HINT } from '../src/status-line.js';
import { element, withDocument } from './fake-dom.js';

function harness() {
  const text = element();
  const message = element();
  const busy = element('hidden');
  const spins = { started: 0, stopped: 0 };
  const status = createStatusLine({
    text,
    message,
    busy,
    onError: () => { harnessState.opened += 1; },
    spinner: () => {
      spins.started += 1;
      return () => { spins.stopped += 1; };
    },
  });
  const harnessState = { opened: 0 };
  return { status, text, message, busy, spins, state: harnessState };
}

test('a sentence lands in the strip', () => {
  const h = harness();
  h.status.set('Calculating…');
  assert.equal(h.message.textContent, 'Calculating…');
  assert.equal(h.text.classList.contains('is-error'), false);
});

test('an error is marked as one and forces the panel open', () => {
  // The panel starts closed, so an error written into it is an error nobody
  // sees.
  const h = harness();
  h.status.set('Routing server unreachable', true);
  assert.equal(h.text.classList.contains('is-error'), true);
  assert.equal(h.state.opened, 1, 'the panel was left closed over an error');
});

test('a sentence that changed is made to look changed', () => {
  // Swapping textContent is invisible as movement, so two problems in a row
  // read as one problem that was there all along.
  const h = harness();
  h.status.set('First problem', true);
  assert.equal(h.text.classList.contains('is-fresh'), true);
});

test('a sentence that did not change does not twitch', () => {
  // Otherwise every idle repaint restarts the rise.
  const h = harness();
  h.status.set('Same words');
  h.text.classList.remove('is-fresh');
  h.status.set('Same words');
  assert.equal(h.text.classList.contains('is-fresh'), false);
});

test('a refusal outranks progress', () => {
  const h = harness();
  h.status.set('Google basemap unavailable', true);
  h.status.progress('Loading the campus…');
  assert.equal(h.message.textContent, 'Google basemap unavailable');
});

test('a refusal outranks the resting hint too', () => {
  // Written from two places that both mean "we are ready now", and neither has
  // any way of knowing something has already failed in a way that being ready
  // does not fix. A black basemap is still black after the campus data lands.
  const h = harness();
  h.status.set('Google basemap unavailable', true);
  h.status.rest();
  assert.equal(h.message.textContent, 'Google basemap unavailable');
});

test('a deliberate status clears a standing problem', () => {
  // Once the app is telling you it is calculating a route, the earlier
  // complaint has been superseded by something you are doing on purpose.
  const h = harness();
  h.status.set('Routing server unreachable', true);
  assert.equal(h.status.hasProblem(), true);

  h.status.set('Calculating…');
  assert.equal(h.status.hasProblem(), false);
  h.status.rest();
  assert.equal(h.message.textContent, IDLE_HINT);
});

test('the resting hint names the gesture and the button', () => {
  // This line is carrying the whole discoverability of press-and-hold. A hold
  // is not a thing anybody tries unprompted on a map they have not used before.
  assert.match(IDLE_HINT, /press and hold/i);
  assert.match(IDLE_HINT, /directions/i);
});

// --- the counting ----------------------------------------------------------

test('the spinner starts on the first wait and stops on the last', () => {
  const h = harness();
  h.status.setBusy(true);
  assert.equal(h.spins.started, 1);
  assert.equal(h.busy.classList.contains('hidden'), false);

  h.status.setBusy(false);
  assert.equal(h.spins.stopped, 1);
  assert.equal(h.busy.classList.contains('hidden'), true);
});

test('overlapping waits keep one spinner between them', () => {
  // A route asked for before the overlays have landed. A boolean here would let
  // the overlays finishing switch off the route's spinner.
  const h = harness();
  h.status.setBusy(true);    // overlays
  h.status.setBusy(true);    // route
  assert.equal(h.spins.started, 1, 'it started a second spinner');

  h.status.setBusy(false);   // overlays land first
  assert.equal(h.spins.stopped, 0, 'the route lost its spinner');
  assert.equal(h.busy.classList.contains('hidden'), false);

  h.status.setBusy(false);   // route answers
  assert.equal(h.spins.stopped, 1);
  assert.equal(h.busy.classList.contains('hidden'), true);
});

test('a stale response cannot take a live request\'s spinner', () => {
  // THE ONE THE SCAN GOT WRONG. placeEnd clears its own `setBusy(false)` in an
  // unconditional `finally`, and a stale response returns AFTER that finally
  // has run. Reading it as a boolean makes that look like a bug; the count is
  // what makes it correct.
  const h = harness();
  h.status.setBusy(true);          // request A
  h.status.setBusy(true);          // request B, the newer one
  h.status.setBusy(false);         // A returns late and unwinds its finally
  assert.equal(h.busy.classList.contains('hidden'), false, 'B lost its spinner');
  assert.equal(h.status.depth(), 1);

  h.status.setBusy(false);         // B returns
  assert.equal(h.busy.classList.contains('hidden'), true);
});

test('the count never goes negative', () => {
  // An unpaired stop, from a path that unwound twice. The floor is what keeps
  // the NEXT wait from needing two stops to clear.
  const h = harness();
  h.status.setBusy(false);
  h.status.setBusy(false);
  assert.equal(h.status.depth(), 0);

  h.status.setBusy(true);
  assert.equal(h.spins.started, 1, 'a real wait failed to show a spinner');
  h.status.setBusy(false);
  assert.equal(h.busy.classList.contains('hidden'), true);
});

test('many waits, unwound in any order, leave one spinner and stop it once', () => {
  const h = harness();
  for (let i = 0; i < 8; i++) h.status.setBusy(true);
  assert.equal(h.spins.started, 1);
  for (let i = 0; i < 8; i++) {
    assert.equal(h.busy.classList.contains('hidden'), false, `cleared early at ${i}`);
    h.status.setBusy(false);
  }
  assert.equal(h.spins.stopped, 1);
  assert.equal(h.status.depth(), 0);
});

test('it works without a DOM beyond the three elements it was handed', () => {
  // Nothing here reaches for `document`, which is what lets the whole strip be
  // tested at all.
  withDocument(() => {
    delete globalThis.document;
    const h = harness();
    h.status.set('No document needed');
    h.status.setBusy(true);
    h.status.setBusy(false);
    assert.equal(h.message.textContent, 'No document needed');
  });
});
