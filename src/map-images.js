// Map furniture drawn at runtime: the amenity pictograms registered as map
// images, and the pin element the route markers are built from.
//
// Amenity pictograms are drawn as SVG rather than shipped as
// a sprite sheet so there is no binary asset to keep in step with the data.
//
// The set is deliberately one shape so a dozen unrelated icons still read as
// one family at 20 px on a busy map — and the shape is Google's marker, because
// on the Google ground ours were sitting next to theirs and losing the
// comparison. Theirs is a balloon: a round head on a tapered tail, a white ring
// around the whole silhouette, a white glyph inside, and the tip on the place
// it names. Ours were flat discs centred on it. Side by side that read as two
// map's markers on one map, which is what it was.
//
// Measured off the raster rather than guessed: a Google POI marker is about
// 17 px wide and 21 px tall at 1x, its white ring is 1.7 px of that, and its
// label sits to the right, vertically centred on the head rather than the tip.
//
// Colours are sampled from a Google Maps screenshot rather than picked: their
// category hues are #ff8126 for food and drink, #0b57d0 for transport, parking
// and services, #ea4335 for medical, #b56aff for arts, #17a773 for parks. An
// earlier set followed my campus's printed legend instead (tan permit machines, teal
// vending), which is a different map's vocabulary.
//
// Every icon carries the white ring: these sit on lawn, paving and imagery in
// turn, and without it the dark ones vanish into the trees.

// The pin is authored on a 26x31 grid, rasterised at 2x. A hair of margin all
// round so the ring and the ground shadow are never clipped.
//
// The proportions are measured, and both of them were wrong on the first cut.
// Google's marker is 50 px wide and 60 tall in a 3x capture — so the tail drops
// only about four tenths of the head's radius below it, where a pin drawn "by
// eye" comes out nearly twice that and reads as a balloon on a string. And
// their white ring is a good eighth of the total width, not the hairline a
// 2 px stroke gives at this size.
const PIN = { w: 26, h: 31, cx: 13, cy: 13, r: 10.4, ring: 3.2, tail: 0.42 };

/** kind -> disc colour. Anything absent falls back to Google's service blue. */
const COLOURS = {
  // Red stays rare on a Google map, which is what makes it mean something.
  // Only the two genuinely medical kinds get it; the emergency phones are 84
  // features and would drown the campus in alarm colour.
  defibrillator: '#ea4335',
  health_centre: '#ea4335',
  emergency_phone: '#0b57d0',
  parking_permit: '#0b57d0',
  restroom: '#0b57d0',
  bike_rack: '#0b57d0',
  motorcycle_parking: '#0b57d0',
  drop_off: '#0b57d0',
  drink_vending: '#ff8126',
  food_vending: '#ff8126',
  bus_stop: '#0b57d0',
  parking_badge: '#0b57d0',

  // Category-only discs. These have no pictogram on my campus's sheet and no row in
  // amenities.json — they are directory entries (parking lots, HomeBases, the
  // cafeteria) that a chip in src/categories.js has to drop pins for.
  // Registered here so the whole set is one family and one loader.
  parking: '#0b57d0',
  food: '#ff8126',
  homebase: '#b56aff',

  // Building POI discs, one per class in src/poi.js. These are the ones that
  // sit on the map all the time, beside my campus's printed building names, and the
  // colour is the point: Google's map is scannable because its categories are
  // hues, and my campus's sheet sets all 39 building names in the same ink.
  campus: '#0b57d0',
  library: '#0b57d0',
  store: '#0b57d0',
  civic: '#0b57d0',
  childcare: '#0b57d0',
  arts: '#b56aff',
  sport: '#17a773',
  works: '#5f6368',
};

const FALLBACK = '#0b57d0';

