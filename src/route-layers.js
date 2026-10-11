// The blue ribbon, the linework under it, and the hole cut in the basemap so
// both are ours.
//
// WHAT GOES UNDER WHAT used to be decided here too, by two small functions —
// `belowNetwork` and `belowRoute` — that each named one layer their caller had
// to go under. They were the part most likely to break, and they did: a rule
// written as "under this neighbour" is only right for the add orders its author
// pictured. The order is a list now, in src/layer-order.js, and every layer in
// this file asks it for its place like every layer in the sheet does.
//
// `addNetworkAndRoute` is called from main.js's `addNetworkLayers`, which stays
// there because it is ORCHESTRATION — nine builders in a documented order, with
// the reason for each position written beside it. Moving the order here would
// mean this module importing every other layer module to arrange them.

import { anchorFor } from './layer-order.js';
import { M_PER_PIXEL_AT_Z0 } from './campus-sheet.js';
import { M_PER_LON, M_PER_LAT } from './campus-clip.js';

// Google's road ribbon, in pixels, up to z18 — and a width on the ground from
// there on.
//
// Pixels below, because paths.json carries only `from`/`to`, so there is no
// per-segment width to scale, and a path drawn at its true 3.3 m would vanish
// at campus zoom anyway. Google solves this the same way — road width is a
// function of zoom and class, never of the real carriageway.
//
// GROUND ABOVE, because that is where the ribbon starts sitting INSIDE the
// pavement it was traced from rather than standing for it. The sheet under it
// is drawn at true width (src/campus-sheet.js), so from z17.3 the narrowest
// pavement on campus — 3.3 m, 81 of the walkways, and all but one walk that
// carries no width at all — is wider than this casing,
// and the network reads as the path's own surface with a margin of the
// print's paving either side. A pixel curve would keep going past that point
// and get relatively thinner with every zoom, until at z20 the old 18 px core
// was 1.05 m down the middle of a 3.3 m walk: a centre stripe, not a path.
// Doubling per zoom from z18 holds it at 1.87 m core and 2.56 m casing — the
// proportion it has at z18 — and both stay inside the 3.3 m walk they ride on
// at every zoom a phone can reach.
//
// Base 2 throughout, which is what makes the top half exact: an exponential-2
// curve between two stops a zoom apart in the ratio 2^n is a constant ground
// width. Below z18 the base only shapes the ease between the pixel stops, and
// the difference from the 1.6 these used to take is under a quarter pixel.
export const NETWORK_WIDTH = [
  'interpolate', ['exponential', 2], ['zoom'],
  14, 1.2,
  16, 3.5,
  18, 8,
  22, 128,
];

// Wider than the core by roughly a pixel and a half per side at campus zoom,
// which is the proportion Google holds, and by the same ratio once both are
// ground widths. Drawn underneath, so only the overhang shows.
export const NETWORK_CASING_WIDTH = [
  'interpolate', ['exponential', 2], ['zoom'],
  14, 2.4,
  16, 5.6,
  18, 11,
  22, 176,
];

// The route, in pixels to z18 exactly as it always was — 12 px of dark casing,
// a 6 px line, 5 px dots for the legs — and from z19 a width on the ground,
// for the reason the network has one and with more of it.
//
// THE NETWORK OUTGREW IT. While both were pixel curves the route held its own
// by being drawn over the ribbon at a similar weight. Once the ribbon became a
// ground width it doubled with every zoom and the route did not: at z20 the
// network casing is 44 px and the route casing was still 12, at z22 it was 176
// against 12 — the directions somebody asked for drawn as a thin blue thread
// down the middle of a fat white path, which is the one thing on this map
// that must read first. So the route is a ground width too, and a WIDER one,
// at every zoom: its casing over the network's casing, its line over the
// network's core, so that where a route runs the ribbon under it is covered
// edge to edge rather than framing it.
//
// HOW WIDE: 3.3 m of casing and 2.3 m of line. The casing takes the narrowest
// pavement on campus — the walk the network is held inside (see above) — so
// on most of the campus a route fills its walk wall to wall and stops there:
// dominant over the ribbon by a third of a metre a side, and never so wide
// that a route along a building's flank swallows the edge of its roof. The
// line is chosen to clear the network's 1.87 m core, so no white shows
// either side of the blue. The legs' dots take 1.9 m, the line's proportion
// at z18 — they are the walk-it-yourself stretches, a step down from the line.
//
// From z18 to z19 the curve eases from the pixel width up to the ground
// width — 12 px is 2.8 m there, under the 3.3 m it is heading for — and then
// holds it, which on a base-2 curve is what a doubling per zoom is. Below z18
// nothing changes: Mapbox clamps an interpolate before its first stop, so
// every zoom under it is drawn at that stop's pixel width.
//
// test/campus-sheet.test.js evaluates these against the network's curves at
// every quarter zoom from z14 to z22.
const routeWidth = (pxAtZ18, metres) => [
  'interpolate', ['exponential', 2], ['zoom'],
  18, pxAtZ18,
  19, metres * (2 ** 19 / M_PER_PIXEL_AT_Z0),
  22, metres * (2 ** 22 / M_PER_PIXEL_AT_Z0),
];
export const ROUTE_CASING_WIDTH = routeWidth(12, 3.3);
export const ROUTE_WIDTH = routeWidth(6, 2.3);
export const ROUTE_LEGS_WIDTH = routeWidth(5, 1.9);

