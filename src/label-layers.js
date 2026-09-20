// The campus's own printed names, and the invisible layer that makes buildings
// tappable.
//
// Two jobs that share every colour rule they have. `labelPaint` decides the ink
// for a kind and `labelInk` decides whether that kind is tinted at all; the
// printed-label builder uses both, and so does the pin hover, which is why
// `labelPaint` is exported rather than kept inside.
//
// THE DIRECTORY LAYER DRAWS NOTHING. It is a transparent fill over the building
// footprints whose only purpose is to be hit by `queryRenderedFeatures` — a
// building is a shape on a printed sheet, with no geometry of its own in any
// layer a tap could land on, so without it "tap a building" had nothing to tap.
//
// Safe to call repeatedly: a style swap rebuilds them, a theme change recolours
// them in place.

import { loadAmenityIcons } from './map-images.js';
import { POI_LABEL_KINDS } from './poi.js';
import { sizeExpr, LABEL_SIZE } from './pin-select.js';
import { CLOSED_TEXT, CLOSED_INK, closedBearing } from './campus-sheet.js';

  /**
 * Buildings you can tap.
 *
 * src/directory.json is one feature per building — footprints folded together,
 * so tapping one of the Health Education Complex's nine shapes shows the whole
 * complex — carrying what the sheet calls it and which of my campus's destinations
 * are inside it.
 *
 * The hit layer is drawn at zero opacity rather than left out, because
 * queryRenderedFeatures only sees layers that are actually in the style. The
 * highlight is a second layer filtered to the selected building; a filter
 * needs no feature ids and no promoteId, which a feature-state approach would.
 */
export const NOTHING_SELECTED = ['==', ['get', 'officialName'], '\u0000'];

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.litPalette   the palette at the current time of day
 * @param {Function} deps.mapFont      the face the current skin sets labels in
 * @param {Function} deps.skin         which look is on
 * @param {Function} deps.printed      the labels overlay, once it has landed
 * @param {Function} deps.directory    the building directory overlay
 * @param {Function} deps.sheet        the basemap overlay, for the closed block
 * @param {Function} deps.pinRing      the ring colour the pictograms are drawn with
 * @param {Function} deps.labelFilter  what one label kind may draw
 * @param {Function} deps.inkFor       the marker layers' text-colour expression
 * @param {Function} deps.theme        'light' or 'dark'
 */
