/**
 * What a pin does when you tap it.
 *
 * The motion is Apple Maps', measured rather than guessed. A screen capture of
 * their macOS Maps selecting a park was taken apart frame by frame at 60 fps and
 * the marker's width read off each one — the run is in the table below. It grows
 * from the ambient icon to its selected size, OVERSHOOTS by about 7%, and settles
 * back. That overshoot is the whole character of it: a linear or ease-out grow
 * reads as a resize, and the same curve with a bounce reads as something being
 * picked up.
 *
 *   ms      0   17   33   50   83  117  150  183  217  250  283  317  350  450
 *   width  15   21   27   31   35   42   47   51   56   55   59   58   57   56
 *   (px, saturated core only; small icon 15, settled 55.5, peak 59 at 283 ms)
 *
 * FITTING IT TOOK TWO GOES, and the second one is the reason this comment is
 * long. A cubic-bezier interpolates between the size you start at and the size
 * you end at, so the overshoot you SEE is the curve's overshoot scaled by that
 * gap — and our gap is not Apple's. Their ambient icon is 27% of their selected
 * one; ours is 37% of ours, because a 26-unit disc at the sizes this map draws
 * it is proportionally a bigger thing than their POI dot. Fit the curve to
 * their normalised
 * progress and you reproduce their timing exactly while the pin visibly bounces
 * two thirds as far, which is the half of it anyone actually watches.
 *
 * So the fit is against apparent size — width as a fraction of the settled
 * width — with the overshoot constrained to land where theirs lands. Least
 * squares over the control points and the duration then gives
 * `cubic-bezier(0.5, 1.525, 0.5, 1)` over 540 ms: sum of squared error 0.019,
 * tracking their curve within about 0.02 the whole way, and peaking at 1.055x
 * the settled size at 308 ms against their 1.063x at 283 ms.
 *
 * For the record, the two rejected candidates. Fitting normalised progress
 * instead gives `cubic-bezier(0.4, 1.45, 0.85, 1)` over 460 ms, which peaks at
 * only 1.042x — right timing, half the bounce. The stock spring
 * `cubic-bezier(0.34, 1.56, 0.64, 1)` gets the peak height about right by luck
 * and fits the rest of the curve nine times worse (sse 0.174), arriving early
 * and then hanging.
 *
 * The marker this animates is Apple's too — see the block of measured ratios at
 * the top of map-images.js. It was not, at first: the motion was fitted while
 * the map still wore Google's balloon, and a spring measured off one marker
 * driving a different one is the kind of mismatch that reads as "slightly off"
 * without ever saying why.
 *
 * Deselecting is not the same curve backwards. Nothing is being picked up on the
 * way out, so it is shorter and has no bounce — a pin that sprang on the way
 * down would look like it had been dropped rather than put back.
 */

import {
  pinElement, dotGeometry, dotColour, LIFT_ASPECT, LIFT_DOT, LIFT_HEAD, LIFT_TIP,
} from './map-images.js';

/** Fitted to the capture. See the table above. */
export const GROW_MS = 540;
export const GROW_EASE = 'cubic-bezier(0.5, 1.525, 0.5, 1)';
export const SHRINK_MS = 190;
export const SHRINK_EASE = 'cubic-bezier(0.4, 0, 0.7, 1)';

/** The lifted head's width in CSS pixels, ring included. */
export const SELECTED_W = 42;

/**
 * How wide a pin's name may get before it wraps — in EMS, which is Mapbox's
 * unit and, it turns out, the right one.
 *
 * ONE number for both states, and it has to be, because the two are drawn by
 * different engines: the resting name is a Mapbox symbol, the lifted one a DOM
 * node. Left to themselves the symbol wrapped "Drink vending machine" onto two
 * centred lines and the DOM node ran it out on one, so selecting a pin fanned
 * its name out sideways by forty pixels in each direction. The pin never moved;
 * the label did, and that reads as the whole marker sliding.
 *
 * Ems rather than pixels for the second half of the same bug. The lifted label
 * is set larger — Apple's is, measurably: 25 px against the resting 21 — so
 * pinning both to the same PIXEL width still rewrapped it, just onto three
 * lines instead of two. The same em width wraps the same words.
 */
export const LABEL_MAX_EM = 8;
/** That width in CSS pixels, for the DOM label at a given type size. */
export const labelMaxPx = (fontPx) => LABEL_MAX_EM * fontPx;

/** Type size of the lifted label, which the wrap width is derived from. */
export const LABEL_PX = 12;