/**
 * The network, with every stretch under a building's roof cut out and marked.
 *
 * Over the printed sheet these need no marking: the network sits under the
 * building band (src/layer-order.js), so the footprints paint out the
 * passages the walls stage keeps under roofs — 143 m in 28 pieces on the
 * current build, cut exactly as this cuts them — the way my campus's print
 * paints out its own walkways there. Over imagery there IS no band — the sheet
 * is not drawn on a photograph — and those same stretches were white paths
 * laid across the photographed roofs. So each line is cut where it crosses a
 * wall, and every piece inside a footprint carries `roofed: true`, which the
 * imagery filter in `addNetworkAndRoute` leaves out.
 *
 * Cut on the client, not in the build, because whether a passage under a roof
 * is DRAWN is a question about which ground is showing, and paths.json is the
 * walk network — the routing graph keeps those passages, and so does every
 * route through one, which is drawn from its own source and never filtered.
 *
 * The footprints are the same set the walls stage cuts against: every
 * `building` and `closed` polygon on the sheet, courtyards excepted. Crossings
 * are found on raw degrees, which is safe because ray-casting and a segment
 * intersection are both unchanged by scaling one axis; only the 1 cm floor on
 * a sliver needs metres. About 1,200 lines against about a hundred footprints,
 * each segment tested only against the boxes it meets, so this is a few
 * milliseconds once per arrival of either file.
 *
 * Every feature comes back with `roofed` set, true or false: a filter on a
 * property that is missing reads null, and `!=` against null is a trap worth
 * not setting.
 *
 * @param {object | null} network  a FeatureCollection of LineStrings
 * @param {object | null} sheet    the printed sheet, once it has landed
 */
