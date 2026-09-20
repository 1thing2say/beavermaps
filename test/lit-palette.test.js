// src/lit-palette.js — the palette moved to the time of day.
//
// Three rules that were unreachable inside startApp(), because this had to be
// declared above the map constructor and closed over five variables:
//
//   the sky decides the preset, not the theme. `colors.lightPreset` is the
//   theme's opinion — light means day, dark means night — which is a statement
//   about the chrome and left the map in broad daylight at eleven at night.
//
//   the bench outranks the sky, but only when it is open and has an opinion.
//
//   and neither of them applies when the ground cannot follow. Google's tiles
//   are a raster that arrives already lit, so relighting ours alone is the seam
//   rather than the fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLitPalette } from '../src/lit-palette.js';
import { palette, followsClock } from '../src/palette.js';
import { lightPresetAt } from '../src/daylight.js';

const CENTRE = [-121.34638, 38.64916];

function make({ provider = 'mapbox', basemap = 'standard', theme = 'light',
  skin = 'classic', bench = null, relight = () => {}, clock } = {}) {
  return createLitPalette({
    centre: CENTRE,
    provider: () => provider,
    basemap: () => basemap,
    theme: () => theme,
    skin: () => skin,
    bench: () => bench,
    relight,
    ...(clock ? { setTimer: clock.set, clearTimer: clock.clear } : {}),
  });
}

/** A scheduler that holds one pending callback and fires it on demand. */
function fakeClock() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    set: (fn, ms) => { pending.set(next, { fn, ms }); return next++; },
    clear: (id) => pending.delete(id),
    /** Fire everything currently pending, once. Callbacks may schedule more. */
    fire() {
      const now = [...pending.entries()];
      for (const [id, entry] of now) {
        pending.delete(id);
        entry.fn();
      }
      return now.length;
    },
  };
}

test('the preset comes from the sun, not from the theme', () => {
  // The bug this closes: the light theme said "day" at eleven at night.
  const sky = make();
  assert.equal(sky.clockPreset(), lightPresetAt(new Date(), CENTRE[0], CENTRE[1]));
  assert.ok(['dawn', 'day', 'dusk', 'night'].includes(sky.clockPreset()));
});

test('the theme does not move the preset', () => {
  assert.equal(make({ theme: 'light' }).clockPreset(), make({ theme: 'dark' }).clockPreset());
});

test('a bench with an opinion outranks the sky', () => {
  for (const preset of ['dawn', 'day', 'dusk', 'night']) {
    assert.equal(make({ bench: { preset } }).wantedPreset(), preset);
  }
});

test('a bench set to auto defers to the sky', () => {
  // `auto` is the bench saying it has nothing to add, not a fifth preset.
  const sky = make({ bench: { preset: 'auto' } });
  assert.equal(sky.wantedPreset(), sky.clockPreset());
});

test('a shut bench defers to the sky', () => {
  // With the menu shut the app is exactly the app.
  const sky = make({ bench: null });
  assert.equal(sky.wantedPreset(), sky.clockPreset());
});

test('the palette is moved under the preset when the ground can follow', () => {
  assert.ok(followsClock('mapbox'), 'test premise: Mapbox follows the clock');
  const sky = make({ provider: 'mapbox', bench: { preset: 'night' } });
  const base = palette('mapbox', 'standard', 'light', 'classic');
  const lit = sky.litPalette();

  // `lightPreset` is the THEME's opinion and stays as it was — it is what the
  // Standard config key is set from. What `underPreset` moves is the colours,
  // which is the half that has to agree with the ground underneath.
  assert.notDeepEqual(lit, base, 'the palette was not moved at all');
  assert.equal(lit.lightPreset, base.lightPreset);
});

test('the palette is left alone when the ground cannot follow', () => {
  // Google's raster arrives already lit. Relighting ours alone is the seam.
  if (followsClock('google')) return;   // the measurement changed; nothing to prove
  const sky = make({ provider: 'google', bench: { preset: 'night' } });
  assert.deepEqual(sky.litPalette(), palette('google', 'standard', 'light', 'classic'));
});

test('every reader gets the same answer for the same inputs', () => {
  // The whole point: a campus drawn at one time of day over a city drawn at
  // another is what this exists to close.
  const sky = make({ bench: { preset: 'dusk' } });
  assert.deepEqual(sky.litPalette(), sky.litPalette());
});

test('the daylight watch reschedules itself rather than polling', () => {
  // A phone should not be woken every minute to be told it is still daytime.
  const clock = fakeClock();
  let relit = 0;
  const sky = make({ relight: () => { relit += 1; }, clock });

  sky.watch();
  assert.equal(relit, 0, 'it relit before the first interval elapsed');
  assert.equal(clock.pending.size, 1, 'nothing was scheduled');

  clock.fire();
  assert.equal(relit, 1, 'the timer never fired');
  // ...and it armed itself again rather than stopping.
  assert.equal(clock.pending.size, 1, 'the watch did not reschedule');

  clock.fire();
  assert.equal(relit, 2);
  sky.stop();
  assert.equal(clock.pending.size, 0, 'stop() left a timer behind');
});

test('the next check is a knowable gap, not a poll', () => {
  // The whole reason this is a self-rescheduling timeout rather than an
  // interval: nextCheckMs returns a minute near a threshold and a quarter of an
  // hour in the middle of the afternoon.
  const clock = fakeClock();
  const sky = make({ clock });
  sky.watch();
  const [{ ms }] = [...clock.pending.values()];
  assert.ok(ms > 0, 'it scheduled for the past');
  assert.ok(ms <= 60 * 60 * 1000, `${ms}ms is longer than an hour`);
  sky.stop();
});

test('watching twice does not leave two timers running', () => {
  // Called on every style load, and two timers would double the wakeups every
  // time the theme was touched.
  const clock = fakeClock();
  const sky = make({ clock });

  sky.watch();
  sky.watch();
  sky.watch();
  assert.equal(clock.pending.size, 1, `${clock.pending.size} timers are armed`);
  sky.stop();
});