export function createLabelLayers({
  map,
  litPalette,
  mapFont,
  skin,
  printed,
  directory,
  sheet,
  pinRing,
  labelFilter,
  inkFor,
  theme,
}) {
  /**
   * The printed map's own labels.
   *
   * These used to come from places.json, which is my campus's destination database —
   * names written to be unambiguous in a search box, not on a map, so the
   * Portable Village arrived as "Manufacturing, Construction, and Transportation
   * Division - Portable Village, Room 603B". scripts/build-labels.mjs takes what
   * their cartographer actually set instead: "Library", "Main Gym", "STADIUM".
   * places.json is still what search reads; it was only ever wrong for labels.
   *
   * One layer per kind rather than one for all four, because they differ in
   * weight, tracking and colour — and `text-font` is a layout property that
   * takes no data expression, so a single layer could not set Medium for area
   * names and Regular for the rest whatever the paint said.
   *
   * `plate` is my campus's name for their larger building labels, kept because it is
   * the source data's vocabulary. The dark box it refers to is not drawn any
   * more; see addLabelLayers.
   */
  const LABEL_KINDS = ['area', 'plate', 'building', 'parking'];

  /**
   * my campus's hierarchy, at Google's sizes.
   *
   * Keeping the point size the cartographer set is right — Library is 13.1 pt
   * against Oak Cafe's 6.6, and that ordering is real information. Using those
   * numbers AS pixels is not: they were set for a sheet 34 inches wide, and
   * multiplied straight through they gave a spread of 6.6 to 16 px against the
   * 11 to 15 Google sets its own labels in. Ours were visibly the smaller map's
   * type sitting on the bigger map's ground, which is most of what made the two
   * halves look like two maps.
   *
   * So the print range is mapped onto theirs and the ordering survives the
   * remap. Measured off the raster rather than taken from a spec: a Google road
   * label is 11-12 px, an ordinary POI 12, a prominent one 14-15.
   */
  const GOOGLE_BAND = ['interpolate', ['linear'], ['get', 'pt'], 6, 11, 14.5, 16];

  /**
   * ...and a much flatter zoom ramp than print scaling implies.
   *
   * This is the other half of the mismatch, and the more visible one while
   * moving: a Google label is very nearly the same size at z15 and at z19,
   * because their type is chrome for reading the map rather than something
   * drawn on the ground. Ours scaled 1.1x to 1.9x across that range, so the two
   * agreed at one zoom and diverged either side of it. 0.86 to 1.1 keeps a
   * little of the growth — labels are allowed to breathe as you zoom in — with
   * nothing like the drift.
   */
  const labelSize = (scale) => [
    'interpolate', ['linear'], ['zoom'],
    15, ['*', GOOGLE_BAND, 0.86 * scale],
    17, ['*', GOOGLE_BAND, 1.0 * scale],
    19, ['*', GOOGLE_BAND, 1.1 * scale],
  ];

  /**
   * Ink for one label kind, so the layer builder and the theme-switch path
   * cannot drift apart — they used to set these from two separate expressions
   * and a fourth kind would silently keep the old colour on a theme change.
   *
   * Google colours a label by what it names, not by its size: greenspace is
   * green, everything built is the same cool slate, and parking is that slate
   * lightened rather than a hue of its own.
   */
  /**
   * A building name takes its POI disc's hue, the way an amenity name does.
   *
   * Same rule Apple applies and the same reason: a label tinted with its
   * marker's colour is readable as a category before it is readable as a word.
   * Only the ones that HAVE a disc, though — an area name has no marker to
   * agree with, so those keep the map's own ink.
   *
   * A car park now has a disc and still keeps its own ink, which is the one
   * place these two sets come apart. The tint is not free: it is worth paying
   * where it separates ten categories from each other, and a car park is in a
   * category of one. What it would cost is measured — the lot names sit on the
   * lot, and against `land.parking` the parking blue reads 3.09:1 at night
   * where `parkingLabel` reads 3.78:1, and by day it lands at 10.93:1, a navy
   * so much heavier than the surrounding type that the lots would read as the
   * loudest names on the campus. `parkingLabel` was itself placed by measuring
   * against that surface; see the note on it in src/palette.js.
   */
  const POI_TINTED_KINDS = new Set(['building', 'plate']);

  const labelPaint = (kind, colors) => (POI_TINTED_KINDS.has(kind)
    ? ['case', ['has', 'poi'], inkFor('poi'), labelInk(kind, colors)]
    : labelInk(kind, colors));

  const labelInk = (kind, colors) => (
    kind === 'area' ? colors.areaLabel
      : kind === 'parking' ? colors.parkingLabel
        : colors.label
  );

  // Two constants used to live here — the widths a floating card had to clear
  // before it stopped opening underneath the route panel. The card is IN the
  // column with the route panel now rather than over the map, so there is
  // nothing left for it to collide with and no arithmetic to get wrong.

  function addDirectory() {
    const colors = litPalette();

    if (map.getLayer('campus-directory-fill')) {
      map.setPaintProperty('campus-directory-fill', 'fill-color', colors.route);
      map.setPaintProperty('campus-directory-line', 'line-color', colors.route);
      return;
    }
    if (!directory()) return; // still in flight; addNetworkLayers re-runs

    if (!map.getSource('campus-directory')) {
      map.addSource('campus-directory', { type: 'geojson', data: directory() });
    }

    map.addLayer({
      id: 'campus-directory-hit',
      type: 'fill',
      source: 'campus-directory',
      slot: 'middle',
      paint: { 'fill-opacity': 0 },
    });
    map.addLayer({
      id: 'campus-directory-fill',
      type: 'fill',
      source: 'campus-directory',
      slot: 'middle',
      filter: NOTHING_SELECTED,
      paint: { 'fill-color': colors.route, 'fill-opacity': 0.22, 'fill-emissive-strength': 1 },
    });
    map.addLayer({
      id: 'campus-directory-line',
      type: 'line',
      source: 'campus-directory',
      slot: 'middle',
      filter: NOTHING_SELECTED,
      paint: { 'line-color': colors.route, 'line-width': 2, 'line-emissive-strength': 1 },
    });
  }
  function addPrinted() {
    const colors = litPalette();

    if (map.getLayer('campus-labels-building')) {
      for (const kind of LABEL_KINDS) {
        map.setPaintProperty(`campus-labels-${kind}`, 'text-color', labelPaint(kind, colors));
        map.setPaintProperty(`campus-labels-${kind}`, 'text-halo-color', colors.labelHalo);
      }
      // Not in the loop above: the closed label is not one of LABEL_KINDS and
      // its red comes from its own two-value ramp rather than from the palette.
      if (map.getLayer('campus-labels-closed')) {
        map.setPaintProperty('campus-labels-closed', 'text-color',
          CLOSED_INK[theme() === 'dark' ? 'dark' : 'light']);
        map.setPaintProperty('campus-labels-closed', 'text-halo-color', colors.labelHalo);
      }
      return;
    }
    if (!printed()) return;

    if (!map.getSource('campus-labels')) {
      // `generateId` for the same reason the amenity source has it: a lifted pin
      // has to hide the symbol it came out of, and `['!=', ['id'], n]` is the
      // only way to name one feature of a layer. labels.json carries no ids.
      map.addSource('campus-labels', { type: 'geojson', data: printed(), generateId: true });
    }

    // The building names carry a POI disc now, so their images have to be
    // registered before a layer can reference one — same reason addAmenityLayer
    // waits, and the same loader, because they are one icon family.
    loadAmenityIcons(map, pinRing())
      .then(() => buildLabelLayers())
      .catch((error) => console.error('label icons unavailable:', error));
  }

  function buildLabelLayers() {
    // A style swap can land between the loader resolving and this running, and
    // the palette can have changed under it — so both are re-read here.
    if (map.getLayer('campus-labels-building') || !map.getSource('campus-labels')) return;
    const colors = litPalette();

    const common = {
      type: 'symbol',
      source: 'campus-labels',
      slot: 'middle',
      /*
       * 14, and it used to be 15 for a reason that turned out to be answered
       * elsewhere: "below this the campus is a few hundred pixels wide and the
       * labels are stacked on top of each other". They are not stacked — these
       * are symbol layers without `icon-allow-overlap`, so Mapbox's collision
       * index thins them, and `sortKey` above decides which survive: my campus's own
       * type hierarchy, biggest names first. Zooming out drops the small fry
       * and keeps the Library.
       *
       * What forced the change is where a phone actually lands. The map fits
       * the campus bounds, and on a 390x660 screen that is z14.71 — under the
       * old gate by a third of a level, so the app opened on a campus with
       * nothing named on it at all. Not a blank map exactly: lamps, paths and
       * building shapes, and not one word to say what any of them were.
       *
       * The amenities keep their own 16 and should: 72 markers is the case the
       * old comment was really describing, and none of them is what you open a
       * campus map to find.
       */
      minzoom: 14,
    };
    // Bigger type wins a collision, which is my campus's own hierarchy again.
    const sortKey = ['-', 0, ['get', 'pt']];

    /**
     * A disc at the point with the name set to its right, which is how Google
     * draws a POI and the reason their map is scannable — colour carries the
     * category, so you find the gym without reading 39 building names.
     *
     * `['get', 'poi']` evaluates to null for a feature that has none, and a
     * null icon-image simply draws no icon; the `case`s around the text put
     * that label back to plain centred type rather than leaving it offset into
     * empty space. Only "Closed" takes that path today — it names a fenced-off
     * area, not a place.
     */
    const poiLayout = {
      'icon-image': ['get', 'poi'],
      'icon-size': sizeExpr(LABEL_SIZE),
      // Centred on the coordinate: the resting marker is a disc, not a balloon,
      // so nothing about it points downward at a spot below itself.
      'icon-anchor': 'center',
      'text-anchor': ['case', ['has', 'poi'], 'top', 'center'],
      'text-justify': 'center',
      // BENEATH the disc, which is Apple's arrangement and a straightforwardly
      // easier one to hit than Google's. Their name sits beside the head, and
      // the lift that wants is a fixed ~12.5 px while `text-offset` has no unit
      // but ems — whatever size my campus happened to set that particular name at, so
      // one value could not be right for both the 11 px labels and the 16 px
      // ones. Underneath, the offset only has to clear the disc's lower half,
      // and a bigger name genuinely should stand further off a bigger disc, so
      // the em is the unit this actually wants.
      'text-offset': ['case', ['has', 'poi'], ['literal', [0, 0.9]], ['literal', [0, 0]]],
      // A disc makes each symbol wider, and width is what the collision solver
      // charges for: at the default view, adding them dropped 5 of the 21
      // building names that used to place. Trimming the default 2 px of padding
      // off both halves is what buys those back — measured, not guessed.
      'icon-padding': 0,
      'text-padding': 1,
    };

    for (const kind of LABEL_KINDS) {
      const area = kind === 'area';
      // `plate` is my campus's kind for their larger building names. The dark box it
      // is named after is gone — Google sets every label as plain haloed text —
      // so what survives is the weight and size those names already carried.
      const major = kind === 'plate';
      map.addLayer({
        ...common,
        id: `campus-labels-${kind}`,
        filter: labelFilter(kind),
        layout: {
          // Sentence case under Apple, my campus's own capitals everywhere else. The
          // string is derived at load rather than edited into labels.json —
          // see titleCase in src/poi.js for why, and for why the naive rule is
          // safe on these five names.
          'text-field': area && skin() === 'apple'
            ? ['coalesce', ['get', 'title'], ['get', 'text']]
            : ['get', 'text'],
          // Google's own hierarchy is set in weight, not colour: area names in
          // Medium, major buildings in Medium, everything else Regular. Bold
          // appears nowhere on their map at these sizes.
          'text-font': area || major ? mapFont().medium : mapFont().regular,
          'text-size': labelSize(area ? 0.95 : 1),
          // 8 ems is where the sheet breaks its own labels, so the printed ones
          // keep their original line breaks. The names added from my campus's database
          // have no printed breaks to reproduce and carry a width fitted to the
          // footprint instead — see build-labels.mjs.
          'text-max-width': ['coalesce', ['get', 'maxWidth'], 8],
          // 1.2 rather than 1.05: Google's lines sit further apart than my campus's
          // print setting, which is most of why their multi-line names read as
          // labels rather than as blocks of text.
          'text-line-height': 1.2,
          // my campus letterspaces its area capitals hard. Google tracks theirs only
          // slightly, so this is halved rather than dropped — losing it entirely
          // would make BASEBALL FIELD read as a building name.
          //
          // Apple tracks nothing. The reason the halving is safe to drop there
          // is that the case change above already does the separating: "Tennis
          // Courts" cannot be mistaken for a building name the way an untracked
          // TENNIS COURTS could.
          'text-letter-spacing': area && skin() !== 'apple' ? 0.07 : 0,
          'symbol-sort-key': sortKey,
          ...(POI_LABEL_KINDS.has(kind) ? poiLayout : {}),
        },
        paint: {
          'text-color': labelPaint(kind, colors),
          'text-halo-color': colors.labelHalo,
          // Standard's night preset would otherwise light the discs through its
          // own model and swallow them, the way it does the sheet.
          'icon-emissive-strength': 1,
          // Google's halo is a thin, slightly blurred casing rather than the
          // hard 1.4px outline a print sheet uses — enough to lift type off
          // mint lawn without the letters growing a visible white shell.
          'text-halo-width': 1.1,
          'text-halo-blur': 0.5,
          'text-emissive-strength': 1,
        },
      });
    }

    /**
     * "Closed", set on the block's own diagonal and in the red the shape is
     * drawn in.
     *
     * Its own layer rather than a `case` inside the building names, and for one
     * reason that could not be expressed there: `text-rotation-alignment` is a
     * LAYOUT property of the whole layer, not a per-feature one. This word has
     * to stay glued to the shape when the map is turned, and the other 39 names
     * have to stay upright — so they cannot share a layer, whatever else they
     * have in common.
     *
     * Deliberately the quietest label on the map. The wash and the outline are
     * what say the block is shut, and they say it at every zoom; the word only
     * names what the colour already meant, so it is fine print rather than a
     * headline. At the zoom the whole campus fits, a red shape reads instantly
     * and a 12px word across it is just clutter over one small building.
     *
     * `symbol-placement: point` with map-aligned rotation, not `line` placement
     * along the edge: the word belongs in the middle of the block saying what
     * the block is, not run along its boundary like a street name.
     */
    map.addLayer({
      ...common,
      id: 'campus-labels-closed',
      // Well past the 15 the other labels start at, and past the 16 the ambient
      // pictograms wait for. By here the block is a large shape on screen with
      // room inside it for a word, which is the only condition under which this
      // one is worth drawing.
      minzoom: 17.5,
      filter: ['==', ['get', 'text'], CLOSED_TEXT],
      layout: {
        'text-field': ['get', 'text'],
        // Regular, not the medium the building names use, and smaller than all
        // of them: this is an annotation on a shape, not the name of a place.
        'text-font': mapFont().regular,
        'text-size': labelSize(0.8),
        'text-letter-spacing': 0.06,
        'text-rotation-alignment': 'map',
        'text-rotate': closedBearing(sheet()),
        // Collidable like everything else. It was overlap-allowed on the
        // grounds that a warning must never be dropped, which was the wrong
        // reading: the red is the warning and it cannot be dropped, so the word
        // is free to give way to a name that has nowhere else to go.
      },
      paint: {
        'text-color': CLOSED_INK[theme() === 'dark' ? 'dark' : 'light'],
        'text-halo-color': colors.labelHalo,
        'text-halo-width': 1.1,
        'text-halo-blur': 0.5,
        'text-emissive-strength': 1,
      },
    });
  }
  return { addPrinted, addDirectory, labelPaint, labelInk };
}
