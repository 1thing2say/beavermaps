// The blue ribbon, the linework under it, and the hole cut in the basemap so
// both are ours.
//
// Also the three small functions that decide WHAT GOES UNDER WHAT. Those look
// like trivia and they are the part most likely to break: `belowNetwork` and
// `belowRoute` name a layer that may not exist yet, on a style that may be
// Mapbox's or may be a blank one under Google's raster, and getting either
// wrong puts the campus sheet over the route or the route under the buildings.
// Having them in one file next to the layers they order is the whole argument
// for this module.
//
// `addNetworkAndRoute` is called from main.js's `addNetworkLayers`, which stays
// there because it is ORCHESTRATION — nine builders in a documented order, with
// the reason for each position written beside it. Moving the order here would
// mean this module importing every other layer module to arrange them.

// Google's road ribbon, in pixels. Not the ground-width curve the printed sheet
// uses: paths.json carries only `from`/`to`, so there is no per-segment width to
// scale, and a road drawn at its true 3.3 m would vanish at campus zoom anyway.
// Google solves this the same way — road width is a function of zoom and class,
// never of the real carriageway.
export const NETWORK_WIDTH = [
  'interpolate', ['exponential', 1.6], ['zoom'],
  14, 1.2,
  16, 3.5,
  18, 8,
  20, 18,
];

// Wider than the core by roughly a pixel and a half per side at every zoom,
// which is the proportion Google holds. Drawn underneath, so only the overhang
// shows.
export const NETWORK_CASING_WIDTH = [
  'interpolate', ['exponential', 1.6], ['zoom'],
  14, 2.4,
  16, 5.6,
  18, 11,
  20, 23,
];

/** Nothing to draw, in the shape every geojson source expects. */
const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.litPalette  the palette at the current time of day
 * @param {Function} deps.provider    who is drawing the ground
 * @param {object} deps.boundary      the campus polygon, for the mask
 * @param {Function} deps.network     the walkable linework, once it has landed
 * @param {object} deps.route         the createRoute() holder
 * @param {Function} deps.from        where the start pin is, or undefined
 * @param {Function} deps.to          where the destination pin is, or undefined
 */
