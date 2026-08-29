// Map furniture drawn at runtime: the amenity pictograms registered as map
// images, and the pin element the route markers are built from.
//
// Amenity pictograms are drawn as SVG rather than shipped as
// a sprite sheet so there is no binary asset to keep in step with the data.
//
// The set is deliberately one shape so a dozen unrelated icons still read as
// one family at 20 px on a busy map. That shape is APPLE'S now, measured off a
// capture of their Maps rather than described from memory — see the block of
// ratios below. It replaces Google's balloon, which this map wore until the
// selection animation was built and the marker it animated no longer matched
// the one the animation came from.
//
// The label moved with it, and that is the larger half of the change. Google
// writes a POI's name BESIDE its pin, vertically centred on the head; Apple
// writes it BENEATH, centred, and tints it with the marker's own category hue
// instead of the map's text colour. So every layer that draws one of these
// anchors centre rather than bottom, and every name that goes with one hangs
// under it in `pinInk` rather than beside it in slate.
//
// Colours are sampled from a Google Maps screenshot rather than picked: their
// category hues are #ff8126 for food and drink, #0b57d0 for transport, parking
// and services, #ea4335 for medical, #b56aff for arts, #17a773 for parks. An
// earlier set followed my campus's printed legend instead (tan permit machines, teal
// vending), which is a different map's vocabulary.
//
// Every icon carries the white ring: these sit on lawn, paving and imagery in
// turn, and without it the dark ones vanish into the trees.

// TWO STATES, both measured off a screen capture of Apple Maps rather than
// drawn by eye. Their marker is not one shape at two sizes — selecting a place
// changes what it is:
//
//   at rest    a CIRCLE, category-coloured, with a white ring a good eighth of
//              its width, centred ON the place. No tail: nothing is pointing,
//              because the disc is already sitting on the spot.
//   selected   a teardrop that RISES off the ground — round head, a short nub
//              rather than a tail — leaving a separate little dot behind on the
//              place itself. That dot is what keeps the exact position while
//              the head floats above it.
//
// Both fills carry the same vertical gradient; see FILL_TOP below, where the
// measurement that establishes they are the same one is written down.
//
// The numbers below are read off the capture at its own scale and divided
// through, so they are ratios rather than pixels:
//
//   at rest    30 px across, ring 3.5 px          -> ring = 0.117 of the width
//   selected   79 px across, ring ~5 px           -> ring = 0.070 of the width
//              widest at y=455, tip at y=499      -> the nub drops 0.152 r
//              anchor dot ~12 px across            -> 0.152 of the head
//
// This replaces Google's balloon, which is a rounder head on a much longer
// tail (0.42 r) and one flat fill. Both are good markers; they are not the same
// marker, and the ratios above are the difference.
/*
 * What the ring around a marker is drawn in.
 *
 * White on a light map, and it stays the default so every caller that has no
 * theme to hand keeps the behaviour it had. On a DARK map Apple rings the same
 * discs in charcoal instead — the ring is there to cut the marker out of the
 * ground, and on a dark ground a white one is the brightest thing on screen
 * competing with the labels. The value comes from the palette (`pinRing`), so
 * the two looks disagree about it the way they disagree about everything else.
 */
const RING_LIGHT = '#fff';

const PIN = { w: 26, cx: 13, cy: 13, ring: 3.05 };
/** Radius of the flat disc, inset so its centred ring lands inside the box. */
PIN.r = PIN.cx - PIN.ring / 2;

/** The lifted marker, on the same 26-unit grid. */
const LIFT = { ring: 1.82, tail: 0.152, dot: 0.152, gap: 0.10 };
LIFT.r = PIN.cx - LIFT.ring / 2;
/** How far the nub's tip falls below the head's centre. */
LIFT.drop = PIN.cx * (1 + LIFT.tail);
LIFT.dotR = (PIN.w * LIFT.dot) / 2;
/** Where the nub comes to a point. */
LIFT.tipY = PIN.cy + LIFT.drop;
LIFT.dotY = LIFT.tipY + PIN.w * LIFT.gap + LIFT.dotR;
/** Total height of the lifted marker, tip of the ring to the base of the dot. */
LIFT.h = LIFT.dotY + LIFT.dotR + 0.6;

