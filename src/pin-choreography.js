// Clearing the map for an answer.
//
// Pressing a chip is a question, and the map answers it by emptying itself
// first. Every pin on campus goes — the ambient pictograms and the 38 printed
// labels that carry a disc, names included — and then the category's own pins
// arrive on the lift's spring, so the thing you asked for is the only thing
// moving. Swapping the two sets in one frame, which is what this used to do,
// left the answer indistinguishable from the map it landed on: the restrooms
// appeared among forty markers that had not changed.
//
// The two halves are animated by different means, and deliberately:
//
//   OUT is opacity alone, across eight or nine layers. Opacity is a paint
//   property, so it costs a repaint and nothing else. Shrinking these would
//   mean pushing `icon-size` — a LAYOUT property — at every one of them every
//   frame, and re-laying out the whole printed label set to fade it is a bad
//   trade for a 170 ms move nobody is looking at.
//
//   IN is the real thing: size, the sideways settle, and the names. It is one
//   layer holding tens of features, which is what makes the per-frame layout
//   affordable here and not there.
//
// SEPARATED FROM startApp() FOR `overFrames`. That function carries a bug fix
// whose symptom was one console line per layer per press — a negative progress
// on the first tick of every run, because requestAnimationFrame hands its
// callback the time the FRAME began, which is routinely earlier than the
// `performance.now()` read a moment before. The clamp that fixes it is one
// `Math.max` and it had no way of being held to, because the run it lives in
// needed a map, a style and a pointer to reach.

import {
  sizeExpr, sizeAt, CATEGORY_SIZE, growEase, swayAt, scaleStops, GROW_MS, SWAY_MS,
} from './pin-select.js';
import { PIN_BASE_W } from './map-images.js';

/** How long the campus takes to clear. Short: it is the throat-clearing. */
export const PIN_FADE_MS = 170;

/**
 * Where the arriving pins start, as a fraction of full size.
 *
 * The capture's own resting-to-settled ratio: Apple's marker is 23 px across
 * before it is picked up and 65.9 px after. Pins that come from nothing rather
 * than from a marker have no measured start of their own, so they borrow that
 * one and grow through the same proportional range the lift does.
 */
export const ENTRANCE_START = 0.349;

/** Coming back is slower than going: it re-places forty labels rather than hiding them. */
export const RETURN_FACTOR = 1.6;

/**
 * Call `step(0..1)` once a frame for `ms`, unless `superseded()` says stop.
 *
 * Exported on its own because the clamp inside it is the interesting part and
 * nothing else in this module can be reached without a map.
 */
export function overFrames(ms, step, {
  superseded = () => false,
  raf = requestAnimationFrame,
  now = () => performance.now(),
} = {}) {
  return new Promise((resolve) => {
    const started = now();
    const tick = (frameTime) => {
      if (superseded()) return;
      // CLAMPED AT BOTH ENDS, and the lower one is not defensive — it was a
      // bug firing on every chip press. requestAnimationFrame hands its
      // callback the time the FRAME began, which is routinely a millisecond or
      // two BEFORE the `now()` read a moment ago in this function, so the first
      // tick of every run arrived with a negative progress. Downstream that is
      // `1 - p` greater than one, and Mapbox rejected the paint property
      // outright: "icon-opacity: 1.0064705882352856 is greater than the maximum
      // value 1", logged once per layer per press. The frame was simply
      // dropped, so the fade started a frame late — invisible, and noisy in the
      // console for anyone reading it for real errors.
      const p = Math.min(Math.max((frameTime - started) / ms, 0), 1);
      step(p);
      if (p < 1) raf(tick);
      else resolve();
    };
    raf(tick);
  });
}

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.pinLayers      every layer a chip press has to clear
 * @param {Function} deps.paintCategory  the whole of the state change
 * @param {Function} deps.paintPinHover  hand a layer back to the pointer
 */
