// Everything on this map that is a MARK rather than ground: the ambient amenity
// pictograms, the lamps that come on after dark, and the pins a category chip
// puts up in place of both.
//
// One module because they share their colour rules. `inkFor` builds the text
// expression all three use, and it has to answer differently over imagery than
// over a drawn sheet — a name set in the map's ink disappears into an aerial
// photograph — so the rule lives once and every marker layer asks it. Splitting
// them would mean either three copies of that or a fourth module holding it.
//
// Safe to call repeatedly: each recolours an existing layer rather than
// rebuilding it, so a theme switch — which no longer reloads the style —
// updates in place.

import { loadAmenityIcons, AMENITY_KINDS, pinInk } from './map-images.js';
import { SATELLITE } from './palette.js';
import { sizeExpr, LABEL_MAX_EM, AMBIENT_SIZE, CATEGORY_SIZE } from './pin-select.js';
import campusLamps from './lamps.json';

/** Nothing to draw, in the shape every geojson source expects. */
const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.litPalette     the palette at the current time of day
 * @param {Function} deps.mapFont        the face the current skin sets labels in
 * @param {Function} deps.theme          'light' or 'dark'
 * @param {Function} deps.basemap        'standard' or 'satellite'
 * @param {Function} deps.amenities      the amenity overlay, once it has landed
 * @param {Function} deps.bench          the lighting bench, for the lamp override
 * @param {Function} deps.clockPreset    dawn/day/dusk/night from the real sun
 * @param {Function} deps.shownCategory  the chip that is up, hover included
 * @param {Function} deps.shownHits      what that chip found
 * @param {Function} deps.amenityFilter  what the ambient layer may draw
 * @param {Function} deps.hiddenPin      the filter that hides a lifted pin
 * @param {Function} deps.paintLabels    re-apply the printed labels' filters
 */
