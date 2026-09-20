// The college's printed campus map, drawn element for element.
//
// Ground cover traced out of the same basemap sheet as the buildings: lawn,
// paving, courts, bay striping, the HOME BASE badges. Two layers over one
// source, because the sheet mixes areas with stroked linework and Mapbox will
// not do both in one.
//
// ITS OWN MODULE BECAUSE OF THE WIDTHS. `groundWidth` converts metres on the
// ground into pixels at a zoom, through a constant — `M_PER_PIXEL_AT_Z0` — that
// is a property of the Web Mercator projection and of this campus's latitude.
// That is arithmetic with a right answer, it was buried in the middle of a
// seven-thousand-line file, and test/campus-sheet.test.js can now ask it
// whether a 1.65 m path is drawn at a plausible width at z18.
//
// Everything here is safe to call repeatedly: it recolours an existing layer
// rather than rebuilding it, so a theme switch — which no longer reloads the
// style — updates in place.

import { bayRake } from './bay-rake.js';

// Metres of ground per pixel is 156543.03 * cos(latitude) / 2^zoom, and at this
// campus's 38.65 degrees that constant is 122275. Dividing a width in metres by
// it, against an exponential-base-2 zoom curve, holds a line at its true ground
// width instead of a fixed pixel width — so the 26 m entry road stays visibly
// wider than the 3.3 m footpaths at every zoom.
export const M_PER_PIXEL_AT_Z0 = 122275;

/** The one kind on the sheet that is painted as something other than its name. */
export const CLOSED_KIND = 'closed';

/**
 * The word, which is also how the label layer finds the shape.
 *
 * Exported because the printed-label set has to EXCLUDE it — it is drawn by
 * campus-labels-closed instead, the only layer here that can be rotated onto
 * the shape it annotates — and because pin-state.js needs the same string to
 * keep that kind out of its filter.
 */
export const CLOSED_TEXT = 'Closed';

/**
 * One red for the marks, two for the word.
 *
 * The wash, hatch and outline are the same hue at three opacities, so the
 * shape reads as one object rather than three annotations that happen to
 * agree. The text cannot join them: it is the only part that has to stay
 * legible as TYPE, so it takes the ramp's dark end on light ground and its
 * light end on dark, the way pinInk does for a marker's name.
 */
export const CLOSED_RED = '#ea4335';
export const CLOSED_INK = { light: '#c5221f', dark: '#f28b82' };

/**
 * Which way the closed block actually lies, in degrees clockwise from east.
 *
 * my campus drew it on the diagonal and the word over it was setting horizontally,
 * so the label crossed two of its edges and sat half on the tarmac outside.
 * Measured off the geometry rather than typed in as a number: the shape comes
 * from a generated artifact, and a rebuild that nudged it would leave a
 * hard-coded angle quietly wrong.
 *
 * The longest edge is the one that decides it — the block is a quadrilateral,
 * so its long side IS its grain — and longitude is scaled by cos(latitude)
 * first, without which the angle is off by the map's own aspect.
 */
export function closedBearing(basemap) {
  const shape = basemap?.features?.find((f) => f.properties.kind === CLOSED_KIND);
  const ring = shape?.geometry?.coordinates?.[0];
  if (!ring || ring.length < 3) return 0;

  const scale = Math.cos((ring[0][1] * Math.PI) / 180);
  let best = { length: -1, angle: 0 };
  for (let i = 0; i < ring.length - 1; i += 1) {
    const dx = (ring[i + 1][0] - ring[i][0]) * scale;
    const dy = ring[i + 1][1] - ring[i][1];
    const length = Math.hypot(dx, dy);
    if (length <= best.length) continue;
    // Normalised to the half-turn that reads left-to-right, so the word is
    // never upside down whichever way round the ring was wound.
    const east = dx >= 0 ? [dx, dy] : [-dx, -dy];
    best = { length, angle: -(Math.atan2(east[1], east[0]) * 180) / Math.PI };
  }
  return best.angle;
}


/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.litPalette    the palette at the current time of day
 * @param {Function} deps.sheet         the basemap overlay, once it has landed
 * @param {Function} deps.belowNetwork  which layer id these must sit under
 */
