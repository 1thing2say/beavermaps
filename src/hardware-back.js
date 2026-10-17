// The phone's own Back — the Android button, the edge swipe, an installed
// PWA's gesture — walking back through the sheet instead of out of the app.
//
// THE BUG. This app is one page with no routes, so the browser's history has
// exactly one entry for it: the page itself. Open a building, press Back the
// way every Android user does to put a card away, and the browser does what
// Back means to it — it leaves. In a tab that is the previous site; in the
// installed app it is the home screen, with the card, the route and the map
// position all gone. Every native map treats Back as "close what is on top",
// and src/sheet-stack.js already knows what is on top and how to close it:
// `back()` is the same dismiss as the panel's own ×, which is what Escape uses.
//
// WHAT THIS DOES. While anything is open in the sheet there is ONE extra
// history entry above the page — a sentinel, with the same URL, so nothing
// about the address changes and a link copied out of the bar is still the
// link it was. Back takes the sentinel off, which the browser reports as a
// `popstate`; that is our cue to close the front panel, and if something is
// still open underneath it, put a fresh sentinel up for the next press. When
// the last panel closes some other way — its ×, Escape, a tap on the map —
// the sentinel is taken back down with `history.back()`, so the entry is never
// left behind for a later Back to stumble over doing nothing.
//
// ONE, NOT ONE PER PANEL. A stack of entries mirroring the stack of panels
// would have to be kept in step through every way a panel opens and closes —
// six call sites, some of them replacing one panel with another without
// closing anything — and a single missed pop leaves the user pressing Back at
// dead entries. One entry and a re-push after each Back has nothing to keep in
// step: it only needs to know whether the depth is zero.
//
// WHY THE ENTRY UNDERNEATH IS MARKED TOO. A `popstate` also fires for things
// that are not Back from our sentinel: someone typing `#debug` into the bar (a
// fragment navigation, see src/debug.js), or Forward. The entry the sentinel is
// pushed over is stamped with `BASE`, so "Back from the sentinel" is exactly
// "a popstate that lands on BASE while the sentinel was up", and everything
// else is left alone.

const SENTINEL = 'beavermapsSheet';
const BASE = 'beavermapsPage';

/**
 * @param {object} parts
 * @param {{ depth: number, back: () => void, onDepth: (fn: (depth: number) => void) => void }} parts.stack
 *        src/sheet-stack.js's stack, or anything shaped like it
 * @param {History} [parts.history]
 * @param {EventTarget} [parts.target]  where `popstate` is heard — the window
 */
export function createHardwareBack({
  stack,
  history = globalThis.history,
  target = globalThis.window,
}) {
  const stateHas = (key) => Boolean(history.state && history.state[key]);

  // Whether our sentinel is up — pushed, and not yet taken down by Back or by
  // us. A page reloaded with a panel open comes back with no panel open and
  // the sentinel still current; marking it as ours lets the first sync take
  // it down like any other.
  let armed = stateHas(SENTINEL);
  // Set between our own `history.back()` and the `popstate` it causes, which
  // arrives a task later. That popstate is us tidying up, not the user asking
  // to go back, and nothing is pushed until it has landed — a push while a
  // traversal is still in flight would race it.
  let unwinding = false;

  function sync() {
    if (unwinding) return;
    if (stack.depth > 0 && !armed) {
      history.replaceState({ ...history.state, [BASE]: true }, '');
      // No URL argument: the address stays exactly what it was, query and
      // fragment included, so `?debug` and every link copied from the bar
      // survive a panel being open.
      history.pushState({ [SENTINEL]: true }, '');
      armed = true;
    } else if (stack.depth === 0 && armed) {
      armed = false;
      // Only when the sentinel is still the current entry. If the user has
      // navigated past it (a typed fragment), going back would land on the
      // sentinel rather than take it off; it is left to cost one extra press.
      if (stateHas(SENTINEL)) {
        unwinding = true;
        history.back();
      }
    }
  }

  function onPopState(event) {
    if (unwinding) {
      unwinding = false;
      sync();               // anything opened while we were tidying gets its entry now
      return;
    }
    if (!armed || !event?.state?.[BASE]) return;
    // Back, from the sentinel: it is gone, so the next sync puts one up again
    // if there is still something open after this close.
    armed = false;
    stack.back();
    // The close is seen by the stack's MutationObserver a microtask from now,
    // and that is what tells us the new depth. If the close changed nothing —
    // a panel whose dismiss does not hide it — there is no depth change to
    // hear, and the sentinel still has to come back.
    queueMicrotask(sync);
  }

  target.addEventListener('popstate', onPopState);
  stack.onDepth(sync);
  sync();

  return {
    /** For tests: whether the sentinel is up. */
    get armed() { return armed; },
  };
}