export function markRoofed(network, sheet) {
  if (!network) return null;
  const footprints = (sheet?.features ?? [])
    .filter((f) => ROOF_KINDS.includes(f.properties?.kind))
    .flatMap(({ geometry: g }) => {
      const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
      return polys.map((rings) => {
        const xs = rings[0].map((p) => p[0]);
        const ys = rings[0].map((p) => p[1]);
        return { rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
      });
    });

  const tag = (feature, coordinates, roofed) => ({
    ...feature,
    geometry: coordinates ? { type: 'LineString', coordinates } : feature.geometry,
    properties: { ...feature.properties, roofed },
  });

  const features = [];
  for (const feature of network.features) {
    const line = feature.geometry?.type === 'LineString' ? feature.geometry.coordinates : null;
    if (!line || !footprints.length) {
      features.push(tag(feature, null, false));
      continue;
    }
    const pieces = [];
    for (let k = 1; k < line.length; k += 1) {
      const a = line[k - 1];
      const b = line[k];
      for (const [t, roofed] of runsUnder(a, b, footprints.filter((F) => boxMeets(F, a, b)))) {
        const end = t === 1 ? b : [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        const last = pieces.at(-1);
        if (last?.roofed === roofed) last.coordinates.push(end);
        else pieces.push({ roofed, coordinates: [last ? last.coordinates.at(-1) : a, end] });
      }
    }
    // The common case, and the cheap one: nothing under a roof, so the
    // original geometry goes back untouched.
    if (pieces.length === 1 && !pieces[0].roofed) features.push(tag(feature, null, false));
    else for (const { roofed, coordinates } of pieces) features.push(tag(feature, coordinates, roofed));
  }
  return { ...network, features };
}

/** The sheet kinds a roof is drawn for — the walls stage's footprints. */
const ROOF_KINDS = ['building', 'closed'];

const boxMeets = (F, a, b) => Math.max(a[0], b[0]) >= F.box[0] && Math.min(a[0], b[0]) <= F.box[2]
  && Math.max(a[1], b[1]) >= F.box[1] && Math.min(a[1], b[1]) <= F.box[3];

/** Ray casting; closed rings, so the wrap covers the last edge. */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every courtyard cut in it. */
const inFootprint = (p, F) => p[0] >= F.box[0] && p[0] <= F.box[2] && p[1] >= F.box[1] && p[1] <= F.box[3]
  && inRing(p, F.rings[0]) && !F.rings.slice(1).some((r) => inRing(p, r));

/**
 * Segment a-b as runs wholly under a roof or wholly not, as [tEnd, roofed]
 * pairs in order — each run ends where the next begins. A break within a
 * centimetre of another, or of an end, is dropped: shorter than that is a
 * sliver the shipped coordinates cannot even represent.
 */
function runsUnder(a, b, over) {
  if (!over.length) return [[1, false]];
  const L = Math.hypot((b[0] - a[0]) * M_PER_LON, (b[1] - a[1]) * M_PER_LAT);
  const ts = [];
  for (const F of over) {
    for (const ring of F.rings) {
      for (let k = 1; k < ring.length; k += 1) {
        const t = crossAt(a, b, ring[k - 1], ring[k]);
        if (t !== null) ts.push(t);
      }
    }
  }
  const breaks = [0];
  for (const t of ts.sort((x, y) => x - y)) {
    if ((t - breaks.at(-1)) * L >= 0.01 && (1 - t) * L >= 0.01) breaks.push(t);
  }
  breaks.push(1);
  const runs = [];
  for (let k = 1; k < breaks.length; k += 1) {
    const tm = (breaks[k - 1] + breaks[k]) / 2;
    const m = [a[0] + tm * (b[0] - a[0]), a[1] + tm * (b[1] - a[1])];
    const roofed = over.some((F) => inFootprint(m, F));
    if (runs.at(-1)?.[1] === roofed) runs.at(-1)[0] = breaks[k];
    else runs.push([breaks[k], roofed]);
  }
  return runs;
}

/** Where segment a-b crosses edge p-q, as a parameter along a-b, or null. */
function crossAt(a, b, p, q) {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = q[0] - p[0], sy = q[1] - p[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-18) return null;
  const t = ((p[0] - a[0]) * sy - (p[1] - a[1]) * sx) / den;
  const u = ((p[0] - a[0]) * ry - (p[1] - a[1]) * rx) / den;
  return t > 0 && t < 1 && u >= 0 && u <= 1 ? t : null;
}

/**
 * The filter both network layers take: everything over the sheet, and over
 * imagery everything but the stretches under a roof. `land` is the question
 * the sheet itself asks to decide whether it is drawn at all (see
 * src/campus-sheet.js), so the stretches come back exactly when the building
 * band that hides them does.
 */
export const networkFilter = (colors) => (colors.land ? null : ['!=', ['get', 'roofed'], true]);

/** Nothing to draw, in the shape every geojson source expects. */
const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.litPalette  the palette at the current time of day
 * @param {Function} deps.provider    who is drawing the ground
 * @param {object} deps.boundary      the campus polygon, for the mask
 * @param {Function} deps.network     the walkable linework, once it has landed
 * @param {Function} deps.sheet       the printed sheet, once it has landed —
 *                                    for the roofs the network passes under
 * @param {object} deps.route         the createRoute() holder
 * @param {Function} deps.from        where the start pin is, or undefined
 * @param {Function} deps.to          where the destination pin is, or undefined
 */
export function createRouteLayers({
  map, litPalette, provider, boundary, network, sheet, route, from, to,
}) {
  // ---------------------------------------------------------------------------

  // The drawn network, marked for roofs — remembered against the two inputs
  // it was made from, because a style swap re-adds the source and should not
  // redo the cutting for files that have not changed.
  let drawn = { network: undefined, sheet: undefined, data: EMPTY };
  function drawnNetwork() {
    if (drawn.network !== network() || drawn.sheet !== sheet()) {
      drawn = {
        network: network(),
        sheet: sheet(),
        data: markRoofed(network(), sheet()) ?? EMPTY,
      };
    }
    return drawn.data;
  }

  /**
   * Hand the network source the current linework. Called when either the
   * network or the sheet lands, in whichever order: the network drawn before
   * the sheet has nothing to cut against yet, so over imagery its passages
   * under roofs show until the footprints arrive and this runs again.
   */
  function paintNetwork() {
    map.getSource('custom-network')?.setData(drawnNetwork());
  }

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
      // network it is supposed to sit under — and of the sheet.
    }, anchorFor(map, 'campus-mask'));
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

  /** The sources and the five line layers, in the order they must be added. */
  function addNetworkAndRoute() {
    const colors = litPalette();
    if (!map.getSource('custom-network')) {
      map.addSource('custom-network', { type: 'geojson', data: drawnNetwork() });
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
    // layers, the wider casing underneath.
    //
    // UNDER THE BUILDINGS, which it was not. Its place in the stack is between
    // the print's ground and the print's buildings (src/layer-order.js), so a
    // footprint paints over it the way my campus's roofs paint over the
    // pavement the network was traced from. paths.json used to inherit every
    // stretch of that pavement the print ran under a roof — 368 m inside 29
    // buildings, and 32 of the 59 dead ends stopping indoors — and drawn on
    // top, those were white paths walking through walls. The build's walls
    // stage (scripts/build-walk-network.mjs) now cuts the stubs away at the
    // wall. What is left under a roof, about 140 m in under thirty pieces,
    // is the passages it chose to keep because the way round is much longer;
    // those are still in the graph and still routed along, and the building
    // band is what hides them on the idle map. Over imagery there is no
    // band, so there the filter below hides them instead — see markRoofed. A
    // route through one is the route layer's business, and that is drawn over
    // everything, from its own source, which no filter here touches.
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
      }, anchorFor(map, 'network-casing'));
    } else {
      map.setPaintProperty('network-casing', 'line-color', colors.networkCasing);
    }
    // Set on every pass, not only on the add: a theme change recolours these
    // layers in place, and the satellite toggle may or may not reload the
    // style, so the filter has to follow the ground whichever path got here.
    map.setFilter('network-casing', networkFilter(colors));

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
      }, anchorFor(map, 'network-lines'));
    } else {
      map.setPaintProperty('network-lines', 'line-color', colors.network);
    }
    map.setFilter('network-lines', networkFilter(colors));

    // Dark casing under the route so it stays readable against pale buildings.
    //
    // The three route layers are the top of the campus stack and stay there:
    // over the building band the network now sits under, so a route that
    // follows one of the kept indoor passages is drawn across the roof
    // rather than hidden by it. That is deliberate. A walk somebody has asked
    // for is the one piece of linework that must never be buried, and a blue
    // line over a roof says "through here" — which, for a route the graph
    // found, is the truth about where it goes.
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
          // Grows with the route rather than staying 5 px under it — see
          // ROUTE_WIDTH. The dash is in line widths, so the dots grow too
          // and stay dots, spaced as they are now.
          'line-width': ROUTE_LEGS_WIDTH,
          'line-dasharray': [0, 2],
          'line-emissive-strength': 1,
        },
      }, anchorFor(map, 'route-legs'));
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
        paint: {
          'line-color': colors.casing,
          'line-width': ROUTE_CASING_WIDTH,
          'line-opacity': 0.9,
          // Unlit, like the dotted legs and every other line of ours. These
          // two were the only campus lines left out, so on Mapbox's night
          // preset the route's blue was lit down to a navy barely off its own
          // casing — the legs bright at either end of a route line you had to
          // look for, over a network the preset was not allowed to dim.
          'line-emissive-strength': 1,
        },
      }, anchorFor(map, 'route-casing'));
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
        paint: { 'line-color': colors.route, 'line-width': ROUTE_WIDTH, 'line-emissive-strength': 1 },
      }, anchorFor(map, 'route-line'));
    } else {
      map.setPaintProperty('route-line', 'line-color', colors.route);
    }
  }

  return {
    paintLegs,
    paintNetwork,
    addMask: addCampusMask,
    setConfig,
    addNetworkAndRoute,
  };
}