/**
 * kind -> disc colour. Anything absent falls back to Google's service blue.
 *
 * ONE HUE PER FUNCTION, not one per file. This map used to spend a single blue
 * on eight of the twelve amenity kinds, which was survivable while every marker
 * carried its name in type beside it and stopped being survivable the moment
 * those names came off: a car park showed four telephones, two bike racks and
 * two parking marks as eight identical blue dots.
 *
 * The set is chosen by measurement rather than taste. Pairwise CIE-Lab distance
 * across every hue below has a minimum of 31.0 — which is what the six-hue
 * palette it replaces already scored (31.6, red against orange), so ten hues
 * cost nothing in separability while cutting the worst hue-sharing from eight
 * kinds to three.
 *
 * Four are Google's own, sampled off their raster and not up for renegotiation:
 * #ea4335 medical, #0b57d0 transport and parking, #e8710a food, #b56aff arts.
 * The rest were searched for maximum separation against those:
 *
 *   #fbbc04  emergency telephones — Google's yellow, and the colour a call point
 *            is painted in the physical world. The only hue here a white glyph
 *            cannot sit on; see glyphInk.
 *   #5b8c00  bike racks. Green is the obvious hue for a bicycle and Google's own
 *            #188038 is unavailable: this map already spent its green on sport,
 *            and #188038 sits dE 19.9 from it — close enough to read as the same
 *            marker. The olive is dE 42.1 away and unmistakable.
 *   #00a0b0  restrooms.
 *   #d01884  bus stops and drop-off, which are one thing: transit.
 */