export function createMarkerLayers({
  map,
  litPalette,
  mapFont,
  theme,
  basemap,
  amenities,
  bench,
  clockPreset,
  shownCategory,
  shownHits,
  amenityFilter,
  hiddenPin,
  paintLabels,
}) {
  /**
   * A `match` from a feature's kind to the ink its name is set in.
   *
   * Apple tints a POI's label with the marker's own hue rather than the map's
   * text colour, which is what lets a field of markers be read by colour before
   * a single word of it has been. Built as an expression rather than one flat
   * paint value because a symbol layer has one `text-color` and this map draws
   * eight categories through it.
   */
  const amenityHalo = () => litPalette().labelHalo;
  /** The ring the markers are drawn with, for the callers that have no `colors`. */
  const pinRing = () => litPalette().pinRing;

  const inkFor = (property) => {
    // Over imagery a tint has nothing fixed to sit against — foliage, tarmac
    // and pale roofs are all in one frame — so the names go back to the single
    // high-contrast colour that reads over all of it. Apple's satellite mode
    // drops the category tint for exactly the same reason.
    if (basemap() === 'satellite') return SATELLITE.label;
    return [
      'match',
      ['get', property],
      ...AMENITY_KINDS.flatMap((kind) => [kind, pinInk(kind, theme())]),
      pinInk('campus', theme()),
    ];
  };

  /**
   * Amenity pictograms and the names under them.
   *
   * The disc itself is not theme-dependent — it carries its own colour and a
   * white rim so it reads on lawn, paving and imagery alike — but the label is,
   * because a third-lightness hue on a near-black ground is a smudge.
   *
   * The layer is added inside the promise because setStyle drops registered
   * images along with the layers, so the icons have to be re-registered before
   * anything can reference them.
   */
  /**
   * The campus after dark: warm pools on the paths, and nothing standing in them.
   *
   * NO LAMP POSTS, deliberately. A post is a piece of street furniture the map
   * does not otherwise draw, at a scale where it would be two pixels of grey,
   * and drawing 251 of them would say "here is some clutter" rather than "this
   * is lit". What a person actually navigates by after dark is the LIGHT — which
   * way is bright — so the light is the thing drawn.
   *
   * Two circles per lamp, and both are needed. A single soft one is a smudge
   * with no centre and reads as fog; a single hard one is a dot and reads as a
   * marker. A wide blurred pool with a small bright core inside it is what a
   * lamp on paving actually looks like from above, and the core is what makes
   * the pool read as coming FROM somewhere.
   *
   * Positions are inferred rather than surveyed — see scripts/build-lamps.mjs,
   * which places them along the walk network at the spacing campus lighting is
   * designed to and refuses to put one inside a building.
   *
   * `circle-blur: 1` is the whole of the softness: at 1 the gradient runs from
   * the centre to the full radius with no hard edge anywhere, which is the only
   * way to get a falloff out of a circle layer. The alternative is a raster
   * sprite per lamp, which is 251 textures to draw a gradient.
   */
  const LAMP_WARM = '#ffc266';
  const LAMP_CORE = '#fff0d0';

  function addLamps() {
    if (!map.getSource('campus-lamps')) {
      map.addSource('campus-lamps', { type: 'geojson', data: campusLamps });
    }
    // Under everything that carries meaning — the paths, the pins, the labels —
    // because this is ground and not information. A pin lost inside its own
    // glow would be the light winning an argument it should not be in.
    const before = map.getLayer('campus-paths') ? 'campus-paths' : undefined;
    if (!map.getLayer('campus-lamp-pool')) {
      map.addLayer({
        id: 'campus-lamp-pool',
        type: 'circle',
        source: 'campus-lamps',
        slot: 'middle',
        paint: {
          'circle-color': LAMP_WARM,
          // Metres would be truer and Mapbox does not offer them here, so the
          // radius is interpolated over zoom to hold a roughly constant pool on
          // the ground — about 14 m across, which is what a 4 m pole throws.
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'],
            14, 3, 16, 11, 18, 42, 20, 168],
          'circle-blur': 1,
          'circle-opacity': 0,
          'circle-emissive-strength': 1,
          'circle-pitch-alignment': 'map',
        },
      }, before);
    }
    if (!map.getLayer('campus-lamp-core')) {
      map.addLayer({
        id: 'campus-lamp-core',
        type: 'circle',
        source: 'campus-lamps',
        slot: 'middle',
        paint: {
          'circle-color': LAMP_CORE,
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'],
            14, 0.6, 16, 2.2, 18, 8.4, 20, 33.6],
          'circle-blur': 0.9,
          'circle-opacity': 0,
          'circle-emissive-strength': 1,
          'circle-pitch-alignment': 'map',
        },
      }, before);
    }
    paintLamps();
  }

  /**
   * How lit the campus is, which is the inverse of how lit the sky is.
   *
   * Off in daylight — a lamp pool on sunlit paving is a stain — and up through
   * dusk to full at night. Dawn gets the same as dusk: the lights are still on,
   * they are just about to stop mattering.
   */
  const LAMP_BY_PRESET = { day: 0, dawn: 0.35, dusk: 0.55, night: 1 };

  function paintLamps() {
    if (!map.getLayer('campus-lamp-pool')) return;
    const preset = bench() && bench().preset !== 'auto'
      ? bench().preset : clockPreset();
    const lit = LAMP_BY_PRESET[preset] ?? 0;
    /*
     * The pool is weak even at full: it is a wash over ground somebody is
     * trying to read a map on, not a light source. The core carries the
     * brightness.
     *
     * AND NOT AT ALL UNTIL YOU ARE CLOSE ENOUGH FOR IT TO BE LIGHT. The whole
     * campus frames at z14.7, and there a lamp's pool is a 3px circle: 251 of
     * them are not a lit campus, they are 251 orange specks, and they were
     * comfortably the busiest thing on the night map — over the buildings, the
     * fields and the paths they are supposed to be lighting. The effect needs
     * the pools to be big enough to read as pools, which is a walking scale.
     *
     * Off at the framing zoom, full by 17.5, which is roughly where a single
     * building fills a phone. Interpolated rather than switched so that a
     * pinch does not flash them on.
     */
    const byZoom = (peak) => ['interpolate', ['linear'], ['zoom'], 16, 0, 17.5, peak];
    map.setPaintProperty('campus-lamp-pool', 'circle-opacity', byZoom(0.30 * lit));
    map.setPaintProperty('campus-lamp-core', 'circle-opacity', byZoom(0.55 * lit));
  }

  function addAmenity() {
    if (map.getLayer('campus-amenities')) {
      map.setPaintProperty('campus-amenities', 'text-color', inkFor('kind'));
      map.setPaintProperty('campus-amenities', 'text-halo-color', amenityHalo());
      // The discs are rasterised images, so a theme change cannot repaint them
      // — they have to be drawn again. Under Standard a theme change is a
      // config change rather than a setStyle, so nothing else clears them; the
      // loader compares the ring it was last given and re-rasterises only when
      // it has actually moved.
      loadAmenityIcons(map, pinRing());
      return;
    }
    if (!amenities()) return;

    if (!map.getSource('campus-amenities')) {
      // `generateId` is what makes one pin addressable. amenities.json carries
      // no identifier of its own — six features all say `defibrillator` — so
      // without this there is no filter that can hide the one that was tapped
      // and leave the other five standing.
      map.addSource('campus-amenities', {
        type: 'geojson',
        data: amenities(),
        generateId: true,
      });
    }
    loadAmenityIcons(map, pinRing()).then(() => {
      // A style swap can land between the two, taking the source with it.
      if (map.getLayer('campus-amenities') || !map.getSource('campus-amenities')) return;
      map.addLayer({
        id: 'campus-amenities',
        type: 'symbol',
        source: 'campus-amenities',
        slot: 'middle',
        // Below this the campus is a few hundred pixels across and 72 markers
        // is noise rather than information.
        minzoom: 16,
        layout: {
          'icon-image': ['get', 'kind'],
          // 0.54 to 0.65 of a 26-unit disc puts it at 14 to 17 px across, which
          // is the range Apple's own resting markers occupy. The stops live in
          // pin-select.js because a selected pin has to start its animation at
          // whatever size this is drawing right now.
          'icon-size': sizeExpr(AMBIENT_SIZE),
          // Centred, not bottom-anchored. The resting marker has no tail — it
          // is a disc sitting ON the place rather than a balloon pointing down
          // at one, so its middle is what goes on the coordinate.
          'icon-anchor': 'center',
          'icon-padding': 2,
          // The name goes underneath, which is the Apple arrangement and the
          // reason `text-anchor` is top: the anchor point is the coordinate, so
          // the offset has to clear the disc's own lower half.
          //
          // `name`, not `label`: only an amenity whose name identifies it gets
          // one printed, which is four of the eighty-four. The rest are the
          // icon's own meaning set in type — see withAmenityNames in poi.js.
          // Held to 17 on top of that, because even a real name is not worth
          // reading when the whole campus is on screen.
          'text-field': ['step', ['zoom'], '', 17, ['coalesce', ['get', 'name'], '']],
          'text-font': mapFont().medium,
          'text-size': 13,
          // Below, then above, then right, then left — see the same four on
          // category-pins for what the anchor names mean, which is not what
          // they sound like.
          'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
          'text-radial-offset': 0.85,
          'text-justify': 'auto',
          // Shared with the lifted marker's DOM label, so a name wraps on the
          // same words in both states — see LABEL_MAX_EM in pin-select.js.
          'text-max-width': LABEL_MAX_EM,
          // Never at the cost of the marker. 84 of these sit on one campus and
          // a good half of the names would collide at any useful zoom; the disc
          // is the information and the word is the elaboration.
          'text-optional': true,
        },
        paint: {
          'icon-emissive-strength': 1,
          'text-color': inkFor('kind'),
          'text-halo-color': amenityHalo(),
          'text-halo-width': 1.4,
          'text-emissive-strength': 1,
        },
      });
      // A style swap rebuilds this layer unfiltered, and the HTML marker of a
      // pin that was lifted before the swap survives it — so without this the
      // selected pin comes back small underneath its own enlarged self.
      paintCategory();
    }).catch((error) => console.error('amenity icons unavailable:', error));
  }
  /**
   * Pins for `match` categories.
   *
   * Its own source rather than appending to amenities.json, because these are
   * directory rows, not legend symbols: they carry a real name ("Myrtle Parking
   * Lot East") and only exist while their chip is pressed. Keeping them apart
   * means clearing a category is a setData(EMPTY), not a filter on a mixed set.
   */
  function addCategory() {
    const colors = litPalette();

    if (map.getLayer('category-pins')) {
      // Same shape as the other builders: a theme change re-runs this to
      // recolour what is already there rather than rebuilding it.
      map.setPaintProperty('category-pins', 'text-color', inkFor('icon'));
      map.setPaintProperty('category-pins', 'text-halo-color', colors.labelHalo);
      return;
    }
    if (!map.getSource('category-pins')) {
      map.addSource('category-pins', { type: 'geojson', data: EMPTY, generateId: true });
    }

    // Shares the amenity loader: the four discs these need are registered in
    // map-images.js alongside the legend's own, so there is one icon family and
    // one place it is rasterised.
    loadAmenityIcons(map, colors.pinRing).then(() => {
      if (map.getLayer('category-pins') || !map.getSource('category-pins')) return;
      map.addLayer({
        id: 'category-pins',
        type: 'symbol',
        source: 'category-pins',
        slot: 'middle',
        layout: {
          'icon-image': ['get', 'icon'],
          // Larger than the ambient pictograms. These are what the user just
          // asked to see, and at the zoom the whole campus fits in, the ambient
          // size renders them as specks against my campus's own printed symbols.
          // Google does the same thing: a search result is a bigger pin than
          // the POIs it lands among.
          'icon-size': sizeExpr(CATEGORY_SIZE),
          // Centred like the ambient discs: no tail, so the middle is the mark.
          'icon-anchor': 'center',
          // A category is a deliberate request to see all of them, so the pins
          // never drop out to a collision the way the ambient pictograms do.
          // Their names still do: `text-optional` keeps the pin when its label
          // will not fit, which is the only sane answer for the eight HomeBases
          // — my campus puts all of them inside the LRC, so with overlap allowed the
          // eight names print on top of each other.
          'icon-allow-overlap': true,
          'text-optional': true,
          'text-field': ['get', 'name'],
          'text-font': mapFont().medium,
          'text-size': 14,
          // Under the disc if the name fits there, and if it does not, above,
          // then right, then left. It used to be under or nowhere, and "nowhere"
          // is what a caption does when it loses a collision — so a row of pins
          // in a car park drew six discs and one word between them.
          //
          // READ THESE BACKWARDS. An anchor names the edge of the LABEL that is
          // pinned to the point, not the side of the point the label lands on:
          // 'top' fastens the label's top edge to the coordinate and so hangs it
          // BELOW, 'left' fastens its left edge and so puts it to the RIGHT.
          // This list is the order asked for — below, above, right, left —
          // written in those terms.
          'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
          // Replaces text-offset, which a variable anchor would apply in one
          // fixed direction for all four positions: the same [0, 0.95] that
          // clears the disc downwards would push the label above it a further
          // 0.95 em up, and the side ones down past its corner.
          // text-radial-offset is that distance along whichever direction the
          // anchor chose, so all four clear the disc by the same gap.
          'text-radial-offset': 0.95,
          // Follows the anchor: a label to the left of a pin ends flush against
          // it rather than centred on a point it is no longer under.
          'text-justify': 'auto',
          'text-max-width': LABEL_MAX_EM,
        },
        paint: {
          // Tinted with the disc's own hue rather than set in the map's ink.
          'text-color': inkFor('icon'),
          'text-halo-color': colors.labelHalo,
          'text-halo-width': 1.6,
          'icon-emissive-strength': 1,
          'text-emissive-strength': 1,
          // The entrance drives this. Anchored to the VIEWPORT because the sway
          // is a screen-space settle measured in screen pixels — left the
          // default and it would be bearing-relative, so the same animation
          // would swing along some compass direction on a rotated map.
          'icon-translate': [0, 0],
          'icon-translate-anchor': 'viewport',
        },
      });
      // A style swap can land between selecting a category and this resolving.
      paintCategory();
    }).catch((error) => console.error('category icons unavailable:', error));
  }

  /**
   * Push the current selection at the map: the filter and the pins.
   *
   * Two things narrow these layers now and they have to be combined rather than
   * written in turn — a category that set its own filter would put back the pin
   * a selection had just taken out, and the selected one would be drawn twice,
   * once small underneath its own animation.
   */
  function paintCategory() {
    const active = Boolean(shownCategory());

    // The ambient pictograms go away entirely while a category is up, and the
    // category draws every one of its own pins instead. Two reasons that beats
    // narrowing the existing layer's filter: that layer is minzoom 16, so a
    // filtered selection was invisible at the zoom the campus actually fits at;
    // and the category's pins overlap-allow and carry names, which the ambient
    // ones deliberately do not.
    if (map.getLayer('campus-amenities')) {
      map.setFilter('campus-amenities', active ? ['boolean', false] : amenityFilter());
    }
    if (map.getLayer('category-pins')) {
      map.setFilter('category-pins', hiddenPin('category-pins'));
    }

    const source = map.getSource('category-pins');
    if (!source) return;
    source.setData(active ? {
      type: 'FeatureCollection',
      features: shownHits().map((hit) => ({
        type: 'Feature',
        properties: { icon: hit.icon, name: hit.name ?? '' },
        geometry: { type: 'Point', coordinates: hit.coords },
      })),
    } : EMPTY);

    // The printed label pins go with them — same rule, different layers. Here
    // rather than at the two call sites so a style swap, which rebuilds these
    // from scratch, restores the same state this did.
    paintLabels();
  }
  return {
    inkFor,
    amenityHalo,
    pinRing,
    addAmenity,
    addLamps,
    paintLamps,
    addCategory,
    paintCategory,
  };
}
