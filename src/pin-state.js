// Which pin is lifted, which pin is under the pointer, and what each layer is
// therefore allowed to draw.
//
// Six variables and a dozen functions that were spread across two sections of
// startApp() with three hundred lines of unrelated code between them, all
// reading and writing each other. `hiddenPin` is read by two filter builders;
// those filters are re-applied by `paintLabels` and `paintCategory`; the
// painters are called by the selection, the deselection and a 190 ms timer the
// deselection queues; and `hoverScale` is written by an animation frame and
// read by an expression builder somewhere else entirely.
//
// TAPPING ONE LIFTS IT: the symbol is taken out of its layer and an HTML marker
// takes its place at exactly the size the symbol was being drawn at, then
// springs up to the selected size. See src/pin-select.js for where that curve
// comes from — it is Apple Maps', measured off a 60 fps capture.
//
// An HTML marker rather than a bigger symbol because a symbol layer can only be
// resized by pushing a new `icon-size` every frame, which restyles the whole
// layer to move one icon and scales a 2x raster past its own resolution while
// it does it.
//
// WHAT A LIFT MEANS is not here. `onLift` is called with the hit and the caller
// decides what goes in the panel — a two-line card for a defibrillator, a whole
// building card for a building. Same split as the long press: this module knows
// the gesture, not the consequence.

import {
  mountSelectedPin, sizeExpr, sizeAt, AMBIENT_SIZE, CATEGORY_SIZE, LABEL_SIZE,
  growEase, shrinkEase, SHRINK_MS,
} from './pin-select.js';
import { PIN_BASE_W } from './map-images.js';
import { POI_LABEL_KINDS, AMENITY_ZOOM, AMENITY_ZOOM_DEFAULT } from './poi.js';

/**
 * The label layers that draw a pictogram, and are therefore pins.
 *
 * POI_LABEL_KINDS is the set poi.js gives a disc to; 38 of the 49 printed
 * labels get one. They looked like every other marker on this map and behaved
 * like nothing at all — `pinAt` did not know about them, so a tap fell through
 * to the building underneath and the lift never played. At the zoom the campus
 * fits the screen at they are most of the markers on it.
 */
export const POI_LABEL_LAYERS = [...POI_LABEL_KINDS].map((kind) => `campus-labels-${kind}`);

/** Which size table a layer draws its discs from. */
const SIZE_TABLE = { 'category-pins': CATEGORY_SIZE, 'campus-amenities': AMBIENT_SIZE };

/** How much bigger a hovered pin is drawn. Small: it is a hint, not a lift. */
export const HOVER_SCALE = 1.16;
export const HOVER_MS = 260;

/** How long the shrinking marker gets before its symbol is put back. */
export const RESTORE_MS = 190;

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.Marker          mapboxgl.Marker, for the lifted pin
 * @param {Function} deps.litPalette      the palette at the current time of day
 * @param {Function} deps.inkFor          text colour expression for a property
 * @param {Function} deps.labelPaint      text colour for a printed-label kind
 * @param {Function} deps.shownCategory   whether a chip is up
 * @param {Function} deps.paintCategory   re-apply the category layer's filter
 * @param {Function} deps.isArriving      whether the category entrance is playing
 * @param {Function} deps.prefersStill    reduced motion
 * @param {Function} deps.markerInk       the hue a lifted caption starts from
 * @param {string}   deps.closedText      the building-kind label drawn elsewhere
 * @param {Function} deps.onLift          what to put in the panel for a lifted pin
 * @param {Function} deps.onDeselect      chrome to put away when a pin goes down
 */
