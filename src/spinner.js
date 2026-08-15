// The one busy indicator in this app, and where it is allowed to appear.
//
// spin.js draws its rings as twelve absolutely-positioned divs with staggered
// CSS animations rather than as a GIF or an SVG, which is what makes it worth a
// dependency here: every line is a DOM node taking an inline `background`, so a
// spinner can be handed `var(--g-text-dim)` and theme itself along with the rest
// of the chrome. A raster spinner would need a light copy and a dark copy and
// would still be the wrong grey under the Apple skin.
//
// WHEN A SPINNER IS THE RIGHT ANSWER, which is narrower than it looks. A spinner
// says "this is going to take a moment and I cannot tell you how long". That is
// honest for a network round trip whose size we do not know — Google's tiles
// over cellular, a route from the server — and dishonest for anything that
// resolves in one frame, where it appears and disappears as a flicker and reads
// as a fault. Everything that spins in this app is waiting on a network.
//
// The keyframes come from the package's own stylesheet. It has to be imported
// or every line sits at its full opacity and the ring does not turn — the
// animation is the whole of the motion, and spin.js ships it separately.

import { Spinner } from 'spin.js';
import 'spin.js/spin.css';

/**
 * Sizes, as spin.js geometry.
 *
 * Two, because there are two jobs. `sm` sets beside a line of text and is
 * matched to the app's 13px status type; `md` sits alone in the middle of a
 * viewport with nothing to be measured against but the box around it.
 *
 * `width` is line thickness and `length` is how far each line reaches beyond
 * `radius`, so the drawn diameter is 2 * (radius + length + width).
 */
const SIZES = {
  sm: { lines: 12, length: 4, width: 2, radius: 5 },
  md: { lines: 12, length: 7, width: 3, radius: 9 },
};

/** Asked each time, so a preference changed mid-session takes effect at once. */
const prefersStill = () => Boolean(
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
);

/**
 * Start a spinner inside `target`, and hand back the way to stop it.
 *
 * The target needs a positioning context — spin.js places the ring at top/left
 * 50% absolutely — which every caller in this file's neighbours gets from a
 * class rather than from an inline style written here, so the CSS stays in one
 * place.
 *
 * Under `prefers-reduced-motion` the ring is still drawn but is not animated.
 * Removing it entirely would be worse than a still one: the point of the mark
 * is "something is happening here", and somebody who has asked for less motion
 * has not asked for less information.
 *
 * @param {HTMLElement} target
 * @param {object}   [options]
 * @param {'sm'|'md'} [options.size]
 * @param {string}   [options.color] any CSS colour, including a `var()`
 * @returns {() => void} stop, safe to call more than once
 */
export function spin(target, { size = 'md', color = 'var(--g-text-dim)' } = {}) {
  const spinner = new Spinner({
    ...SIZES[size] ?? SIZES.md,
    color,
    // No track behind the lines. spin.js can draw one, and it is the wrong call
    // on both surfaces this appears on: over the flyover's dark viewport a grey
    // track is a visible ring of its own, and beside 13px status text it doubles
    // the mark's weight. The fade animation already carries the rotation.
    fadeColor: 'transparent',
    corners: 1,
    speed: 1.1,
    // The default is 2e9, which would put a busy indicator over every dialog
    // and every Mapbox control on the page. It only ever needs to clear its own
    // container's contents.
    zIndex: 3,
    ...(prefersStill() ? { animation: 'none', speed: 1 } : {}),
  });
  spinner.spin(target);
  return () => spinner.stop();
}

/**
 * A spinner over a whole box, with a word under it, as one removable element.
 *
 * The label is what separates this from `spin` above. A ring alone in a black
 * rectangle is ambiguous — it could be loading, or it could be stuck — and the
 * one place this app uses a full-box spinner is the flyover, where the wait is
 * long enough on a phone connection that saying what is being waited for is
 * worth the line of type.
 *
 * Returns the element rather than inserting it, so the caller decides where in
 * its own card the overlay sits and removes it with `.remove()` like anything
 * else. There is no matching `hide` because there is no state to keep.
 *
 * @param {string} [label] omitted for no caption
 * @returns {HTMLElement}
 */
export function spinnerOverlay(label) {
  const box = document.createElement('div');
  box.className = 'g-spin-overlay';
  const ring = document.createElement('div');
  ring.className = 'g-spin-ring';
  box.append(ring);
  if (label) {
    const text = document.createElement('p');
    text.className = 'g-spin-label';
    text.textContent = label;
    box.append(text);
  }
  // Attached to the ring, which is sized by CSS, rather than to the overlay —
  // centring inside the whole box would put the ring where the caption is.
  const stop = spin(ring, { size: 'md' });
  // Hung on the node so removing the overlay cannot leave twelve animating divs
  // behind. Callers that only ever call `.remove()` get the teardown free.
  box.stop = stop;
  return box;
}