// Glyphs on a 24x24 grid, centred. Filled unless the entry says otherwise —
// the two vehicles are line drawings, which stay legible when a filled version
// would just be a blob at this size.
const GLYPHS = {
  defibrillator: '<path d="M13.4 4 7 13.2h3.6L9.9 20l6.4-9.4h-3.6z"/>',
  health_centre: '<path d="M10.4 5h3.2v3.9h3.9v3.2h-3.9V16h-3.2v-3.9H6.5V8.9h3.9z"/>',
  emergency_phone:
    '<path d="M9.1 5.2a1.2 1.2 0 0 1 1.7.4l1.2 2a1.2 1.2 0 0 1-.3 1.6l-1.2.9a9.2 9.2 0 0 0 3.9 3.9l.9-1.2a1.2 1.2 0 0 1 1.6-.3l2 1.2a1.2 1.2 0 0 1 .4 1.7l-.9 1.3a2 2 0 0 1-2.2.8C11.7 16.3 7.7 12.3 6.4 7.3a2 2 0 0 1 .8-2.2z"/>',
  parking_permit:
    '<path fill-rule="evenodd" d="M9 5.4h4.3a4.3 4.3 0 0 1 0 8.6h-1.8v4.6H9zm2.5 2.5v3.6h1.8a1.8 1.8 0 0 0 0-3.6z"/>',
  restroom: '<path d="M12 7.4l4.8 8.6H7.2z"/>',
  drop_off:
    '<path d="M5.6 13.1 7 9.5a2 2 0 0 1 1.9-1.3h6.2A2 2 0 0 1 17 9.5l1.4 3.6v4.6h-2.2v-1.4H7.8v1.4H5.6zm2.6-.6h7.6l-.9-2.3H9.1z"/>',
  drink_vending:
    '<path d="M7.6 6.2h8.8l-.6 2H8.2zm.8 3.4h7.2l-.9 8.2a1.4 1.4 0 0 1-1.4 1.2h-2.6a1.4 1.4 0 0 1-1.4-1.2z"/>',
  food_vending:
    '<path d="M8.4 4.6h1.4v4h.9v-4h1.4v4h.9v-4h1.4v5a2.3 2.3 0 0 1-1.8 2.2v7.6h-2.4v-7.6A2.3 2.3 0 0 1 8.4 9.6zm7.4 0h1.6v14.8h-1.6v-5.6h-1.2V8.2a3.6 3.6 0 0 1 1.2-2.7z"/>',
  bike_rack: {
    stroke:
      '<circle cx="7.4" cy="15.2" r="3.3"/><circle cx="16.6" cy="15.2" r="3.3"/>'
      + '<path d="M7.4 15.2 11 8.6h4.2l1.4 6.6M9.6 8.6h3.6"/>',
  },
  motorcycle_parking: {
    stroke:
      '<circle cx="6.9" cy="15.4" r="3.1"/><circle cx="17.1" cy="15.4" r="3.1"/>'
      + '<path d="M6.9 15.4h4l3-4.4h2.6l.6 4.4M12.6 7.6h2.6l1.3 3.4"/>',
  },
  // The lot pin reuses the legend's own mark, a capital P — same letter my campus
  // prints, and it reads at 20 px where a car silhouette would not.
  parking: '<path fill-rule="evenodd" d="M8.6 5h4.6a4.6 4.6 0 0 1 0 9.2h-1.9V19H8.6zm2.7 2.7v3.8h1.9a1.9 1.9 0 0 0 0-3.8z"/>',
  bus_stop:
    '<path d="M7.2 4.4h9.6a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1 1.6v1.4a.8.8 0 0 1-.8.8h-1a.8.8 0 0 1-.8-.8v-1.2H9v1.2a.8.8 0 0 1-.8.8h-1a.8.8 0 0 1-.8-.8v-1.4a1.8 1.8 0 0 1-1-1.6V6.2a1.8 1.8 0 0 1 1.8-1.8zm-.3 2.2v5h10.2v-5zm1.5 6.4a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm7.2 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"/>',
  food:
    '<path d="M8 4.4h1.3v3.8h.8V4.4h1.3v3.8h.8V4.4h1.3v4.8a2.2 2.2 0 0 1-1.7 2.1v7.3h-2.1v-7.3A2.2 2.2 0 0 1 8 9.2zm7.1 0h1.5v15h-1.5v-5.7h-1.2V8a3.5 3.5 0 0 1 1.2-2.6z"/>',
  homebase: '<path d="M12 4.2 20 11h-2.4v7.5h-4.3v-4.4h-2.6v4.4H6.4V11H4z"/>',

  // --- building POI glyphs ---------------------------------------------------
  // Read at about 14 px, which rules out anything with interior detail. The two
  // that punch holes (palette, bag handle) do it with fill-rule so the disc
  // colour shows through rather than a second white shape.
  campus:
    '<path d="M12 3.2 21 8.8H3zM3.8 11.4h16.4v9.4H3.8zm2.9 2.5v4.3h2.3v-4.3zm4.1 0v4.3h2.4v-4.3zm4.2 0v4.3h2.3v-4.3z"/>',
  library:
    '<path d="M3.6 6.1c2.5-1.4 5.2-1.4 7.7 0v11.8c-2.5-1.4-5.2-1.4-7.7 0zm9.1 0c2.5-1.4 5.2-1.4 7.7 0v11.8c-2.5-1.4-5.2-1.4-7.7 0z"/>',
  arts:
    '<path fill-rule="evenodd" d="M12 3.2c5 0 9 3.4 9 7.6a4.9 4.9 0 0 1-4.9 4.9h-1.9a1.3 1.3 0 0 0-.9 2.2c.3.3.4.7.4 1.1 0 .9-.7 1.6-1.6 1.6-5 0-9-3.9-9-8.7s4-8.7 8.9-8.7zM7.3 12.6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm2.7-4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm4.3 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm3.3 2.6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/>',
  sport:
    '<path d="M2.6 9.6h2.1V7.2h2.7v9.6H4.7v-2.4H2.6zm18.8 0h-2.1V7.2h-2.7v9.6h2.7v-2.4h2.1zM7.9 10.8h8.2v2.4H7.9z"/>',
  store:
    '<path fill-rule="evenodd" d="M12 2.4a4.4 4.4 0 0 1 4.4 4.4v.8H20l-1.2 13.4H5.2L4 7.6h3.6v-.8A4.4 4.4 0 0 1 12 2.4zm2.2 5.2v-.8a2.2 2.2 0 0 0-4.4 0v.8z"/>',
  civic: '<path d="M12 2.6 20 5.4v6.1c0 4.6-3.2 8.9-8 9.9-4.8-1-8-5.3-8-9.9V5.4z"/>',
  childcare:
    '<path d="M8.5 3.2a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2zM6 8.6h5l1.7 6.3h-2v6.1H7.3v-6.1H5.3zM16.6 8a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4zm-2 4.2h4l1.3 4.7h-1.5V21h-3.6v-4.1h-1.5z"/>',
  works:
    '<path d="M17.4 2.8c.8 0 1.6.1 2.3.4l-3.4 3.4 2.6 2.6 3.4-3.4c.3.7.4 1.5.4 2.3a5.9 5.9 0 0 1-7.8 5.6L6.4 22 2.6 18.2l8.3-8.5A5.9 5.9 0 0 1 17.4 2.8z"/>',
};

