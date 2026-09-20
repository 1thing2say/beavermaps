// The palette, moved to the time of day — and the timer that keeps it there.
//
// EVERY READER OF THE PALETTE GOES THROUGH HERE rather than calling `palette()`
// directly, because a campus drawn at one time of day over a city drawn at
// another is the bug this exists to close. See `underPreset` in src/palette.js.
//
// ITS OWN MODULE FOR THE TEMPORAL DEAD ZONE. In startApp() this had to sit
// ABOVE the map constructor, because `litPalette` is what hands that
// constructor its style — so every name it touched had to already exist when
// that line ran. Declared any lower they were in the TDZ at first use, which is
// not a warning, it is a blank page. That constraint is gone once the thing is
// a module: it is imported, so it exists before anything in startApp runs.
//
// It is also the one piece of this that is worth a test. "Which preset is the
// sky doing" is arithmetic over the sun's elevation, "does the palette follow
// it" depends on which provider is drawing the ground, and "when do we look
// again" is a schedule — all three are answerable without a map.

import { lightPresetAt, nextCheckMs } from './daylight.js';
import { palette, underPreset, followsClock } from './palette.js';

/**
 * @param {object} deps
 * @param {Array} deps.centre      the campus, for the sun's position
 * @param {Function} deps.provider
 * @param {Function} deps.basemap
 * @param {Function} deps.theme
 * @param {Function} deps.skin
 * @param {Function} deps.bench    the lighting bench, or null when it is shut
 * @param {Function} deps.relight  what to call when the sun has moved
 * @param {Function} [deps.setTimer]   stand-ins for setTimeout/clearTimeout
 * @param {Function} [deps.clearTimer]
 */
export function createLitPalette({
  centre,
  provider,
  basemap,
  theme,
  skin,
  bench,
  relight,
  // Injected rather than reached for, so test/lit-palette.test.js can drive the
  // schedule without a clock. `mock.timers` cannot: this timeout reschedules
  // itself from inside its own callback, which is exactly the shape a tick
  // cannot settle.
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /**
   * Which lighting preset the sky is doing over this campus, right now.
   *
   * Read at every apply rather than captured, and re-applied on a timer — see
   * `watch` — because a map left open through a sunset should follow it rather
   * than hold whatever it was loaded at.
   */
  const clockPreset = () => lightPresetAt(new Date(), centre[0], centre[1]);

  /** What the bench says, if it is open and has an opinion; the sky otherwise. */
  function wantedPreset() {
    const set = bench();
    return set && set.preset !== 'auto' ? set.preset : clockPreset();
  }

  function litPalette() {
    const base = palette(provider(), basemap(), theme(), skin());
    // ...unless nothing on the other side of the move can follow it. Google's
    // ground is a raster and arrives already lit, so relighting ours alone is
    // the seam rather than the fix. See `followsClock` in src/palette.js for
    // the measurement and for what it costs.
    if (!followsClock(provider())) return base;
    return underPreset(base, wantedPreset());
  }

  /**
   * Re-light the map when the sun has moved enough to matter.
   *
   * A self-rescheduling timeout rather than a fixed interval, because the gap to
   * the next possible change is knowable and is usually hours: `nextCheckMs`
   * returns a minute near a threshold and a quarter of an hour in the middle of
   * the afternoon. A phone should not be woken every minute to be told it is
   * still daytime.
   *
   * `relight` is idempotent and cheap when nothing has changed — it pushes the
   * same config value Mapbox already holds — so this does not need to track
   * what the last preset was.
   */
  let daylightTimer = null;
  function watch() {
    clearTimer(daylightTimer);
    daylightTimer = setTimer(() => {
      relight();
      watch();
    }, nextCheckMs(new Date(), centre[0], centre[1]));
  }

  /**
   * Stop watching.
   *
   * Nothing in the app calls this — the watch runs for the life of the page —
   * but a self-rescheduling timeout with no way to cancel it is a thing that
   * outlives whatever started it, and the first test to call `watch` found that
   * out by hanging the test runner.
   */
  function stop() {
    clearTimer(daylightTimer);
    daylightTimer = null;
  }

  return { litPalette, clockPreset, wantedPreset, watch, stop };
}
