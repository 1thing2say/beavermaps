// Images registered with the map at runtime: the amenity pictograms, and the
// plate that sits behind a label.
//
// Amenity pictograms are drawn as SVG rather than shipped as
// a sprite sheet so there is no binary asset to keep in step with the data.
//
// The set is deliberately one shape — a filled disc with a white glyph — so a
// dozen unrelated icons still read as one family at 20 px on a busy map. Colour
// carries the category, following my campus's own legend in
// campus-data/wayfind/external/campus-map.pdf: red for the defibrillators, blue
// for the emergency phones, tan for the permit machines, near-black for the
// wayfinding hardware.
//
// Each disc is drawn a hair inside the viewBox so the ring is not clipped, and
// every icon carries a white rim: these sit on lawn, paving and imagery in
// turn, and without it the dark ones vanish into the trees.

const SIZE = 44;

/** kind -> disc colour. Anything absent falls back to the slate below. */
const COLOURS = {
  defibrillator: '#d7263d',
  health_centre: '#123a63',
  emergency_phone: '#0093bd',
  parking_permit: '#b08442',
  restroom: '#2f3337',
  bike_rack: '#2f3337',
  motorcycle_parking: '#2f3337',
  drop_off: '#4a5568',
  drink_vending: '#3f6f5f',
  food_vending: '#3f6f5f',
};

const FALLBACK = '#4a5568';

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
};

function svgFor(kind) {
  const glyph = GLYPHS[kind] ?? '<circle cx="12" cy="12" r="3.4"/>';
  const body = typeof glyph === 'string'
    ? `<g fill="#fff">${glyph}</g>`
    : `<g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" `
      + `stroke-linejoin="round">${glyph.stroke}</g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${SIZE}" height="${SIZE}">`
    + `<circle cx="12" cy="12" r="11" fill="${COLOURS[kind] ?? FALLBACK}" `
    + 'stroke="#fff" stroke-width="1.8"/>'
    + body
    + '</svg>'
  );
}

export const AMENITY_KINDS = Object.keys(COLOURS);

// --- label plate ------------------------------------------------------------

const PLATE = 32;
const PLATE_RADIUS = 7;

/**
 * The rounded plate my campus sets its larger building names on, in white out of a
 * dark box. Registered as a stretchable image so `icon-text-fit` can size one
 * plate to any label rather than needing one asset per name.
 *
 * The stretch bands exclude the corner radius, which is what stops the corners
 * being smeared as the box widens. Re-registered on a theme change, because the
 * plate colour follows the theme and an image cannot be recoloured in place.
 */
export function loadLabelPlate(map, colour, id = 'label-plate') {
  const canvas = document.createElement('canvas');
  canvas.width = PLATE;
  canvas.height = PLATE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.roundRect(0, 0, PLATE, PLATE, PLATE_RADIUS);
  ctx.fill();

  const edge = PLATE_RADIUS + 1;
  if (map.hasImage(id)) map.removeImage(id);
  map.addImage(id, ctx.getImageData(0, 0, PLATE, PLATE), {
    pixelRatio: 2,
    stretchX: [[edge, PLATE - edge]],
    stretchY: [[edge, PLATE - edge]],
    content: [2, 2, PLATE - 2, PLATE - 2],
  });
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
    const image = new Image(SIZE, SIZE);
    image.onload = () => {
      if (!map.hasImage(kind)) map.addImage(kind, image, { pixelRatio: 2 });
      resolve();
    };
    image.onerror = () => resolve();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgFor(kind))}`;
  })));
}