// The badge my campus paints in a car park and the pin a parking category drops are
// the same mark; one definition, addressed under both names.
GLYPHS.parking_badge = GLYPHS.parking;

/** How far the point drops below the centre of the head. */
const DROP = PIN.r * (1 + PIN.tail);
/** Where the tip lands, which is what `icon-anchor: bottom` puts on the place. */
export const PIN_TIP = PIN.cy + DROP;

/**
 * The balloon silhouette.
 *
 * Two mirrored curves leaving the head at its widest point, then a half circle
 * back over the top. Leaving from the WIDEST point matters: the circle's tangent
 * there is vertical, so a control point directly below it continues the curve
 * smoothly. Start the tail anywhere else and the join is a visible corner, which
 * is the difference between a pin and a lollipop.
 */
const n = (v) => Number(v.toFixed(3));
const PIN_PATH = [
  `M${n(PIN.cx - PIN.r)} ${n(PIN.cy)}`,
  `C${n(PIN.cx - PIN.r)} ${n(PIN.cy + DROP * 0.55)}`,
  `${n(PIN.cx - PIN.r * 0.34)} ${n(PIN.cy + DROP * 0.86)}`,
  `${n(PIN.cx)} ${n(PIN_TIP)}`,
  `C${n(PIN.cx + PIN.r * 0.34)} ${n(PIN.cy + DROP * 0.86)}`,
  `${n(PIN.cx + PIN.r)} ${n(PIN.cy + DROP * 0.55)}`,
  `${n(PIN.cx + PIN.r)} ${n(PIN.cy)}`,
  // Sweep 0 takes the short way over the top rather than back down through the
  // tail we just drew.
  `A${PIN.r} ${PIN.r} 0 0 0 ${n(PIN.cx - PIN.r)} ${n(PIN.cy)}Z`,
].join(' ');

