// The one line of text the app speaks in, and the spinner beside it.
//
// "Routing server unreachable", "Tap a building to walk there", "Calculating…",
// "Google basemap unavailable" — all of it arrives at one strip, from twenty-odd
// call sites, and the rules about which sentence wins are not obvious from any
// one of them. They lived in startApp() as three functions and three variables
// with the rules written in prose above each, and prose is where they stayed:
// nothing checked that a refusal actually outranks progress, and the reason
// that rule exists is that it did NOT, and a refused Mapbox token was painted
// over by "Tap a building or press and hold anywhere" twice out of three.
//
// The counting matters just as much. `setBusy` is reference-counted rather than
// a boolean, and a reading of it as a boolean is what put "the spinner is left
// spinning / switched off early" on a list of suspected bugs that it was not
// on. One test settles that permanently.
//
// THE SPINNER ARRIVES AS AN ARGUMENT. src/spinner.js imports spin.css, which
// only Vite can resolve, so importing it here would put a stylesheet in the way
// of every question above — `node --test` stops at `Unknown file extension
// ".css"`. Taking it as a dependency costs one line at the call site and is the
// honest description anyway: what this needs is something that starts an
// indicator and hands back its stopper.

/**
 * What the map is waiting for when it is waiting for nothing.
 *
 * One sentence now rather than two. It used to branch on the virtual location
 * — with a fix on the campus a hold meant "destination", without one it meant
 * "start" — and that branch is gone because the gesture no longer means
 * either: a hold drops a pin, and the pin's card is where you say what you
 * wanted. Which is also why this can finally name the button. The old hint
 * described a two-step positional flow and never mentioned the word
 * "Directions" at all.
 *
 * "Press and hold" rather than "click", and this line is still carrying the
 * whole discoverability of that gesture — see LONG_PRESS_MS in long-press.js.
 * A hold is not a thing anybody tries unprompted on a map they have not used
 * before.
 */
export const IDLE_HINT = 'Tap a building or press and hold anywhere, then press Directions.';

/**
 * @param {object} deps
 * @param {object} deps.text     the paragraph; carries the error class and the rise
 * @param {object} deps.message  the span inside it; carries the words
 * @param {object} deps.busy     the span beside it; holds the spinner
 * @param {Function} deps.onError  make sure the strip is actually on screen
 * @param {Function} deps.spinner  starts an indicator, returns its stopper
 * @param {string} [deps.idle]   the resting sentence
 */
export function createStatusLine({
  text,
  message,
  busy,
  onError,
  spinner,
  idle = IDLE_HINT,
}) {
  /**
   * Whether a refusal is standing.
   *
   * Cleared by any deliberate non-error status, not by a timer: once the app is
   * telling you it is calculating a route, the earlier complaint has been
   * superseded by something you are doing on purpose.
   */
  let problemStanding = false;

  let busyDepth = 0;
  let stopBusy = null;

  function set(sentence, isError = false) {
    problemStanding = isError;
    // The panel starts closed, so an error written into it is an error nobody
    // sees. "Routing server unreachable" and "Google basemap unavailable" are
    // both states where the app looks merely broken until the sentence
    // explaining it is on screen.
    if (isError) onError();
    // A SENTENCE THAT CHANGED HAS TO BE SEEN TO HAVE CHANGED. This line is the
    // app's whole voice, and swapping textContent is invisible as movement, so
    // two problems in a row read as one problem that was there all along. The
    // stylesheet has a three-pixel rise for it; this is what fires it, and only
    // when the words actually differ, or every idle repaint would twitch.
    //
    // Remove, force a reflow, add: the standard restart for an animation that
    // is already on the element, and the same three lines showPlaceCard uses.
    if (message.textContent !== sentence) {
      text.classList.remove('is-fresh');
      void text.offsetWidth;
      text.classList.add('is-fresh');
    }
    message.textContent = sentence;
    // One class rather than the five Tailwind toggles this used to need. The
    // hint's normal and error colours are both stated in the stylesheet, so
    // there is no specificity race between a muted class and a red one.
    text.classList.toggle('is-error', isError);
  }

  /**
   * A message about something the app is doing on its own, rather than about
   * anything you asked it for.
   *
   * Yields to a standing problem, which is the difference between this and
   * `set`. "Loading the campus…" goes up during boot, in a race with every
   * failure the app can report, and it was winning: measured against a refused
   * token at the same origin three times, the refusal survived once and the
   * resting hint won twice, over a map with no ground on it. Holding the flag
   * but writing the text anyway was worse still — the hint was then suppressed
   * correctly and the strip sat on "Loading the campus…" for good, which is a
   * third wrong answer rather than a fix.
   *
   * So: a problem outranks progress. Why the ground is missing is worth more of
   * this one line than the fact that something is still arriving, and the
   * spinner beside it is already saying that much.
   *
   * A route being calculated is NOT this and goes through `set`: you asked for
   * that one, and an answer to what you just did has earned the strip.
   */
  function progress(sentence) {
    if (problemStanding) return;
    set(sentence);
  }

  /**
   * The resting message — what the strip says when nothing is happening and
   * nothing is wrong.
   *
   * The second half of that sentence is the whole point: this is written from
   * two places that both mean "we are ready now", and neither of them has any
   * way of knowing whether something has already failed in a way that being
   * ready does not fix. A black basemap is still black after the campus data
   * lands.
   */
  function rest() {
    if (problemStanding) return;
    set(idle);
  }

  /**
   * The spinner beside the status line.
   *
   * Two things use it and both are network waits with no knowable length: the
   * campus data on the way in, and a route being computed by the server. The
   * text already says what is happening in both cases; what it cannot say is
   * that the app is still TRYING, which is the whole difference between a slow
   * connection and a dead one.
   *
   * REFERENCE-COUNTED RATHER THAN A BOOLEAN, because the two overlap on a cold
   * load: a route asked for before the overlays have landed would otherwise
   * have its spinner switched off by the overlays finishing. Every caller pairs
   * its `setBusy(true)` with a `setBusy(false)` in a `finally`, which is what
   * keeps the count honest across the error paths — including the one where a
   * stale response returns early, which is why that `finally` is unconditional
   * and must stay so.
   */
  function setBusy(on) {
    busyDepth = on ? busyDepth + 1 : Math.max(0, busyDepth - 1);
    const wanted = busyDepth > 0;
    if (wanted === Boolean(stopBusy)) return;
    if (wanted) {
      busy.classList.remove('hidden');
      stopBusy = spinner(busy, { size: 'sm' });
    } else {
      stopBusy();
      stopBusy = null;
      busy.classList.add('hidden');
    }
  }

  return {
    set,
    progress,
    rest,
    setBusy,
    idle,
    /** Whether a refusal is on screen. Read by tests; nothing else needs it. */
    hasProblem: () => problemStanding,
    /** How many waits are outstanding. Read by tests. */
    depth: () => busyDepth,
  };
}