export function createPinState({
  map,
  Marker,
  litPalette,
  inkFor,
  labelPaint,
  shownCategory,
  paintCategory,
  isArriving,
  prefersStill,
  markerInk,
  closedText,
  onLift,
  onDeselect,
}) {
  /** `{ layer, id, coords, kind, name }` for the pin that is up, or null. */
  let selectedPin = null;
  let selectedMarker = null;

  /**
   * The queued restore of the symbol under a marker that is shrinking away.
   *
   * Held so it can be cancelled. Both painters read the CURRENT selection rather
   * than one captured when the timer was set, so a stale one was never wrong —
   * it just re-painted every pin layer to the state they were already in. But
   * people tap along a row of pins faster than the 190 ms this waits, and each
   * tap was leaving another one behind: a filter rebuild and a repaint per pin
   * layer, for an answer that had been on screen since the tap before.
   */
  let restorePins = null;

  /** The pin under the pointer, shaped like selectedPin so the two read alike. */
  let hoveredPin = null;
  /** The multiplier the hovered pin is currently drawn at. */
  let hoverScale = 1;
  /** Bumped to cancel a run in flight, exactly as the choreography does. */
  let hoverRun = 0;

  /** The filter that hides the lifted pin from its own layer, or null. */
  const hiddenPin = (layer) =>
    (selectedPin?.layer === layer ? ['!=', ['id'], selectedPin.id] : null);

  /**
   * What the ambient amenity layer is allowed to draw.
   *
   * Two rules combined, because setting them in turn would mean each one put
   * back what the other had just taken out. The zoom rank thins 84 markers down
   * to the 31 worth seeing across a whole campus (see AMENITY_ZOOM in poi.js);
   * the second hides whichever one has been lifted into a selection.
   *
   * A zoom expression in a `filter` is only re-evaluated at integer zooms, which
   * is exactly why the thresholds in that table are integers.
   */
  function amenityFilter() {
    const ranked = ['>=', ['zoom'], [
      'match',
      ['get', 'kind'],
      ...Object.entries(AMENITY_ZOOM).flatMap(([kind, zoom]) => [kind, zoom]),
      AMENITY_ZOOM_DEFAULT,
    ]];
    const hidden = hiddenPin('campus-amenities');
    return hidden ? ['all', ranked, hidden] : ranked;
  }

  /**
   * A label layer draws its own kind, minus whichever one has been lifted.
   *
   * ...and minus all of them while a chip is up, for the kinds that carry a
   * pictogram. Those 38 are pins — `pinAt` treats them as such and they lift
   * like any other — so leaving them on screen while a category is showing puts
   * the answer among forty markers that did not change. The kinds with no disc
   * stay: they are place names, not markers, and a campus that loses its own
   * names is harder to read, not clearer.
   */
  function labelFilter(kind) {
    if (shownCategory() && POI_LABEL_KINDS.has(kind)) return ['boolean', false];
    // "Closed" is a building-kind label and it is drawn by campus-labels-closed
    // instead, which is the only layer here that can be rotated onto the shape
    // it annotates. Excluded rather than left to draw twice.
    const mine = kind === 'building'
      ? ['all', ['==', ['get', 'kind'], kind], ['!=', ['get', 'text'], closedText]]
      : ['==', ['get', 'kind'], kind];
    const hidden = hiddenPin(`campus-labels-${kind}`);
    return hidden ? ['all', mine, hidden] : mine;
  }

  /** Re-apply those filters, which is what hides and restores a lifted label. */
  function paintLabels() {
    for (const kind of POI_LABEL_KINDS) {
      const id = `campus-labels-${kind}`;
      if (map.getLayer(id)) map.setFilter(id, labelFilter(kind));
    }
  }

  /** How wide a layer is drawing its icons at this zoom, in CSS pixels. */
  const ambientWidth = (layer) => PIN_BASE_W * sizeAt(
    SIZE_TABLE[layer] ?? LABEL_SIZE,
    map.getZoom(),
  );

  /**
   * The pin under a click, or null.
   *
   * Category pins first: while a chip is up they are the layer that is meant to
   * be answering, and the two can sit on the same coordinate.
   */
  function pinAt(pointer) {
    for (const layer of ['category-pins', 'campus-amenities', ...POI_LABEL_LAYERS]) {
      if (!map.getLayer(layer)) continue;
      const [hit] = map.queryRenderedFeatures(pointer, { layers: [layer] });
      if (!hit) continue;
      return {
        layer,
        id: hit.id,
        coords: hit.geometry.coordinates,
        // A label's pictogram is in `poi`; an amenity's is its own `kind`.
        kind: hit.properties.poi ?? hit.properties.kind ?? hit.properties.icon,
        // A building's name is the label itself, which is what a lifted marker
        // should be captioned with.
        text: hit.properties.text ?? null,
        // Amenities carry the legend's wording; a category pin carries the
        // directory's, and drops it when the name would not identify anything.
        name: hit.properties.name || hit.properties.label || hit.properties.text || null,
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Hovering a pin
  //
  // A marker under the pointer springs up a little, its name changes colour,
  // and the cursor becomes a pointer. Three signals for one fact — this is a
  // thing you can press — because each of them is doing something the other two
  // cannot: the cursor says it before you have looked away from what you were
  // reading, the size says WHICH one of forty markers, and the colour survives
  // the pin being under your own hand.
  //
  // The spring is the lift's own, off the same capture. A hover is not a
  // selection, so it goes a fraction of the distance — but it is the same
  // gesture in miniature, and a different easing here would read as a different
  // map. That overshoot is the twitch.
  //
  // HOW IT IS DRAWN, because this is the part with a trap in it: `icon-size` is
  // a LAYOUT property, and layout properties cannot read `feature-state`. So
  // there is no per-feature hover the way there is for a fill. What there IS is
  // `['id']`, which is legal in a layout expression — so the layer is given a
  // size expression that names one id and scales only that one, and the
  // expression is rewritten each frame. The `case` sits INSIDE the interpolate's
  // outputs rather than around it, for the same reason scaleStops exists: Mapbox
  // only accepts `['zoom']` as the direct input to a top-level interpolate.
  //
  // One layer at a time, always. Pushing a layout property re-lays out that
  // layer's symbols, and the printed-label set is the expensive one — the
  // category swap declines to animate it for exactly this reason. Hovering
  // touches only the layer the pointer is actually over.
  // -------------------------------------------------------------------------

  /**
   * `icon-size` for a layer, with the hovered feature — and only it — scaled.
   *
   * Falls back to the plain expression whenever this layer is not the hovered
   * one, so a layer that is left goes back to being declarative rather than
   * holding a frame's worth of state.
   */
  function pinSizeExpr(layer) {
    const stops = SIZE_TABLE[layer] ?? LABEL_SIZE;
    if (hoveredPin?.layer !== layer || hoverScale === 1) return sizeExpr(stops);
    const mine = ['==', ['id'], hoveredPin.id];
    return ['interpolate', ['linear'], ['zoom'], ...Object.entries(stops).flatMap(
      ([zoom, size]) => [Number(zoom), ['case', mine, size * hoverScale, size]],
    )];
  }

  /** ...and its `text-color`, with the hovered pin's name in the accent. */
  function pinTextExpr(layer) {
    const colors = litPalette();
    const base = layer === 'campus-amenities' ? inkFor('kind')
      : layer === 'category-pins' ? inkFor('icon')
        : labelPaint(layer.replace('campus-labels-', ''), colors);
    if (hoveredPin?.layer !== layer) return base;
    return ['case', ['==', ['id'], hoveredPin.id], colors.highlight, base];
  }

  /**
   * Push both onto one layer.
   *
   * `category-pins` is skipped while its entrance is playing. That animation
   * owns the same layout property frame by frame, and a hover repaint landing in
   * the middle of it would drop the pins to full size mid-arrival. It gets one
   * repaint when the swap settles instead, so a pointer resting where the pins
   * land still finds its hover.
   */
  function paintPinHover(layer) {
    if (!map.getLayer(layer)) return;
    if (layer === 'category-pins' && isArriving()) return;
    map.setLayoutProperty(layer, 'icon-size', pinSizeExpr(layer));
    map.setPaintProperty(layer, 'text-color', pinTextExpr(layer));
  }

  /** Ease one layer's hover scale from where it is to `to`, then settle. */
  function runHover(layer, to, ms, ease, run, done) {
    if (prefersStill()) {
      // The colour still changes — it is the signal, not the decoration — but
      // nothing moves.
      hoverScale = 1;
      done?.();
      paintPinHover(layer);
      return;
    }
    const from = hoverScale;
    const started = performance.now();
    const step = (now) => {
      if (run !== hoverRun) return;
      const p = Math.min(1, (now - started) / ms);
      hoverScale = from + (to - from) * ease(p);
      paintPinHover(layer);
      if (p < 1) { requestAnimationFrame(step); return; }
      if (done) { done(); paintPinHover(layer); }
    };
    requestAnimationFrame(step);
  }

  /**
   * Point at a pin, or at nothing.
   *
   * Three cases, and the third is the compromise. Arriving at a pin springs it
   * up; leaving one for empty map settles it back down where it is. Moving
   * straight from a pin in one layer to a pin in another SNAPS the first back,
   * because one scale cannot animate two layers and the expression that grew the
   * old feature names an id its layer is no longer about. Nobody watches the pin
   * they just left when a new one is growing under the pointer.
   */
  function hoverPin(next) {
    const prev = hoveredPin;
    if (next?.layer === prev?.layer && next?.id === prev?.id) return;
    hoverRun += 1;
    const run = hoverRun;

    if (prev && (!next || prev.layer !== next.layer)) {
      if (next) {
        hoveredPin = null;
        hoverScale = 1;
        paintPinHover(prev.layer);
      } else {
        // hoveredPin stays `prev` for the length of this, because the
        // expression settling it back down is still the one that names it.
        runHover(prev.layer, 1, SHRINK_MS, shrinkEase, run, () => {
          if (run === hoverRun) hoveredPin = null;
        });
      }
    }

    if (!next) return;
    hoveredPin = next;
    hoverScale = 1;
    runHover(next.layer, HOVER_SCALE, HOVER_MS, growEase, run);
  }

  /** Let go of whatever is hovered without animating — for a style swap. */
  function clearHover() {
    hoverRun += 1;
    const was = hoveredPin;
    hoveredPin = null;
    hoverScale = 1;
    if (was) paintPinHover(was.layer);
  }

  function deselectPin() {
    if (!selectedPin) return;
    onDeselect();
    const width = ambientWidth(selectedPin.layer);
    selectedPin = null;
    // The marker shrinks back before it goes, and the symbol underneath only
    // comes back once it has: unfilter first and there are two pins for a fifth
    // of a second, the small one sitting inside the shrinking large one.
    const marker = selectedMarker;
    selectedMarker = null;
    marker?.remove(width);
    clearTimeout(restorePins);
    restorePins = setTimeout(() => { paintCategory(); paintLabels(); }, RESTORE_MS);
  }

  /**
   * Lift a pin out of its layer.
   *
   * `card` is false when the caller has a better one to show. A building's
   * pictogram is a pin like any other and lifts like one, but what belongs in
   * the panel is the building card — the floor area, what is inside it, the
   * entrance its Start and Destination buttons actually route from — not the
   * two-line card a defibrillator gets. Same panel either way; the caller
   * fills it instead, immediately after this returns.
   */
  function selectPin(hit, { card = true } = {}) {
    // Tapping the pin that is already up puts it back, the way pressing a lit
    // legend row clears the category.
    if (selectedPin?.layer === hit.layer && selectedPin?.id === hit.id) {
      deselectPin();
      return;
    }
    deselectPin();
    onDeselect();

    const from = ambientWidth(hit.layer);
    selectedPin = hit;
    // Filter first, so the symbol is gone by the time its replacement appears.
    // This pair IS the restore the deselect above queued, arriving 190 ms early
    // and with the new selection already filtered out — so drop the timer rather
    // than let it repeat the work once the marker has finished shrinking.
    clearTimeout(restorePins);
    paintCategory();
    paintLabels();

    selectedMarker = mountSelectedPin({
      map,
      marker: Marker,
      kind: hit.kind,
      coords: hit.coords,
      label: hit.name,
      // The hue the resting label was set in, so the caption crosses from it to
      // the map's ink rather than appearing already black.
      ink: markerInk(hit.kind),
      ring: litPalette().pinRing,
      from,
    });

    if (card) onLift(hit);
  }

  return {
    amenityFilter,
    labelFilter,
    /**
     * The filter that hides the lifted pin from its own layer, or null.
     *
     * Public because `paintCategory` sets the category layer's filter to
     * exactly this and nothing else — the category's own pins are all it draws,
     * so there is no second rule to combine with the way amenityFilter has.
     */
    hiddenPin,
    paintLabels,
    pinAt,
    paintPinHover,
    hoverPin,
    clearHover,
    selectPin,
    deselectPin,
    ambientWidth,
    /** Whether anything is lifted. Read by the chrome, never written by it. */
    isSelected: () => selectedPin !== null,
  };
}
