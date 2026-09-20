// Where the camera goes, and what it is allowed to put things behind.
//
// Three questions that were answered in three different places and had to agree:
// how much of the canvas the chrome is standing on (viewport.js does that
// arithmetic), whether a point is currently readable, and — if it is not —
// where to fly so that it is. They agree here because `frame` and `reveal` both
// call `inView` with the same padding, which is the bug this arrangement
// closes: a reveal that used one answer and a frame that used another would
// argue, and the visible result is a camera that moves twice for one tap.
//
// THE PADDING IS ASKED, NOT MEASURED, on a phone. See padBelowSheet.

import { padBelowSheet, isVisible } from './viewport.js';

/**
 * The zoom a tap on something is worth, when the camera is moving anyway.
 *
 * The same 17 the search box, the directory and the destination pin already
 * fly to, so choosing a thing lands at one scale however you chose it. A
 * FLOOR, never a set: somebody already at 18.5 looking at a doorway asked for
 * that, and a tap that pulled them back out to 17 would be the map arguing.
 */
export const REVEAL_ZOOM = 17;

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.LngLatBounds  mapboxgl's, for building a fit
 * @param {Function} deps.campusPadding what the open cards are standing on
 * @param {Function} deps.sheetTop      where the sheet's top edge will settle
 * @param {Function} deps.navigating    whether a walk owns the camera
 * @param {Function} deps.categoryHits  what the chip that is up found
 * @param {Function} deps.categoryExtent  the ground that chip outlines, or null
 */
export function createCamera({
  map, LngLatBounds, campusPadding, sheetTop, navigating,
  categoryHits, categoryExtent,
}) {
  function frameCategory() {
    if (categoryHits().length) { frame(categoryHits().map((hit) => hit.coords)); return; }
    // No pins does not mean nothing to show. A category whose source file
    // failed to load still outlines its buildings — the two halves degrade
    // separately — and a press that lit up ground somewhere off screen while
    // the camera sat still would read as a press that did nothing.
    const outlined = categoryExtent();
    if (outlined) frame(outlined, { maxZoom: 17 });
  }

  /**
   * Bring a set of points into view, leaving the camera alone if they already
   * are. Shared by the chips and by the route, which want the same behaviour for
   * the same reason.
   */
  function frame(points, { maxZoom = 18 } = {}) {
    if (points.length < 1) return;

    const pad = viewPadding();
    if (points.every((coords) => inView(coords, pad))) return;

    const bounds = points.reduce(
      (acc, coords) => acc.extend(coords),
      new LngLatBounds(points[0], points[0]),
    );
    map.fitBounds(bounds, { padding: pad, maxZoom, duration: 700 });
  }

  /** Which elements the padding has to clear. The arithmetic is in viewport.js. */
  function viewPadding() {
    const canvas = map.getCanvas();
    return padBelowSheet({
      pad: campusPadding(),
      sheetTop: sheetTop(),
      canvasBottom: canvas.getBoundingClientRect().bottom,
      canvasHeight: canvas.clientHeight,
    });
  }

  /**
   * Is this point somewhere it can be read?
   *
   * In SCREEN PIXELS against the padded rectangle, not with
   * map.getBounds().contains(). Bounds are the whole canvas, the strip behind
   * the sheet and the strip behind the sidebar included, so a point can be
   * inside them and behind a pane of glass — which is how the three bus stops
   * at the west edge once counted as visible while nobody could see them.
   */
  function inView(coords, pad = viewPadding()) {
    const canvas = map.getCanvas();
    return isVisible({
      point: map.project(coords),
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      pad,
    });
  }

  /**
   * The point the map is currently about, so the sheet can ask for it back.
   *
   * Held rather than derived because the sheet moves long after the tap that
   * opened it: a card opens, and some seconds later a finger drags the sheet up
   * over the very thing the card is describing. See the onSettle wired into
   * createSheet.
   */
  let focusPoint = null;

  /**
   * Put a point where it can be seen — and only when it cannot.
   *
   * THE COMPLAINT THIS ANSWERS: tap a pin near the bottom of a phone screen and
   * the card that opens is a sheet climbing to half the viewport, which lands on
   * top of the pin you tapped. The map answered the question by covering the
   * answer.
   *
   * The visible map is not the canvas — it is the canvas less whatever the
   * chrome is standing on, which is exactly what viewPadding computes, so this
   * tests the point against that rectangle in screen pixels rather than against
   * map.getBounds(). Bounds are the whole canvas including the strip behind the
   * sheet, which is the same mistake `frame` documents.
   *
   * ONLY WHEN IT CANNOT, because a camera that recentres on every tap is a
   * camera that walks across the campus a tap at a time and throws away wherever
   * somebody had panned to. Google does not move the map for something already
   * in front of you; neither does this.
   *
   * @param {number[]} coords     lng/lat to keep in view
   * @param {number} options.zoom the least zoom to end at; 0 leaves it alone
   */
  function revealPoint(coords, { zoom = 0 } = {}) {
    // Navigation owns the camera outright — it is easing to the walker's
    // position several times a second, and a reveal would fight it.
    if (!coords || navigating()) return;

    const pad = viewPadding();
    const to = Math.max(map.getZoom(), zoom);

    if (inView(coords, pad) && to === map.getZoom()) {
      // Nothing to reveal, but the chrome may still have changed shape under a
      // camera that was framed around the old one. Only when it actually did:
      // an easeTo to the padding already in force is a 300ms animation to where
      // the map already is, and it would interrupt a pan somebody was in the
      // middle of.
      const now = map.getPadding();
      const moved = ['top', 'bottom', 'left', 'right']
        .some((side) => Math.abs((now[side] ?? 0) - pad[side]) >= 1);
      if (moved) map.easeTo({ padding: pad, duration: 300 });
      return;
    }

    // Centred in the PADDED box, which is what carrying the padding into the
    // move buys: Mapbox puts the centre at the middle of the rectangle left
    // over, so the point lands in the middle of the map you can see rather than
    // in the middle of the map that exists — the second of which is behind the
    // sheet on a phone.
    map.easeTo({ center: coords, zoom: to, padding: pad, duration: 500 });
  }
  return {
    frame,
    viewPadding,
    inView,
    reveal: revealPoint,
    frameCategory,
    /** What a reveal is currently about, and where the sheet re-reveals to. */
    focus: () => focusPoint,
    setFocus: (at) => { focusPoint = at; },
  };
}
