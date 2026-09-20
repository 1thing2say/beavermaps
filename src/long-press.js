// Press and hold, the way Apple Maps does it, rather than on a plain tap.
//
// A tap used to place a start or an end, and it was the wrong gesture for a map
// at this zoom: the two things a finger most wants to do to a campus are "what
// is that" and "get closer", and both of them were spending a route marker to
// find out. Double-tapping to zoom in was actively broken by it — the first tap
// dropped a start point, the second dropped an end point, and the map zoomed
// while drawing a route between two places nobody chose.
//
// Making the deliberate thing deliberate fixes both at once. A tap is now free
// to mean "tell me about this", a double-tap is free to mean "closer", and the
// one gesture that changes state is the one you have to mean.
//
// WHAT THIS MODULE IS, AND IS NOT. It recognises the gesture and draws the ring
// that shows it happening. It has no idea what a hold means — that is `onHold`,
// and in this app it drops a pin, which is four other modules' worth of
// concern. The split is where it is because the recogniser is the half with
// rules worth testing (how far is a drag, how long is a hold, which of six
// events end one) and the half that needs no map to test them.

/** How long the press has to be held. Apple's own is around half a second. */
export const LONG_PRESS_MS = 500;

/**
 * ...and how far the finger may travel first, in px.
 *
 * Generous, because this is competing with dragging the map and the two are
 * told apart by intent rather than by distance: somebody panning moves a long
 * way immediately, and somebody holding still on a phone in one hand wobbles
 * by a few pixels the whole time. Under about 8 the gesture is unusable while
 * walking, which is the condition this app is used in.
 */
export const LONG_PRESS_SLOP = 10;

/** Every way a press can stop being one, other than travelling too far. */
export const CANCEL_EVENTS = ['mouseup', 'touchend', 'touchcancel', 'dragstart', 'zoomstart'];

/**
 * @param {object} deps
 * @param {object} deps.map      the Mapbox map, for its events and its container
 * @param {Function} deps.enabled  whether a hold should be recognised at all
 * @param {Function} deps.onHold   called with the event's lngLat once a hold completes
 */
export function createLongPress({
  map,
  enabled,
  onHold,
  pressMs = LONG_PRESS_MS,
  slop = LONG_PRESS_SLOP,
}) {
  let timer = 0;
  let startedAt = null;
  let swallowClick = false;

  /** The growing ring under the finger. Removed by whichever end comes first. */
  let ring = null;

  function cancel() {
    clearTimeout(timer);
    timer = 0;
    startedAt = null;
    ring?.remove();
    ring = null;
  }

  function begin(e) {
    if (!enabled()) return;
    cancel();
    // A new gesture starts clean. This is also the recovery path for a hold
    // that ended without a click at all — a finger lifted over the sidebar, or
    // outside the window — where the flag would otherwise still be set and
    // would eat the next real tap.
    swallowClick = false;
    startedAt = e.point;

    // Feedback, and it is not decoration: a gesture with no visible response
    // until it has already fired is a gesture nobody discovers. The ring grows
    // for exactly as long as the hold lasts, so the animation IS the progress
    // bar — let go early and you can see you let go early.
    ring = document.createElement('div');
    ring.className = 'g-press-ring';
    ring.style.left = `${e.point.x}px`;
    ring.style.top = `${e.point.y}px`;
    ring.style.animationDuration = `${pressMs}ms`;
    map.getContainer().append(ring);

    timer = setTimeout(() => {
      cancel();
      // Set before the call, not after: what a hold does is asynchronous and
      // the finger comes up long before it settles, so a flag set on the far
      // side of it would be set after the click it exists to swallow.
      //
      // Cleared by that click, or by the next press if none arrives. NOT on a
      // timer — the fire happens while the finger is still down, and there is
      // no upper bound on how long somebody holds it there, so any timeout
      // short enough to be useful is one a slow hand beats.
      swallowClick = true;
      // A hold does not clear a category or open a building the way a tap does
      // — it is a different gesture and means only one thing.
      onHold(e.lngLat);
    }, pressMs);
  }

  map.on('mousedown', (e) => {
    // Left button only. A right-press is the context menu, and on a trackpad a
    // two-finger press arrives here as button 2 while the hand is still.
    if (e.originalEvent.button === 0) begin(e);
  });
  map.on('touchstart', (e) => {
    // One finger. Two is a pinch or a two-finger rotate, and both of those are
    // held still for a moment at the start.
    if (e.points.length === 1) begin(e);
  });

  // Any travel past the slop is a drag, and a drag is panning.
  for (const moved of ['mousemove', 'touchmove']) {
    map.on(moved, (e) => {
      if (!startedAt) return;
      const at = e.point ?? e.points?.[0];
      if (at && Math.hypot(at.x - startedAt.x, at.y - startedAt.y) > slop) cancel();
    });
  }

  // `dragstart` and `zoomstart` are not redundant with the movement test above:
  // a momentum pan or a pinch can move the map without the pointer itself
  // travelling anywhere.
  for (const over of CANCEL_EVENTS) map.on(over, cancel);

  return {
    /**
     * The release at the end of a completed hold. That gesture has already done
     * its work; without this the same finger would drop a route point and then
     * immediately clear the selection on the way back up.
     *
     * Asking consumes the answer, which is why it is a verb.
     */
    consumeClick() {
      if (!swallowClick) return false;
      swallowClick = false;
      return true;
    },
    cancel,
    isPressing: () => startedAt !== null,
  };
}