const COLOURS = {
  // Medical, and red stays rare on a Google map, which is what makes it mean
  // something. Only the two genuinely medical kinds get it.
  defibrillator: '#ea4335',
  health_centre: '#ea4335',

  // Call for help. Yellow rather than the blue of a blue-light phone, because
  // fourteen of these are the densest set on the campus and blue is spoken for.
  emergency_phone: '#fbbc04',

  // Parking, in Google's own colour for it — the P is unmistakable and these
  // four kinds are meant to read as one family.
  parking_permit: '#0b57d0',
  parking_badge: '#0b57d0',
  motorcycle_parking: '#0b57d0',

  restroom: '#00a0b0',
  bike_rack: '#5b8c00',

  // Transit: a stop and a drop-off are the same errand.
  bus_stop: '#d01884',
  drop_off: '#d01884',

  drink_vending: '#e8710a',
  food_vending: '#e8710a',

  // Category-only discs. These have no pictogram on my campus's sheet and no row in
  // amenities.json — they are directory entries (parking lots, HomeBases, the
  // cafeteria) that a chip in src/categories.js has to drop pins for.
  // Registered here so the whole set is one family and one loader.
  parking: '#0b57d0',
  food: '#e8710a',
  homebase: '#b56aff',

  // The one place the parking family is deliberately split.
  //
  // Pointing at Parking answers with three sets at once — the named lots, the
  // ten machines you buy the permit from, and the two drop-off points — and in
  // Google's single blue the first two were one undifferentiated field. So the
  // machines get their own disc for that view: the same pictogram, in orange.
  //
  // This orange, and not one of its own, because the wheel is full. Ten hues
  // already sit dE 31 apart at the tightest, and #e8710a owns the whole orange
  // wedge: #ff6d00 is dE 12 from it, #e65100 is dE 15, and the nearest thing
  // that clears the separation floor is a dark ochre that reads as mustard. A
  // hue this table already trusts beats a near-miss of it that the floor would
  // have to be lowered to admit.
  //
  // Sharing is the established answer here anyway — defibrillators and the
  // health centre share red, bus stops and drop-off share pink — and the
  // sharing costs nothing where it lands: a category clears the campus before
  // its own pins arrive, so the vending machines that also wear this orange are
  // never on screen at the same time as these.
  //
  // The ambient `parking_permit` pictogram is untouched. On the map at rest,
  // and under its own Permit machines row, a machine is still Google blue.
  parking_meter: '#e8710a',

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

/**
 * The permit machine, drawn once and used by both discs that are one.
 *
 * `parking_permit` is the machine as my campus's sheet prints it; `parking_meter` is
 * the same machine in the lighter azure the Parking row needs to tell it apart
 * from the lots around it. Same object, so the same pictogram — the colour is
 * the only thing the two views disagree about, and a second hand-drawn machine
 * would be a way for them to start disagreeing about more.
 *
 * It was a capital P until the ambient machines came forward to z16. The lots
 * carry a blue P of their own now — one per car park, from the label layer —
 * and two blue P discs a few metres apart, differing only in size, are not two
 * answers to two questions, they are one answer printed twice. So the machine
 * gets the machine: a pay station's head, display, stem and foot. The BLUE
 * stays, because blue is what says parking on this map and a pay station is
 * parking; it is the glyph that has to carry "and this is the part you pay at".
 */
const PERMIT_MACHINE =
  '<path fill-rule="evenodd" d="M8.2 3h7.6a1.6 1.6 0 0 1 1.6 1.6v9a1.6 1.6 0 0 1-1.6 1.6h-2.6v3.6h3V21H7.8v-2.2h3v-3.6H8.2a1.6 1.6 0 0 1-1.6-1.6V4.6A1.6 1.6 0 0 1 8.2 3zm1.2 2.8v3.2h5.2V5.8z"/>';

// Glyphs on a 24x24 grid, centred. Filled unless the entry says otherwise —
// the two vehicles are line drawings, which stay legible when a filled version
// would just be a blob at this size.
const GLYPHS = {
  defibrillator: '<path d="M13.4 4 7 13.2h3.6L9.9 20l6.4-9.4h-3.6z"/>',
  health_centre: '<path d="M10.4 5h3.2v3.9h3.9v3.2h-3.9V16h-3.2v-3.9H6.5V8.9h3.9z"/>',
  emergency_phone:
    '<path d="M9.1 5.2a1.2 1.2 0 0 1 1.7.4l1.2 2a1.2 1.2 0 0 1-.3 1.6l-1.2.9a9.2 9.2 0 0 0 3.9 3.9l.9-1.2a1.2 1.2 0 0 1 1.6-.3l2 1.2a1.2 1.2 0 0 1 .4 1.7l-.9 1.3a2 2 0 0 1-2.2.8C11.7 16.3 7.7 12.3 6.4 7.3a2 2 0 0 1 .8-2.2z"/>',
  parking_permit: PERMIT_MACHINE,
  parking_meter: PERMIT_MACHINE,
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

const n = (v) => Number(v.toFixed(3));

/** The box the resting disc is drawn in, and where in it the disc sits. */
export const PIN_BOX = { w: PIN.w, h: PIN.w + 1.6 };

/**
 * The lifted silhouette: a round head on a short nub.
 *
 * Same construction as any teardrop — two mirrored curves leaving the head at
 * its WIDEST point, where the circle's tangent is vertical so a control point
 * directly below continues the curve smoothly — but with `tail` at 0.152 rather
 * than Google's 0.42 the head stays very nearly a full circle and the nub reads
 * as a spike stuck to the bottom of it, which is what Apple's is.
 */
const LIFT_PATH = [
  `M${n(PIN.cx - LIFT.r)} ${n(PIN.cy)}`,
  `C${n(PIN.cx - LIFT.r)} ${n(PIN.cy + LIFT.drop * 0.62)}`,
  `${n(PIN.cx - LIFT.r * 0.30)} ${n(PIN.cy + LIFT.drop * 0.88)}`,
  `${n(PIN.cx)} ${n(PIN.cy + LIFT.drop)}`,
  `C${n(PIN.cx + LIFT.r * 0.30)} ${n(PIN.cy + LIFT.drop * 0.88)}`,
  `${n(PIN.cx + LIFT.r)} ${n(PIN.cy + LIFT.drop * 0.62)}`,
  `${n(PIN.cx + LIFT.r)} ${n(PIN.cy)}`,
  `A${n(LIFT.r)} ${n(LIFT.r)} 0 0 0 ${n(PIN.cx - LIFT.r)} ${n(PIN.cy)}Z`,
].join(' ');

// The glyphs are authored on a 24-unit grid centred at (12, 12). This sits them
// in the disc at the largest size that still leaves the ring clear — the ring is
// a centred stroke, so half of its 3.05 eats into the fill and the usable radius
// is 9.95, not 11.475. Apple's own glyph fills a little over half the disc.
const GLYPH_SCALE = 0.66;

/**
 * The vertical gradient in a marker's fill, as multipliers on its flat colour.
 *
 * Measured down the LEFT of Apple's disc, clear of the glyph, in both states —
 * and the finding is that there is only one gradient. The lifted head runs
 * rgb(70,205,86) to rgb(28,164,60); the resting disc beside it, a third of the
 * size, runs rgb(76,203,86) to rgb(18,160,51). Those are the same two ends
 * within a couple of levels, so a marker does not gain a gradient when it is
 * picked up — it had one all along.
 *
 * Applied as a shade of whatever category colour a kind uses rather than as two
 * hard-coded greens, so the ten hues all get the same treatment.
 */
export const FILL_TOP = 1.18;
export const FILL_BOTTOM = 0.88;

/** The <defs> block both states share, keyed so two SVGs cannot collide. */
const fillGradient = (base, id) =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
  + `<stop offset="0" stop-color="${shade(base, FILL_TOP)}"/>`
  + `<stop offset="1" stop-color="${shade(base, FILL_BOTTOM)}"/>`
  + '</linearGradient></defs>';
const glyphFit = (scale) =>
  `translate(${PIN.cx} ${PIN.cy}) scale(${scale}) translate(-12 -12)`;

/** Relative luminance, and the contrast ratio between two colours. WCAG's. */
function luminance(hex) {
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * What colour the pictogram inside a disc is drawn in.
 *
 * White, unless white would fall below WCAG's 3:1 for a non-text graphic — in
 * which case the map's own ink. Of the ten hues this file uses, exactly one
 * fails: #fbbc04 gives white 1.71:1, which at 16 px is a yellow disc with
 * nothing legible in it. Every other marker keeps the white glyph it already
 * had, so adding a hue cannot quietly restyle the ones that were fine.
 *
 * A rule rather than a second lookup table, because the failure it prevents is
 * the kind nobody notices until a colour is changed months later.
 */
export const GLYPH_DARK = '#202124';
export const glyphInk = (colour) =>
  (contrast(colour, '#ffffff') >= 3 ? '#ffffff' : GLYPH_DARK);

/**
 * ...and the ink for TYPE on the same colour, which is a different question.
 *
 * glyphInk is answering WCAG's 3:1 for a non-text graphic. That is the right
 * bar for a pictogram and the wrong one for a word: normal-size text wants
 * 4.5:1, and three of the hues in this file sit between the two — white gives
 * 3.09 on the food orange, 3.08 on the sport green and 3.25 on the arts purple.
 * Legible as a bicycle, not legible as "Sport". Nothing was drawing type on
 * these until the browse-buildings grid did; see .g-kind in src/input.css.
 *
 * Whichever ink has MORE contrast rather than whichever clears a bar. On every
 * hue here that lands at 4.96 or better — the test pins it — and a hue added
 * later that leaves both short still gets the better of the two, which is an
 * honest failure rather than a silent one.
 */
export const textInk = (colour) =>
  (contrast(colour, '#ffffff') >= contrast(colour, GLYPH_DARK) ? '#ffffff' : GLYPH_DARK);

function glyphBody(kind, scale) {
  const glyph = GLYPHS[kind] ?? '<circle cx="12" cy="12" r="3.4"/>';
  const ink = glyphInk(pinColour(kind));
  return typeof glyph === 'string'
    ? `<g fill="${ink}">${glyph}</g>`
    : `<g fill="none" stroke="${ink}" stroke-width="${(1.7 / scale).toFixed(2)}" `
      + 'stroke-linecap="round" stroke-linejoin="round">' + glyph.stroke + '</g>';
}

/**
 * One pictogram as DOM markup, on the grid it was drawn on and in
 * `currentColor`.
 *
 * The same drawings the map rasterises into its discs, lent to the chrome
 * rather than redrawn for it. src/g-icons.js used to carry a single `building`
 * mark for every row of the directory, with a note saying that ten hand-drawn
 * glyphs "would say the same thing twice and let the two drift" — which was
 * true of ten NEW ones. These are not new; they are the ten this map already
 * paints beside the same names, so a row and the disc over its footprint are
 * now the same drawing as well as the same hue.
 *
 * `currentColor` rather than `glyphInk`, unlike everything else in this file:
 * a rasterised marker has to carry its own ink because it becomes a PNG, and
 * a DOM icon inherits it, which is the convention g-icons.js already set. The
 * caller picks the ink — with glyphInk, exported above, so the choice is still
 * made in one place.
 *
 * The stroke variants keep their stroke. They were drawn that way because a
 * filled bicycle is a blob at marker size, and a sheet row is smaller still.
 */
export function glyphSvg(kind) {
  const glyph = GLYPHS[kind];
  if (!glyph) return '';
  const body = typeof glyph === 'string'
    ? glyph
    : '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" '
      + `stroke-linejoin="round">${glyph.stroke}</g>`;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" '
    + `fill="currentColor" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Every kind this file has a pictogram for. Exported so a test can check the
 *  join between a classification and something that can actually be drawn. */
export const GLYPH_KINDS = Object.keys(GLYPHS);

/**
 * The resting marker: a flat disc, centred on the place.
 *
 * No tail, and that is the substantive change rather than a cosmetic one — the
 * disc sits ON the coordinate instead of pointing down at it, so every layer
 * that draws one anchors centre rather than bottom, and every label that goes
 * with one hangs beneath it rather than beside it.
 */
export function restingSvg(kind, ring = RING_LIGHT) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIN_BOX.w} ${n(PIN_BOX.h)}" `
    + `width="${PIN.w * 2}" height="${n(PIN_BOX.h * 2)}">`
    // A flattened ellipse rather than a blur filter: an SVG filter inside an
    // <img> is renderer-dependent, and this has to rasterise the same way in
    // every browser that loads the map.
    + `<ellipse cx="${PIN.cx}" cy="${n(PIN.cy + PIN.r + 0.9)}" rx="${n(PIN.r * 0.62)}" ry="1.1" `
    + 'fill="rgba(0,0,0,0.20)"/>'
    + fillGradient(pinColour(kind), `rg-${kind}`)
    + `<circle cx="${PIN.cx}" cy="${PIN.cy}" r="${n(PIN.r)}" fill="url(#rg-${kind})" `
    + `stroke="${ring}" stroke-width="${PIN.ring}"/>`
    + `<g transform="${glyphFit(GLYPH_SCALE)}">${glyphBody(kind, GLYPH_SCALE)}</g>`
    + '</svg>'
  );
}

/**
 * The lifted marker: head, nub, and the dot it leaves behind.
 *
 * The dot is not decoration. The head has floated up off the ground, so
 * without it the marker would be claiming a spot half its own height above the
 * thing it names — the dot is where the place actually is, and it is the only
 * part of the drawing that does not move during the animation.
 */
export function liftedSvg(kind, ring = RING_LIGHT) {
  return liftedShape(pinColour(kind), `lg-${kind}`,
    `<g transform="${glyphFit(GLYPH_SCALE * 1.06)}">${glyphBody(kind, GLYPH_SCALE * 1.06)}</g>`,
    { dot: false, ring });
}

/**
 * The silhouette itself, in whatever colour, with whatever is put in the head.
 *
 * Shared by the POI markers and the route's two endpoints. They are the same
 * drawing because on Apple's map they are the same drawing — a dropped pin is
 * their selected marker with nothing categorical inside it.
 */
function liftedShape(base, id, inner, { dot = true, ring = RING_LIGHT } = {}) {
  const boxH = dot ? LIFT.h : LIFT.tipY + LIFT.ring;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIN.w} ${n(boxH)}" `
    + 'width="100%" height="100%" aria-hidden="true">'
    + fillGradient(base, id)
    + `<path d="${LIFT_PATH}" fill="url(#${id})" stroke="${ring}" `
    + `stroke-width="${LIFT.ring}" stroke-linejoin="round"/>`
    + inner
    + (dot
      ? `<circle cx="${PIN.cx}" cy="${n(LIFT.dotY)}" r="${n(LIFT.dotR)}" `
        + `fill="${shade(base, 0.7)}" stroke="${ring}" stroke-width="0.8"/>`
      : '')
    + '</svg>'
  );
}