export function createRouteLayers({
  map, litPalette, provider, boundary, network, route, from, to,
}) {
  // ---------------------------------------------------------------------------

  function paintLegs() {
    map.getSource('route-legs')?.setData(
      route.legs(from(), to()),
    );
  }

  /**
   * Take Mapbox's own data out of the campus, so inside the boundary the map is
   * ours and outside it is theirs.
   *
   * This needs two mechanisms, because neither one covers everything:
   *
   *   - `clip` removes basemap features inside the polygon, but only of the
   *     types it is told about, and the type list it understands is model,
   *     symbol and fill-extrusion. That is Mapbox's 3D buildings, their
   *     landmark models and every label — but not roads.
   *   - Roads, footpaths and parking aisles are plain `line` layers, which clip
   *     cannot touch at all. Those have to be painted over.
   *
   * The boundary is OSM's own `amenity=college` way, which is the polygon
   * Mapbox draws the campus from, so the cut lands exactly on their edge.
   */
  function addCampusMask() {
    const colors = litPalette();

    if (!map.getSource('campus-boundary')) {
      map.addSource('campus-boundary', { type: 'geojson', data: boundary });
    }

    // Nothing to clip when Google draws the ground: the style under us is
    // blank, so there is no `basemap` import for `clip-layer-scope` to name and
    // no Mapbox symbols or models to remove. Skipped rather than left to no-op,
    // because a clip layer sitting above the Google raster is one scope-matching
    // change away from punching a hole in the ground it is meant to leave alone.
    if (provider() !== 'google' && !map.getLayer('campus-clip')) {
      try {
        map.addLayer({
          id: 'campus-clip',
          type: 'clip',
          source: 'campus-boundary',
          layout: {
            // `model` and `symbol` are the only values this accepts — passing
            // `fill-extrusion` is rejected outright. That is enough: Standard
            // draws its buildings and landmarks as batched models, and every
            // label is a symbol, so both are covered.
            'clip-layer-types': ['model', 'symbol'],
            // Scoping this to the basemap is not optional. Our markers are
            // symbols too, so an unscoped clip would delete exactly the data
            // this is meant to reveal.
            'clip-layer-scope': ['basemap'],
          },
        });
      } catch (error) {
        // Isolated on purpose. A clip failure must not take the fill mask down
        // with it, or a version bump that changes this property silently leaves
        // Mapbox's roads showing through the campus.
        console.error('campus clip unavailable:', error.message);
      }
    }

    if (colors.mask === null) {
      if (map.getLayer('campus-mask')) map.removeLayer('campus-mask');
      return;
    }

    if (map.getLayer('campus-mask')) {
      map.setPaintProperty('campus-mask', 'fill-color', colors.mask);
      return;
    }
    map.addLayer({
      id: 'campus-mask',
      type: 'fill',
      source: 'campus-boundary',
      // `middle` sits above the basemap's polygons and lines and below its 3D
      // and labels — the only slot that covers roads without burying our own
      // work or Mapbox's place names outside the campus.
      slot: 'middle',
      paint: {
        'fill-color': colors.mask,
        // Standard lights every fill through its own lighting model, and under
        // the night preset that drove the mask almost black: raising the
        // authored colour threefold moved the rendered pixel by a tenth. This
        // opts the mask out of the lighting entirely so it renders as written,
        // which is what a flat ground plane wants anyway.
        'fill-emissive-strength': 1,
      },
      // Re-added after a basemap swap, this would otherwise land on top of the
      // network it is supposed to sit under.
    }, belowNetwork());
  }

  /**
   * One Standard configuration property, best-effort.
   *
   * Standard's schema is Mapbox's to change, and a key it no longer recognises
   * throws rather than being ignored. A missing colour is a cosmetic loss; an
   * exception here would take down every layer added after it, so this swallows
   * and reports instead.
   */
  function setConfig(key, value) {
    try {
      map.setConfigProperty('basemap', key, value);
    } catch (error) {
      console.warn(`basemap config "${key}" unavailable:`, error.message ?? error);
    }
  }

  /**
   * The layer a campus overlay must be inserted below to stay under the road
   * ribbon. The casing is the lower of the two network layers, so anchoring to
   * `network-lines` would slip the ground cover between casing and core and
   * paint out the casing entirely.
   */
  function belowNetwork() {
    for (const id of ['network-casing', 'network-lines']) {
      if (map.getLayer(id)) return id;
    }
    return undefined;
  }

  /**
   * The layer to insert below to sit OVER the paths but still under the route.
   *
   * The closed block's outline is the one campus edge that wants this. my campus's
   * walkways run straight across the shape and, drawn under them, the boundary
   * came apart into four red segments with white paths laid over the gaps —
   * which reads as a shape you can walk through, the opposite of what the red
   * is there to say.
   *
   * Under the route regardless, for the reason the highlight is: nothing on
   * this map gets to bury the directions somebody is following.
   */
  function belowRoute() {
    for (const id of ['route-legs', 'route-casing', 'route-line']) {
      if (map.getLayer(id)) return id;
    }
    return undefined;
  }

  /** The sources and the five line layers, in the order they must be added. */
  function addNetworkAndRoute() {
    const colors = litPalette();
    if (!map.getSource('custom-network')) {
      map.addSource('custom-network', { type: 'geojson', data: network() ?? EMPTY });
    }
    if (!map.getSource('calculated-route')) {
      map.addSource('calculated-route', { type: 'geojson', data: route.feature() });
    }
    if (!map.getSource('route-legs')) {
      map.addSource('route-legs', {
        type: 'geojson',
        data: route.legs(from(), to()),
      });
    }

    // The network is drawn the way Google draws a road: one source, two line
    // layers, the wider casing underneath. Added casing-first so insertion
    // order alone puts it below — both live in `middle`, and within a slot
    // Mapbox honours the order layers were added in.
    //
    // Round joins and caps on both. A square cap on the casing leaves a grey
    // nub sticking past the end of the white core at every dead end, which is
    // the tell that a network was drawn as two lines rather than as roads.
    if (!map.getLayer('network-casing')) {
      map.addLayer({
        id: 'network-casing',
        type: 'line',
        source: 'custom-network',
        slot: 'middle',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': colors.networkCasing,
          'line-width': NETWORK_CASING_WIDTH,
          // Gone at overview zooms, because the reference has no casing there
          // at all. A cut across a campus path on Apple at z16 is two pixels of
          // one flat tone with nothing but antialiasing at its edges; the
          // casing only appears once a path is wide enough to have edges worth
          // drawing, which is the same threshold the network itself inverts at.
          //
          // This is what made our campus read as a fractured surface where
          // theirs reads as blocks on a field. The casing is L 20.5 against
          // ground at L 31.7 — eleven points under it — so at the opening view
          // every footpath was a black seam, and there are a lot of footpaths.
          // The core stays: at L 28.4 on L 31.7 it is a three-point mark, which
          // is about the weight Apple's light path carries the other way up.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 16.2, 0, 16.8, 1],
          // Same reasoning as the mask and the sheet: without this the night
          // preset drags both halves of the ribbon toward the ground colour and
          // the casing stops separating anything.
          'line-emissive-strength': 1,
        },
      });
    } else {
      map.setPaintProperty('network-casing', 'line-color', colors.networkCasing);
    }

    if (!map.getLayer('network-lines')) {
      map.addLayer({
        id: 'network-lines',
        type: 'line',
        source: 'custom-network',
        // Every custom layer goes in `middle`, above the mask that hides
        // Mapbox's linework and below their labels, so place names outside the
        // campus stay readable over the top of nothing of ours.
        slot: 'middle',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': colors.network,
          'line-width': NETWORK_WIDTH,
          'line-emissive-strength': 1,
        },
      });
    } else {
      map.setPaintProperty('network-lines', 'line-color', colors.network);
    }

    // Dark casing under the route so it stays readable against pale buildings.
    // Dotted, in the route's own blue: a round cap on a zero-length dash draws
    // a circle, so `[0, 2]` is a row of dots rather than a dashed line. That is
    // the convention for "walk this bit yourself" on every map that has one.
    if (!map.getLayer('route-legs')) {
      map.addLayer({
        id: 'route-legs',
        type: 'line',
        source: 'route-legs',
        slot: 'middle',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': colors.route,
          'line-width': 5,
          'line-dasharray': [0, 2],
          'line-emissive-strength': 1,
        },
      });
    } else {
      map.setPaintProperty('route-legs', 'line-color', colors.route);
    }

    if (!map.getLayer('route-casing')) {
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'calculated-route',
        slot: 'middle',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': colors.casing, 'line-width': 12, 'line-opacity': 0.9 }
      });
    } else {
      map.setPaintProperty('route-casing', 'line-color', colors.casing);
    }

    if (!map.getLayer('route-line')) {
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'calculated-route',
        slot: 'middle',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': colors.route, 'line-width': 6 }
      });
    } else {
      map.setPaintProperty('route-line', 'line-color', colors.route);
    }  }

  return {
    paintLegs,
    addMask: addCampusMask,
    setConfig,
    belowNetwork,
    belowRoute,
    addNetworkAndRoute,
  };
}