/**
 * What the caption does while the pin is being picked up.
 *
 * Apple's does not fade. Tracking its bounding box frame by frame through a
 * selection, it is on screen the whole way and does three things at once:
 *
 *     width   87 px -> 100 px      it scales up by 1.15
 *     top     226   -> 217         it rises 9 px, on a 66 px head
 *     ink     #005800 -> #000000   the category green crosses to black
 *
 * The first two run on the same fifteen frames as the head, so the caption is
 * on the pin's spring rather than on a schedule of its own. The colour is not:
 * it holds the category green until frame 88 of 93 and lands black by 91, which
 * is the last fifth of the movement — the name is green while the thing is a
 * marker and black once it is a selection.
 *
 * Ours used to fade in from nothing over the middle of the run, which reads as
 * a second label arriving rather than the same one being lifted.
 */
export const LABEL_START_SCALE = 0.87;
/** How far the caption rises, as a fraction of the selected pin's width. */
export const LABEL_RISE = 0.136;
/** When the ink crosses, as fractions of GROW_MS. */
export const LABEL_INK_DELAY = 0.67;
export const LABEL_INK_SPAN = 0.20;

/**
 * Mapbox's own `text-fade-duration` default, which the caption is cross-faded
 * against.
 *
 * Apple's caption is continuous because it is one object. Ours is two — a
 * symbol rasterised into the GL canvas, and a DOM element that replaces it —
 * and the symbol does not vanish when its filter changes: it fades over this
 * long. Mounting the replacement opaque therefore draws the name twice, very
 * slightly offset, and it reads as "RaRaef Hall" for a fifth of a second.
 *
 * So the caption fades IN over exactly the window the symbol fades OUT, with no
 * delay, which keeps the total ink roughly constant and reads as one label
 * being lifted. That is a different thing from the fade this replaced, which
 * started 160 ms late and left a gap where neither was fully drawn.
 */
export const SYMBOL_FADE_MS = 300;

/**
 * `icon-size` stops, as data rather than as an expression.
 *
 * Both layers interpolate their icon between two zooms, and the selected pin has
 * to START at whatever size the icon it is replacing is being drawn at right
 * now, or the swap is a visible jump before the animation has begun. So the
 * stops are written once here, handed to Mapbox as an expression by `sizeExpr`
 * and evaluated in JS by `sizeAt` — one table, and no way for the two to drift.
 */
export const AMBIENT_SIZE = { 16: 0.54, 19: 0.65 };
export const CATEGORY_SIZE = { 14: 0.72, 19: 0.92 };

/**
 * ...and the disc a building's own name carries.
 *
 * A third table because it is a third layer: 38 of the 49 printed labels get a
 * pictogram, and they are the markers most of the campus is covered in at the
 * zoom it fits the screen at. It is here rather than inline in the layer for
 * the same reason the other two are — `ambientWidth` has to know what size a
 * marker is being drawn at to start its animation from, and a table read in one
 * place and duplicated in the other is how the two silently disagree.
 */
export const LABEL_SIZE = { 15: 0.58, 19: 0.72 };

/** The stops as a Mapbox `interpolate` expression. */
export function sizeExpr(stops) {
  return ['interpolate', ['linear'], ['zoom'], ...Object.entries(stops).flatMap(
    ([zoom, size]) => [Number(zoom), size],
  )];
}

/** The same interpolation, in JS, clamped outside the stops exactly as Mapbox clamps it. */
export function sizeAt(stops, zoom) {
  const points = Object.entries(stops)
    .map(([z, size]) => [Number(z), size])
    .sort((a, b) => a[0] - b[0]);

  if (zoom <= points[0][0]) return points[0][1];
  if (zoom >= points.at(-1)[0]) return points.at(-1)[1];
  for (let i = 1; i < points.length; i += 1) {
    const [z0, s0] = points[i - 1];
    const [z1, s1] = points[i];
    if (zoom <= z1) return s0 + ((s1 - s0) * (zoom - z0)) / (z1 - z0);
  }
  return points.at(-1)[1];
}

/**
 * Mount the selected pin and animate it up.
 *
 * `from` is the width in CSS pixels the ambient icon is currently drawn at, so
 * the element starts life exactly the size of the thing it replaced.
 *
 * The scale goes on an inner element because Mapbox owns the marker's own
 * `transform` — it writes the translate that positions it on every frame of
 * every pan, and anything else put there is gone by the next one.
 *
 * TWO THINGS ANIMATE, not one, and the reason is the shape change underneath.
 * The resting marker is a disc sitting ON the place; the lifted one is a head
 * floating ABOVE it with a dot left behind on the spot. They do not agree about
 * where the head goes, so simply scaling one into the other pops it upward by
 * three quarters of its own width the instant it is tapped.
 *
 *   the DOT IS ITS OWN ELEMENT, and it never transforms at all. It marks the
 *   place; the place does not move. Drawing it inside the head's SVG — which is
 *   what the first cut did — meant the head's travel dragged it 13 px down the
 *   screen and back on every selection.
 *
 *   the HEAD scales about where the dot is (an origin below its own box) and
 *   carries a `translateY` alongside, which starts it exactly where the resting
 *   disc was — on the place — and lifts it to where a lifted head belongs. Both
 *   sit in one transform, so one timing function drives them and the rise
 *   springs with the growth instead of racing it.
 */