export function createChoreography({ map, pinLayers, paintCategory, paintPinHover }) {
  /**
   * Bumped to cancel whatever is mid-flight.
   *
   * Legend rows are a column and people press down it. Without this the previous
   * run's next frame lands after the new one has set up — pins at the old
   * opacity, or an `icon-size` from a swap that is already over.
   *
   * A superseded run stops asking for frames and NEVER SETTLES its promise, so
   * the `play*` that awaited it stays suspended for the life of the page. That
   * is deliberate and it is safe, but only for a reason worth stating, because
   * it is a reason a later edit can take away:
   *
   *   the suspended async frame holds the pending promise, the promise holds the
   *   frame's continuation, and — because BOTH call sites launch these
   *   fire-and-forget, awaiting nothing and storing nothing — no root holds
   *   either. An unreachable cycle is a thing a mark-and-sweep collector takes,
   *   so the pair goes at the next GC.
   *
   * `await swap()` from anywhere reachable, or parking the returned promise in a
   * variable that outlives the run, roots the cycle and turns this into one
   * leaked frame per press. If a caller ever needs to know when the pins have
   * landed, give the cancelled path a settle — resolve it with a `superseded`
   * flag rather than dropping it on the floor — instead of rooting the promise
   * as it stands.
   */
  let generation = 0;

  /**
   * True while the category pins are growing in.
   *
   * The entrance owns `icon-size` on that layer frame by frame, and the pin
   * hover writes the same property. Without this, a pointer resting where the
   * pins land would snap them to full size half way through their arrival. See
   * paintPinHover, which is the only reader.
   */
  let arriving = false;

  /** Asked each time, so a preference changed mid-session takes effect at once. */
  const prefersStill = () =>
    Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  /** Bound to the generation this run started in. */
  const frames = (ms, step) => {
    const mine = generation;
    return overFrames(ms, step, { superseded: () => mine !== generation });
  };

  function setLayerFade(layers, value) {
    for (const layer of layers) {
      // A style swap can take these out from under a run in progress.
      if (!map.getLayer(layer)) continue;
      map.setPaintProperty(layer, 'icon-opacity', value);
      map.setPaintProperty(layer, 'text-opacity', value);
    }
  }

  /**
   * What a layer is drawn at right now, so a fade can start from there.
   *
   * Chips get pressed in quick succession and the run underway is cancelled
   * where it stands, which can be anywhere — pins at 0.4 through an entrance,
   * say. Fading from a hard 1 would snap them to full first and then take them
   * out, a flash in the one place this whole sequence exists to remove.
   */
  const fadeFrom = (layer) => {
    const value = map.getPaintProperty(layer, 'icon-opacity');
    return typeof value === 'number' ? value : 1;
  };

  /** Take the category's own pins out, from wherever they currently are. */
  const fadeOutCategory = (p, wasAt) => {
    if (!map.getLayer('category-pins')) return;
    map.setPaintProperty('category-pins', 'icon-opacity', wasAt * (1 - p));
    map.setPaintProperty('category-pins', 'text-opacity', wasAt * (1 - p));
  };

  /**
   * The category's pins arriving, on the same curve a tapped pin is lifted on.
   *
   * `icon-size` stays a zoom expression the whole way rather than becoming a
   * plain number, because `frameCategory` is flying the camera over exactly
   * these frames — a fixed size would be drawn at the wrong scale the moment the
   * zoom moved under it. The growth is multiplied into the table's stops instead
   * of wrapped around the finished expression; see `scaleStops` for why that is
   * the only form Mapbox will accept.
   *
   * The sway rides `icon-translate`, which is paint and therefore does not enter
   * collision: the settle moves drawn pixels only, and the labels stay where
   * they were placed.
   *
   * A PIN AND ITS NAME COME UP TOGETHER, on one opacity ramp. They did not at
   * first — the names were held back until the growth was nearly over, on the
   * theory that fading them in over a still-changing `icon-size` would make them
   * flicker as the collision boxes resized. That theory was wrong twice. The
   * icons are `icon-allow-overlap`, so they are not in the collision index at
   * all and their size cannot dislodge a label; and the delay was not the 335 ms
   * it looked like on paper. Stacked on the 170 ms clear-out before it and
   * Mapbox's own 300 ms fade for a newly placed symbol after it, the names
   * landed nearly a second behind the discs — long enough to read as a second
   * event rather than as the same one, which is exactly the disorientation the
   * whole sequence is meant to prevent.
   *
   * Every pin swings together. There is no stagger here and it would be a lie if
   * there were: the capture is one marker, so a per-pin delay would be invented
   * rather than measured, and Mapbox cannot vary a layout property per feature
   * without pushing new data on every frame anyway.
   */
  async function entrance() {
    const layer = 'category-pins';
    if (!map.getLayer(layer)) return;

    const base = sizeExpr(CATEGORY_SIZE);
    /** How long the pins and their names take to become visible at all. */
    const APPEAR_MS = GROW_MS * 0.3;

    const settle = () => {
      arriving = false;
      if (!map.getLayer(layer)) return;
      map.setLayoutProperty(layer, 'icon-size', base);
      map.setPaintProperty(layer, 'icon-translate', [0, 0]);
      map.setPaintProperty(layer, 'icon-opacity', 1);
      map.setPaintProperty(layer, 'text-opacity', 1);
      // ...and hand the layer back to the hover, in case the pointer has been
      // sitting where a pin has just landed. A no-op when nothing is hovered.
      paintPinHover(layer);
    };
    if (prefersStill()) { settle(); return; }
    arriving = true;

    // Frame zero, set now rather than on the first callback. `paintCategory`
    // has already pushed the data, so a rAF's worth of delay is a rAF of pins
    // drawn full size — the pop the animation exists to replace.
    map.setLayoutProperty(layer, 'icon-size', sizeExpr(scaleStops(CATEGORY_SIZE, ENTRANCE_START)));
    map.setPaintProperty(layer, 'icon-opacity', 0);
    map.setPaintProperty(layer, 'text-opacity', 0);

    // The sway outlasts the growth by 780 ms, and for all of it the size is a
    // settled 1.0. Pushing that unchanged value at a LAYOUT property anyway is
    // ~47 pointless symbol re-layouts, so the growth stops writing when it stops
    // changing and the rest of the run is paint alone.
    let growing = true;

    // NO MOTION BLUR HERE, and the measurement is the reason rather than the
    // effort — this had a working ghost trail for a while and it was taken out.
    //
    // The debug menu's Trail draws five copies of a moving thing a few
    // milliseconds apart, which needs the thing to move. Built over these pins
    // it was five extra symbol layers over the same source, correct and
    // invisible: sampled over the trail's own 150 ms, the entrance travels
    // 2.2 px. It is a concentric SCALE plus a 2 px settle, so every past copy of
    // a growing disc hides behind the present one.
    //
    // What DOES move is the camera — 162 px over the same 150 ms framing the
    // bike racks, 247 px framing the restrooms, two orders of magnitude past the
    // pins. Feeding that into the ghosts was tried too and it fans the trail out
    // to 92 px, which looks like the effect working and is a lie: when the
    // camera moves the buildings and the roads move with it, so smearing only
    // the pins says the pins are sliding across a map that is holding still.
    // Camera blur is a whole-frame effect or it is nothing, and Mapbox draws to
    // its own canvas and hands out no post-processing hook to apply one with.
    //
    // The other method cannot reach these either. Smear is an SVG filter on a
    // DOM element and these are symbols rasterised into the GL canvas. So the
    // setting drives the lifted pin, where there is 19.9 px of travel in the
    // same window and both methods are plainly visible, and leaves the arrival
    // alone.

    await frames(SWAY_MS, (p) => {
      if (!map.getLayer(layer)) return;
      const ms = p * SWAY_MS;

      if (growing) {
        const done = ms >= GROW_MS;
        const grown = ENTRANCE_START + (1 - ENTRANCE_START) * growEase(Math.min(ms / GROW_MS, 1));
        map.setLayoutProperty(layer, 'icon-size', done ? base
          : sizeExpr(scaleStops(CATEGORY_SIZE, grown)));
        growing = !done;
      }

      // Read per frame rather than captured: `frameCategory` is flying the
      // camera through this, and the swing is a fraction of the pin's width at
      // whatever zoom it is actually being drawn at.
      const width = PIN_BASE_W * sizeAt(CATEGORY_SIZE, map.getZoom());
      map.setPaintProperty(layer, 'icon-translate', [swayAt(ms, width), 0]);
      // One ramp for both, so the pin and its name are one object arriving.
      const appearing = Math.min(ms / APPEAR_MS, 1);
      map.setPaintProperty(layer, 'icon-opacity', appearing);
      map.setPaintProperty(layer, 'text-opacity', appearing);
    });

    // Back to the declarative values, so a later zoom is the expression's job
    // again and nothing is left holding a frame's worth of state.
    settle();
  }

  /**
   * Clear the campus, apply the new selection, then play it in.
   *
   * `paintCategory` is the whole of the state change and stays that way; this
   * only decides what is on screen either side of it. So a run that is cut off
   * part way still leaves the map correct — the filters and the data are set in
   * one go between the two halves, never spread across the animation.
   */
  async function swap() {
    generation += 1;
    const clearing = pinLayers();
    const hadPins = Boolean(map.getLayer('category-pins'));
    const wasAt = hadPins ? fadeFrom('category-pins') : 0;

    if (!prefersStill()) {
      await frames(PIN_FADE_MS, (p) => {
        setLayerFade(clearing, 1 - p);
        // A chip pressed while another is up: its pins are the ones on screen.
        if (hadPins) fadeOutCategory(p, wasAt);
      });
    }

    paintCategory();
    // Filtered out entirely now, so their opacity is only being made ready for
    // whenever the chip is let go of.
    setLayerFade(clearing, 1);
    await entrance();
  }

  /** The way back: the answer goes, and the campus comes up behind it. */
  async function clear() {
    generation += 1;
    const still = prefersStill();

    if (!still && map.getLayer('category-pins')) {
      const wasAt = fadeFrom('category-pins');
      await frames(PIN_FADE_MS, (p) => fadeOutCategory(p, wasAt));
    }

    paintCategory();

    const returning = pinLayers();
    if (!still) {
      // Longer coming back than going, because this one has to re-place forty
      // labels rather than take them away, and a campus that snaps back on is
      // the jolt the fade out was avoiding.
      setLayerFade(returning, 0);
      await frames(PIN_FADE_MS * RETURN_FACTOR, (p) => setLayerFade(returning, p));
    }
    setLayerFade(returning, 1);
  }

  return {
    swap,
    clear,
    /** Read by paintPinHover, which must not fight an arrival for `icon-size`. */
    isArriving: () => arriving,
    prefersStill,
  };
}