// The glyphs are authored on a 24-unit grid centred at (12, 12). This sits them
// in the head at the largest size that still leaves the ring clear of them —
// the ring is a centred stroke, so half of its 3.2 eats into the fill and the
// usable head radius is 8.8, not 10.4.
const GLYPH_SCALE = 0.72;
const GLYPH_FIT = `translate(${PIN.cx} ${PIN.cy}) scale(${GLYPH_SCALE}) translate(-12 -12)`;

function svgFor(kind) {
  const glyph = GLYPHS[kind] ?? '<circle cx="12" cy="12" r="3.4"/>';
  const body = typeof glyph === 'string'
    ? `<g fill="#fff">${glyph}</g>`
    : `<g fill="none" stroke="#fff" stroke-width="${(1.7 / GLYPH_SCALE).toFixed(2)}" `
      + 'stroke-linecap="round" stroke-linejoin="round">' + glyph.stroke + '</g>';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIN.w} ${PIN.h}" `
    + `width="${PIN.w * 2}" height="${PIN.h * 2}">`
    // A flattened ellipse on the ground rather than a blur filter: an SVG filter
    // inside an <img> is renderer-dependent, and this has to rasterise the same
    // way in every browser that loads the map.
    + `<ellipse cx="${PIN.cx}" cy="${n(PIN_TIP + 0.9)}" rx="3.2" ry="1.2" fill="rgba(0,0,0,0.22)"/>`
    + `<path d="${PIN_PATH}" fill="${COLOURS[kind] ?? FALLBACK}" `
    + `stroke="#fff" stroke-width="${PIN.ring}" stroke-linejoin="round"/>`
    + `<g transform="${GLYPH_FIT}">${body}</g>`
    + '</svg>'
  );
}

export const AMENITY_KINDS = Object.keys(COLOURS);

// --- map pins ---------------------------------------------------------------
//
// The label plate that used to live here is gone. It reproduced my campus's print
// convention — larger building names reversed out of a dark rounded box — and
// Google has no equivalent: every label on their map is plain text over a white
// halo. Those names are still set larger, which was the hierarchy the plate was
// really carrying.

const PIN_W = 26;
const PIN_H = 38;

/**
 * Google's map pin: a round head tapering to a point, with a hole punched
 * through it.
 *
 * Drawn as a DOM element rather than registered as a map image because these
 * are `mapboxgl.Marker`s, not symbol layers — markers are HTML, positioned by
 * the map rather than rendered into the canvas.
 *
 * `anchor: 'bottom'` at the call site is not optional: a marker centres on its
 * coordinate by default, which would bury the tip half a pin above the place it
 * is pointing at.
 */
export function googlePin(colour, { title = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'map-pin';
  el.style.width = `${PIN_W}px`;
  el.style.height = `${PIN_H}px`;
  if (title) el.title = title;
  el.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 38" width="${PIN_W}" `
    + `height="${PIN_H}" aria-hidden="true">`
    // A blurred ellipse on the ground rather than a filter on the pin itself,
    // which would darken the white hole as well.
    + '<ellipse cx="13" cy="35.4" rx="4.2" ry="1.7" fill="rgba(0,0,0,0.28)"/>'
    + `<path fill="${colour}" d="M13 1.2A10.4 10.4 0 0 0 2.6 11.6c0 7.6 10.4 24 10.4 24`
    + 's10.4-16.4 10.4-24A10.4 10.4 0 0 0 13 1.2z"/>'
    // The hole is white rather than a lighter tint of the pin so it stays a hole
    // over imagery, where the surrounding photograph supplies no fixed value.
    + '<circle cx="13" cy="11.6" r="3.9" fill="#ffffff"/>'
    + '</svg>';
  return el;
}

/**
 * Rasterise every pictogram and register it under its `kind`, so the symbol
 * layer can address them with ['get', 'kind'].
 *
 * Resolves rather than rejects on a decode failure: a missing icon costs one
 * marker, and taking the whole overlay down for it would be a worse trade.
 * Images do not survive setStyle, hence hasImage rather than a load-once flag.
 */
export function loadAmenityIcons(map) {
  return Promise.all(AMENITY_KINDS.map((kind) => new Promise((resolve) => {
    if (map.hasImage(kind)) {
      resolve();
      return;
    }
    const image = new Image(PIN.w * 2, PIN.h * 2);
    image.onload = () => {
      if (!map.hasImage(kind)) map.addImage(kind, image, { pixelRatio: 2 });
      resolve();
    };
    image.onerror = () => resolve();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgFor(kind))}`;
  })));
}