export function createCampusSheet({ map, litPalette, sheet, belowNetwork, belowRoute }) {

  /**
   * How wide a line off the printed sheet is drawn, in metres, before zoom.
   *
   * Everything takes the width my campus drew it at — except the bleachers, and that
   * exception is what turns a stadium into a stadium.
   *
   * my campus's sheet draws seating as 24 hairlines 0.78 m wide: the tier lines of a
   * technical drawing, not the mass of a stand. Apple draws the same thing as a
   * solid bowl wrapping the pitch, and there is no bowl in this data to colour
   * — the features are LineStrings, so they cannot even enter the fill layer.
   * Widening them to a stand's real depth is the honest way to get from one to
   * the other: it is the same geometry my campus published, drawn at the size the
   * thing actually is rather than at the size a draughtsman's line is.
   */
  const SHEET_WIDTH = [
    'case',
    ['==', ['get', 'kind'], 'bleachers'], 7,
    ['coalesce', ['get', 'width'], 1.65],
  ];

  const groundWidth = (floor) => [
    'interpolate', ['exponential', 2], ['zoom'],
    // The floor keeps the thinnest paths from disappearing when zoomed out,
    // where true width would put them below a pixel.
    14, ['max', floor, ['*', SHEET_WIDTH, 2 ** 14 / M_PER_PIXEL_AT_Z0]],
    20, ['max', floor, ['*', SHEET_WIDTH, 2 ** 20 / M_PER_PIXEL_AT_Z0]],
  ];

  /**
   * Colour for one of the printed sheet's classes, falling back to the colour
   * my campus drew it in. `land` covers ground; anything else — a court marking, a bus
   * sign, the HOME BASE badges — keeps its own paint, which is what makes the
   * overlay still read as their map rather than a recolour of it.
   */
  const sheetPaint = (land, property, overrides = {}) => [
    'match',
    ['get', 'kind'],
    ...Object.entries({ ...land, ...overrides }).flat(),
    ['coalesce', ['get', property], 'transparent'],
  ];

  /**
   * my campus's printed campus map, drawn element for element.
   *
   * Two layers over one source, because the sheet mixes areas with stroked line
   * work and Mapbox will not do both in one: the fill layer takes everything
   * with a fill, the line layer everything with a stroke, and a shape with both
   * appears in each.
   *
   * The sort keys are load-bearing. A flat vector map is a painter's algorithm —
   * bay striping over tarmac, trees over lawn — and `i` is the element's index
   * in the original document. Without them Mapbox is free to reorder within a
   * layer and the campus renders inside out.
   */
  function add() {
    const colors = litPalette();
    const { land } = colors;

    // Over imagery there is nothing to add — see SATELLITE.land.
    if (!land) {
      for (const id of ['campus-rake', 'campus-sheet-line', 'campus-sheet-fill']) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      return;
    }

    // One kind is painted as something other than what it is called, and it is
    // the sheet's own naming that is off rather than ours: `closed` takes the
    // BUILDING grey rather than the one the land table holds for it. The two
    // are near-neighbours in every look but not the same — in the classic light
    // table it is a neutral #e4e4e4 against the buildings' warm #e8e0cd — and a
    // closed building should sit in the row of buildings it belongs to,
    // differing by the red over it and by nothing else.
    //
    // `lawn` used to be a second such override, painted in the campus GROUND
    // colour, and that is now reversed. The argument for it was that layer 2 is
    // four shapes totalling 519,000 m2 which the build script itself calls
    // "open ground" — a base plate rather than planting, being whatever is left
    // once the buildings, lots, paths and canopies are subtracted — so filling
    // the residual with grass made the campus a park with some blocks in it.
    //
    // The argument was sound and the reference it was measured against was the
    // wrong one. Apple would not paint a college green; my campus did, and my campus's
    // sheet is what this map is a translation of. Counted over the campus body
    // of the printed map, 39.3% of it is green — 24.4% open lawn at L 79 C 45,
    // 9.5% tree canopy at L 47 C 37 — and the greenest thing about it is
    // exactly that base plate. Restoring it lands us at 41.9% by day and 40.4%
    // at night against their 39.3%, from each look's own measured values rather
    // than from the print's ink.
    //
    // What the earlier note was right about survives: `land.lawn` is also the
    // value the surrounding parkland is matched against, so the boundary
    // between our sheet and the provider's greenspace agrees. See the seam
    // test. The campus now runs into that parkland instead of sitting on it,
    // which is a fair description of this campus.
    const fillColour = sheetPaint(land, 'fill', { closed: land.building });
    // Strokes that are ground read as ground; the rest keep my campus's ink. Building
    // outlines follow the theme so they agree with the footprints drawn on top.
    const lineColour = sheetPaint(
      { walkway: land.walkway, driveway: land.driveway, offsite_road: land.offsite_road, crossing: land.crossing },
      'stroke',
      // The stands take the bleacher FILL rather than a building outline. They
      // are drawn seven metres wide now — see SHEET_WIDTH — so they are a mass
      // on the map rather than an edge, and an edge colour on a mass reads as a
      // block of outline. Everything else keeps the pairing it had.
      // A court's outline takes the court's own fill, which is to say it stops
      // being an outline. The reference draws no line between a court and its
      // surround at all — a cross-section through the twelve is 23 px of
      // surface, a gap of apron, 23 px of surface, with no edge anywhere — and
      // my campus's sheet carries these as stroke-only shapes in `#fff`, so left
      // alone they came out as twelve white rectangles on bare ground.
      {
        building: colors.buildingLine,
        bleachers: land.bleachers,
        sport: colors.sportLine,
        tennis: land.tennis,
        tennis_apron: land.tennis_apron,
      },
    );

    if (map.getLayer('campus-sheet-fill')) {
      map.setPaintProperty('campus-sheet-fill', 'fill-color', fillColour);
      map.setPaintProperty('campus-sheet-line', 'line-color', lineColour);
      map.setPaintProperty('campus-rake', 'line-color', land.parking_stripe);
      return;
    }
    if (!sheet()) return; // still in flight; addNetworkLayers re-runs

    if (!map.getSource('campus-sheet')) {
      map.addSource('campus-sheet', { type: 'geojson', data: sheet() });
    }
    // The bay dividers, as lines rather than as the 0.99 m bars they are drawn.
    // Its own source because it is its own geometry — see src/bay-rake.js.
    if (!map.getSource('campus-rake')) {
      map.addSource('campus-rake', { type: 'geojson', data: bayRake(sheet()) });
    }

    // `hidden` marks the parts the app supplies itself — the label plates and
    // the letterform-free label layer — so drawing them would double up on the
    // real text in src/labels.json.
    //
    // The kinds below are hidden for the same reason, one layer up: the sheet
    // draws its own pictogram for each of them and addAmenityLayer draws a
    // Google-style disc over the top, so 78% of those discs were landing within
    // 6 m of a printed icon — two icon languages stacked on one point.
    //
    // Safe because the coverage is exact. The sheet spends several paths per
    // symbol (84 elements for 14 phones), and collapsing them to positions gives
    // 14 phones, 6 defibrillators, 6 restrooms and 5 permit machines against
    // amenities.json's 14, 6, 6 and 10. Nothing is lost; the permit machines
    // gain five. `bus_stop` joined them when build-amenities.mjs learned to
    // collapse the sheet's 19 sign-plate elements into the 3 stops they draw.
    //
    // `parking_marker` and `bike_marker` joined last. They were the two layers
    // build-basemap.mjs could not name, and they were the black pictograms
    // still competing with our own discs: 15 bicycle-and-P signs and, in the
    // other, 8 P badges, 10 permit machines, a motorcycle bay and 2 drop-off
    // symbols. Every one of those is now an amenity point drawn as a disc, so
    // the printed artwork is redundant rather than complementary.
    //
    // One caveat, and it is the only thing lost here: my campus's two Student
    // Drop-Off symbols are painted on the kerb, while the disc that replaces
    // them sits on the routing node my campus binds that destination to, 21 m and
    // 30 m away. The symbol moves; it does not disappear.
    const REDRAWN = [
      'emergency_phone', 'defibrillator', 'restroom', 'permit_machine', 'bus_stop',
      'parking_marker', 'bike_marker',
    ];
    const visible = [
      'all',
      ['!', ['to-boolean', ['get', 'hidden']]],
      ['match', ['get', 'kind'], REDRAWN, false, true],
    ];
    // The closed block keeps its FILL here and loses its stroke: it is a
    // building, so it needs the same solid grey every other building has under
    // it, and addClosedLayers puts the red wash, the hatch and the outline on
    // top of that. Drawn on nothing but ground it read as a tinted patch of
    // lawn — which is exactly what it is not.
    const visibleLines = ['all', visible, ['!=', ['get', 'kind'], CLOSED_KIND]];
    // Under the legend's outlines when they exist, and this is not optional.
    // The sheet arrives from the server, so on a cold load the highlight layers
    // are already standing when it lands; anchoring both to the network alone
    // put the later arrival on top, and my campus's opaque building fills painted out
    // every outline the legend drew. The sheet is ground and the outline
    // annotates the ground, so the order is fixed rather than incidental.
    const anchor = map.getLayer('highlight-fill') ? 'highlight-fill' : belowNetwork();

    map.addLayer({
      id: 'campus-sheet-fill',
      type: 'fill',
      source: 'campus-sheet',
      slot: 'middle',
      // Everything my campus gave a fill, PLUS the pitches — and the pitches are the
      // exception because my campus did not give them one.
      //
      // Only 2 of the sheet's 22 `sport` shapes carry a fill: the stadium's
      // track and one other. The remaining 19 are polygons drawn as white
      // touchlines over the lawn, which is how a printed sheet says "pitch"
      // and how a vector map says nothing at all — they never entered this
      // layer, so the soccer, baseball, softball and tennis grounds were lawn
      // with an outline on top while the one filled shape sat there in pitch
      // green looking like the odd one out.
      //
      // The geometry is already the right shape. It only needed to be allowed
      // in, and `sheetPaint` has had a colour waiting for it the whole time.
      // ...and the twelve courts arrive the same way and need the same
      // exception: stroke-only shapes that have to be let in as surfaces.
      // ...minus the bay dividers, which are drawn by campus-rake below as
      // lines. Left in here as well they would be the same 1,004 bars twice
      // over, and the fill is the copy that cannot be seen at most zooms.
      filter: ['all', visible,
        ['!=', ['get', 'kind'], 'parking_stripe'],
        ['any', ['has', 'fill'], ['in', ['get', 'kind'], ['literal', ['sport', 'tennis', 'tennis_apron']]]]],
      layout: { 'fill-sort-key': ['get', 'i'] },
      paint: {
        'fill-color': fillColour,
        'fill-opacity': ['coalesce', ['get', 'opacity'], 1],
        // Same reasoning as the mask: Standard would otherwise light these
        // through its own model, and the night preset swallows them.
        'fill-emissive-strength': 1,
      },
    }, anchor);

    map.addLayer({
      id: 'campus-sheet-line',
      type: 'line',
      source: 'campus-sheet',
      slot: 'middle',
      filter: ['all', visibleLines, ['has', 'stroke']],
      layout: { 'line-sort-key': ['get', 'i'], 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': lineColour,
        'line-width': groundWidth(0.4),
        'line-opacity': ['coalesce', ['get', 'opacity'], 1],
        'line-emissive-strength': 1,
      },
    }, anchor);

    // The rake.
    //
    // Butt caps, not the round ones the sheet's other strokes take: a divider
    // is a painted bar with a square end, and a round cap would add half its
    // own width at each end — half a metre of overhang on a 7.9 m bar, which is
    // the difference between a bay and a bay with feet.
    //
    // The 1.2 px floor is the whole point of the layer. Below it a divider is
    // sub-pixel and Mapbox can only render it as a fraction of a pixel's worth
    // of coverage, which is what turned a rank of them into a moire; at 1.2 it
    // is a line. Above about z18.5 the true 0.99 m is wider than the floor and
    // the floor stops applying, so from there on this draws exactly the bar my campus
    // drew, in exactly the place they drew it.
    map.addLayer({
      id: 'campus-rake',
      type: 'line',
      source: 'campus-rake',
      slot: 'middle',
      layout: { 'line-sort-key': ['get', 'i'], 'line-cap': 'butt' },
      paint: {
        'line-color': land.parking_stripe,
        'line-width': groundWidth(1.2),
        'line-emissive-strength': 1,
      },
    }, anchor);
  }
  // -------------------------------------------------------------------------
  // The closed building
  //
  // One shape on the sheet carries `kind: "closed"` — the fenced-off block in
  // the middle of the campus — and one label reads "Closed" over the top of it.
  // my campus prints both in the same grey as everything else, which makes the one
  // place on this map you cannot go look exactly like the places you can.
  //
  // So it keeps the grey every other building has and gains a red wash and a
  // hard red outline over it, with the word itself in red once you are close
  // enough for the word to be worth reading.
  //
  // Three passes, and it was four: a diagonal hatch sat over the wash. It went
  // because a texture on a map whose every other shape is flat colour was the
  // loudest thing on the campus, and it was shouting on behalf of one small
  // block. It did not scale either — `fill-pattern` tiles in SCREEN space, so
  // zooming out packed the stripes tighter until they were a solid red smear
  // where a quiet tint belonged.
  // -------------------------------------------------------------------------




  /**
   * The wash, the hatch and the outline. The word is a label layer — it lives
   * with the other labels in buildLabelLayers, above the pins rather than under
   * them.
   *
   * Rebuilt on every style swap and recoloured in place on a theme change, the
   * same shape as every other builder here.
   */
  function addClosed() {
    if (!litPalette().land) {
      // Over imagery the sheet is not drawn at all, so neither is this.
      for (const id of ['campus-closed-line', 'campus-closed-fill']) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      return;
    }
    // Nothing here is theme-dependent — one red in both looks, because a
    // closure is not a mood — so an existing set needs no repaint.
    if (map.getLayer('campus-closed-fill')) return;
    if (!sheet() || !map.getSource('campus-sheet')) return;

    const only = ['==', ['get', 'kind'], CLOSED_KIND];
    // The wash is ground and sits with the ground: under the paths, and under
    // the legend's outlines when they are up. The outline does not — see
    // belowRoute, and note the two anchors are deliberately different.
    const anchor = map.getLayer('highlight-fill') ? 'highlight-fill' : belowNetwork();

    map.addLayer({
      id: 'campus-closed-fill',
      type: 'fill',
      source: 'campus-sheet',
      slot: 'middle',
      filter: only,
      paint: {
        'fill-color': CLOSED_RED,
        // A wash over the building grey, not a colour of its own. There was a
        // hatch on top of this and it is gone: on a map whose every other shape
        // is flat colour, a texture was the loudest thing on the campus, and it
        // was shouting on behalf of one small block. Wash and outline say the
        // same thing quietly, and they scale — a hatch is a fixed pixel grid, so
        // zooming out packed it into a solid red smear.
        'fill-opacity': 0.1,
        'fill-emissive-strength': 1,
      },
    }, anchor);

    map.addLayer({
      id: 'campus-closed-line',
      type: 'line',
      source: 'campus-sheet',
      slot: 'middle',
      filter: only,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': CLOSED_RED,
        // Barely over the sheet's own 0.4. It was 1.4 and reading as a warning
        // band: this shape is the only red on an otherwise grey-and-mint
        // campus, so it does not need weight to be found — being red is already
        // the whole of the emphasis, and the width was spending it twice.
        'line-width': groundWidth(0.6),
        // Washed rather than solid, for the same reason. Held above the paths
        // it crosses (see belowRoute) so the boundary still reads as continuous
        // — that is what the layer is FOR — but at an opacity where it sits in
        // the sheet rather than on top of it.
        'line-opacity': 0.45,
        'line-emissive-strength': 1,
      },
    }, belowRoute());
  }
  return { add, addClosed };
}