/** Multiply a hex colour toward black or white, keeping its hue. */
function shade(hex, factor) {
  const value = parseInt(hex.slice(1), 16);
  const parts = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => (
    factor >= 1
      ? Math.round(c + (255 - c) * (factor - 1))
      : Math.round(c * factor)
  ));
  return `#${parts.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The colour a resting marker's label is set in.
 *
 * Apple tints POI labels with their own category hue rather than setting them
 * all in the map's text colour: sampled off the capture, a #2fb342 park disc
 * carries a #005100 name. That is the same hue at roughly a third of the
 * lightness, and it is what makes a field of markers scannable by colour before
 * a single word has been read.
 *
 * Inverted on the dark theme, because a third-lightness green on near-black
 * ground is not a label, it is a smudge.
 */
export function pinInk(kind, theme) {
  return theme === 'dark' ? shade(pinColour(kind), 1.42) : shade(pinColour(kind), 0.42);
}

export const AMENITY_KINDS = Object.keys(COLOURS);

/** The grids both states are authored on, so a caller can size them in CSS px. */
export const PIN_ASPECT = PIN_BOX.h / PIN_BOX.w;
export const LIFT_ASPECT = LIFT.h / PIN.w;
export const PIN_BASE_W = PIN.w;
/** The two ring widths, exported so the measured ratios can be asserted. */
export const PIN_RING = PIN.ring;
export const LIFT_RING = LIFT.ring;
/** Where the dot and the head's centre sit, as fractions of the lifted height. */
export const LIFT_DOT = { y: LIFT.dotY / LIFT.h, r: LIFT.dotR / LIFT.h };
export const LIFT_HEAD = PIN.cy / LIFT.h;
/** Where the nub's tip is, so the head can be given a box of its own. */
export const LIFT_TIP = LIFT.tipY / LIFT.h;

/**
 * The anchor dot's geometry at a given marker width, in CSS pixels.
 *
 * Drawn in the DOM rather than inside the head's SVG, and that separation is
 * the whole point: the head has to travel — it starts on the place, where the
 * resting disc was, and rises off it — while the dot marks the place and must
 * not move by a pixel. Sharing one SVG dragged the dot 13 px down the screen
 * and back on every selection.
 */
export const dotGeometry = (width) => ({
  size: (LIFT.dotR * 2 * width) / PIN.w,
  ring: (0.8 * width) / PIN.w,
  top: (LIFT.dotY - LIFT.dotR) * (width / PIN.w),
});
export const dotColour = (kind) => shade(pinColour(kind), 0.7);

/** The colour a kind is drawn in, for anything that has to match it. */
export const pinColour = (kind) => COLOURS[kind] ?? FALLBACK;

/**
 * The lifted marker as a DOM element rather than a map image.
 *
 * A selected pin is an HTML marker, not a symbol: it has to animate, and a
 * symbol layer can only be re-sized by pushing a new `icon-size` on every frame
 * — which restyles the whole layer to move one icon, and rasterises a 2x image
 * up past its own resolution while it does it. As an element it is an SVG the
 * browser re-renders crisply at any scale, and the easing is one CSS property.
 */
export function pinElement(kind, width, ring = RING_LIGHT) {
  const el = document.createElement('div');
  el.style.width = `${width}px`;
  // The head's own box, which stops at the nub's tip. The dot below it is a
  // separate element because it must not move while this one does.
  el.style.height = `${(width * (LIFT.tipY + LIFT.ring)) / PIN.w}px`;
  el.innerHTML = liftedSvg(kind, ring);
  return el;
}

// --- the route's two ends -----------------------------------------------------
//
// The same silhouette as a selected POI, in green and red. On Apple's map a
// dropped pin IS their selected marker with nothing categorical in the head, so
// this is not a second marker language invented for the route — it is the one
// measured off the capture, with a plain white hole where a glyph would go.
//
// The hole is white rather than a lighter tint of the pin so it stays a hole
// over imagery, where the surrounding photograph supplies no fixed value.
//
// Drawn as a DOM element rather than registered as a map image because these
// are `mapboxgl.Marker`s, not symbol layers — markers are HTML, positioned by
// the map rather than rendered into the canvas.

/** Width in CSS pixels. Squatter than the old teardrop, so a touch wider. */
export const ROUTE_PIN_W = 30;

/**
 * How far to push a marker of this width DOWN from a `bottom` anchor.
 *
 * The silhouette ends in an anchor dot rather than a point, and it is the dot's
 * CENTRE that marks the place — half of it hangs below the box, so a bottom
 * anchor alone would sit the whole pin that half-dot high.
 */
export const liftedOffset = (width) => [0, (1 - LIFT_DOT.y) * width * LIFT_ASPECT];

export function routePin(colour, { title = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'map-pin';
  el.style.width = `${ROUTE_PIN_W}px`;
  el.style.height = `${ROUTE_PIN_W * LIFT_ASPECT}px`;
  if (title) el.title = title;

  // The drop goes on an inner element for the same reason the selection's
  // spring does: Mapbox owns the marker's own `transform` and rewrites it on
  // every frame of every pan. The origin is the anchor dot, so the pin scales
  // down onto the place it marks rather than away from it.
  const drop = document.createElement('div');
  drop.className = 'map-pin-drop';
  drop.style.transformOrigin = `50% ${(LIFT_DOT.y * 100).toFixed(2)}%`;
  drop.innerHTML = liftedShape(
    colour,
    `rp-${colour.slice(1)}`,
    `<circle cx="${PIN.cx}" cy="${PIN.cy}" r="4" fill="#ffffff"/>`,
  );
  el.append(drop);
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
/**
 * The ring the current rasters were drawn with.
 *
 * Needed because the images are cached on the map by name and a theme change is
 * a CONFIG change under Standard, not a setStyle — so nothing clears them. The
 * ring is the one part of a marker that follows the theme, so without this a
 * switch to dark kept twelve white-ringed discs until something else happened
 * to rebuild the style.
 */
let rasterisedWith = null;

export function loadAmenityIcons(map, ring = RING_LIGHT) {
  if (rasterisedWith !== null && rasterisedWith !== ring) {
    for (const kind of AMENITY_KINDS) if (map.hasImage(kind)) map.removeImage(kind);
  }
  rasterisedWith = ring;
  return Promise.all(AMENITY_KINDS.map((kind) => new Promise((resolve) => {
    if (map.hasImage(kind)) {
      resolve();
      return;
    }
    const image = new Image(PIN.w * 2, PIN_BOX.h * 2);
    image.onload = () => {
      if (!map.hasImage(kind)) map.addImage(kind, image, { pixelRatio: 2 });
      resolve();
    };
    image.onerror = () => resolve();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(restingSvg(kind, ring))}`;
  })));
}