export function mountSelectedPin({ map, marker: Marker, kind, coords, label, ink, from }) {
  const el = document.createElement('div');
  el.className = 'pin-selected';

  const height = SELECTED_W * LIFT_ASPECT;
  const scaler = document.createElement('div');
  scaler.className = 'pin-selected-scale';
  // The origin is the dot, which now sits BELOW this element's own box — hence
  // a percentage over 100. Expressed against the head's height, not the whole
  // marker's, because that is the box being scaled.
  scaler.style.transformOrigin = `50% ${((LIFT_DOT.y / LIFT_TIP) * 100).toFixed(2)}%`;
  scaler.append(pinElement(kind, SELECTED_W));

  const start = from / SELECTED_W;
  // How the marker sits while it is still pretending to be the resting disc:
  // scaled down, and pushed far enough DOWN that the head's centre lands on the
  // place rather than floating above it. The gap closes as it grows, which is
  // the head rising off the ground.
  const resting = (scale) =>
    `translateY(${((LIFT_DOT.y - LIFT_HEAD) * height * scale).toFixed(2)}px) scale(${scale})`;
  const LIFTED = 'translateY(0px) scale(1)';
  scaler.style.transform = resting(start);
  el.append(scaler);

  // The dot: placed once, at the place, and left alone.
  const dot = document.createElement('div');
  dot.className = 'pin-selected-dot';
  const g = dotGeometry(SELECTED_W);
  dot.style.width = `${g.size.toFixed(2)}px`;
  dot.style.height = `${g.size.toFixed(2)}px`;
  dot.style.top = `${g.top.toFixed(2)}px`;
  dot.style.marginLeft = `${(-g.size / 2).toFixed(2)}px`;
  dot.style.background = dotColour(kind);
  dot.style.boxShadow = `0 0 0 ${g.ring.toFixed(2)}px #fff`;
  el.append(dot);

  const caption = label ? document.createElement('div') : null;
  if (caption) {
    caption.className = 'pin-selected-label';
    caption.style.fontSize = `${LABEL_PX}px`;
    caption.style.maxWidth = `${labelMaxPx(LABEL_PX)}px`;
    caption.textContent = label;
    // Starts where the resting label was - smaller, lower, and in the marker's
    // own hue - and is carried to its place by the same transition as the pin.
    // The custom properties are read by the rule in input.css.
    caption.style.setProperty('--pin-label-scale', String(LABEL_START_SCALE));
    caption.style.setProperty('--pin-label-rise', `${(LABEL_RISE * SELECTED_W).toFixed(2)}px`);
    if (ink) caption.style.color = ink;
    el.append(caption);
  }

  // The element's own box is the marker alone. The label hangs out of flow
  // beneath it, because `anchor: 'bottom'` puts the BOX's bottom edge on the
  // coordinate — count the label in and the marker floats a caption's height
  // above the thing it is naming.
  el.style.width = `${SELECTED_W}px`;
  el.style.height = `${height}px`;

  // Nudged down by the half of the dot that hangs below the box's bottom edge,
  // so it is the dot's CENTRE that lands on the coordinate rather than its
  // lowest pixel.
  const instance = new Marker({
    element: el,
    anchor: 'bottom',
    offset: [0, (1 - LIFT_DOT.y) * height],
  })
    .setLngLat(coords)
    .addTo(map);

  // A transition needs its start value to have been committed before the end
  // value is set, or the browser coalesces the two and there is nothing to
  // animate between. Reading a layout property is what forces that.
  void scaler.offsetWidth;
  scaler.style.transition = `transform ${GROW_MS}ms ${GROW_EASE}`;
  scaler.style.transform = LIFTED;
  if (caption) {
    caption.style.transition = `transform ${GROW_MS}ms ${GROW_EASE}, `
      + `opacity ${SYMBOL_FADE_MS}ms linear, `
      + `color ${Math.round(GROW_MS * LABEL_INK_SPAN)}ms linear `
      + `${Math.round(GROW_MS * LABEL_INK_DELAY)}ms`;
    // Back to the stylesheet's colour, which is what it transitions toward.
    caption.style.color = '';
  }
  el.classList.add('is-in');

  return {
    element: el,
    /** Shrink back to the ambient size, then take the marker down. */
    remove(to = from) {
      scaler.style.transition = `transform ${SHRINK_MS}ms ${SHRINK_EASE}`;
      scaler.style.transform = resting(to / SELECTED_W);
      el.classList.remove('is-in');
      // Removed on a timer rather than on transitionend: a marker whose tab is
      // backgrounded mid-animation never fires the event, and the pin would
      // stay hidden from its own layer for as long as the tab stayed away.
      setTimeout(() => instance.remove(), SHRINK_MS);
    },
  };
}
