// A dropped pin, drawn as vector from a screenshot of one.
//
// The map's own markers live in `map-images.js` — a flat disc at rest, a
// teardrop when selected — and this is the third member of that family rather
// than a stranger to it: the pin that STANDS on a surface, a ball on a needle,
// for the aerial view where a flat sticker lying on a roof would read as part of
// the photograph instead of as something placed on top of it.
//
// EVERY NUMBER BELOW IS MEASURED, off Apple's own location_and_maps_intro_2x at
// 640x1136. The pin there is a ball of radius 13.0 px centred at (319.0, 532.2)
// standing on a foot whose last row is y=591, so the source's scale is a ball
// radius of 13 px and every ratio here is expressed in those radii.
//
// WHAT THE MEASUREMENT ACTUALLY SAID, and it is not what a from-memory drawing
// would have produced:
//
//   the ball is FLAT   Not shaded, not a sphere. The horizontal profile across
//                      the widest row reads 250,57,47 at every one of the 25
//                      pixels between its antialiased edges, and the vertical
//                      profile moves from 249 to 251 over the whole ball. There
//                      is no rim, no terminator and no falloff — it is one
//                      colour, #fa392f, with a hard white dot on it.
//   the dot is HARD    #fafafa, six pixels across, centred (-4.5, -4.7) from the
//                      ball's centre. Its pixels are 250,250,250 right up to the
//                      red. Blurring it is the usual mistake; it is a sticker,
//                      not a specular highlight.
//   the needle is LIT  Three pixels wide. The two edges are #a5a7a9 for the
//                      whole length, and the middle column runs #bebfc1 at the
//                      top to #a6a8ab at the bottom — a highlight down the front
//                      of a cylinder that fades as it goes into shadow.
//
// The foot is the one simplification: at source scale it is a 5x3 blob that is
// darkest at its shoulders (#484745) with the needle's lit core still showing
// between them, which is a cone tip seen side on. It is drawn as a plain dark
// ellipse, because that detail is a third of a pixel at every size this is used
// at and a rounded foot is what it reads as anyway.
//
// The drop shadow is NOT copied, and it is the only part of this that is not a
// measurement. Apple's sits down and to the RIGHT of the ball — a fixed light,
// which is what a UI on a screen has. This pin is drawn as a BILLBOARD in an
// orbiting aerial view, so any offset baked into it points a different compass
// direction every second of the orbit, and the cast shadow it would be
// disagreeing with — `pinShadowSvg`, laid flat on the roof by
// src/flyover-pin.js — has a real sun behind it and does not.
//
// So this one is kept concentric and faint: it is contact and separation, the
// darkening that stops a bright ball dissolving into bright imagery, and it
// deliberately states no light direction at all. The cast shadow states it.

/** Hue of the screenshot's pin, so a recolour knows what it is rotating from. */
const SOURCE_HUE = 3;

/**
 * The ball's radius, and the only number the drawing scales from.
 *
 * 12 puts the ball on the same 24-unit grid the amenity pictograms are authored
 * on. That is not needed for anything — nothing shares a layer with these — but
 * a second grid in the same app is a second set of ratios to hold in your head.
 */
const R = 12;

/** Where the pin stands, in ball radii below the ball's centre. */
const TIP_DROP = 4.523;
/** Half the needle's width, in ball radii: 1.5 px of the source's 13. */
const NEEDLE_HALF = 0.115;
/** The foot, in ball radii: centre below the ball, then its two half-axes. */
const FOOT = { y: 4.400, rx: 0.200, ry: 0.123 };

/**
 * The white dot, in ball radii. Centre offset, then radius.
 *
 * Measured as a bounding box rather than a centroid, because it has no falloff
 * to take a centroid of: x 312..317, y 525..530 against a ball centred at
 * (319.0, 532.2), which is (-0.346, -0.362) at a radius of 0.223.
 */
const DOT = { x: -0.346, y: -0.362, r: 0.223 };

/**
 * The ball's own shadow: centre below the ball, radius, and peak opacity — all
 * in ball radii except the last.
 *
 * Invented rather than measured, and the only part of this drawing that is. See
 * the header: Apple's is offset to the right and this one cannot be, because the
 * cast shadow on the roof is directly underneath and the two have to agree about
 * the light. What survives from the source is the softness and the strength.
 */
const BALL_SHADE = { y: 0.34, r: 1.18, alpha: 0.20 };

/** Room around the drawing, in ball radii, so antialiasing is not clipped. */
const PAD = 0.06;
/** Half the box, in ball radii. The ball's shadow is the widest thing in it. */
const HALF_W = BALL_SHADE.r + PAD;

/**
 * The needle in cross section, left edge to core to right edge.
 *
 * Three pixels at source scale, so this is less a fitted profile than the three
 * numbers themselves. It is drawn as a gradient anyway because this pin is also
 * used at illustration sizes, where three flat bands would band.
 */
const NEEDLE_STOPS = [
  [0.00, '#a5a7a9'],
  [0.50, '#bebfc1'],
  [1.00, '#a5a7a9'],
];

/**
 * What happens to that cross section down the needle's length.
 *
 * The core fades to the edge colour and the edges do not move, so one gradient
 * in the edge's own colour — transparent at the collar, opaque at the foot —
 * carries the whole effect. Linear, because the measured core is: 190 at the
 * ball and 166 at the foot, with every row in between on the line.
 */
const NEEDLE_FADE = [
  [0.00, '#a5a7a9', 0],
  [1.00, '#a5a7a9', 1],
];

/** The foot, at its darkest measured pixel. */
const FOOT_COLOUR = '#484745';

/**
 * The cast shadow's falloff: a penumbra, not a disc with a blur on it.
 *
 * Held at nearly full strength across the middle and dropped steeply near the
 * edge, which is what a small light source a long way off actually casts. A
 * linear ramp from the centre reads as a smudge; the shape has to have a middle.
 */
const CAST_STOPS = [
  [0.00, '#000000', 1],
  [0.38, '#000000', 0.92],
  [0.64, '#000000', 0.60],
  [0.84, '#000000', 0.22],
  [1.00, '#000000', 0],
];

/**
 * The cast shadow's SHAPE, in a 100-wide box: how long it is, where along it the
 * ball's own shadow sits, and the two blobs it is made of.
 *
 * It is the pin's silhouette lying down, which is what a shadow is, and it is
 * therefore slender — a stalk with a blot at the end of it, not a puddle. The
 * proportions are the pin's own seen from a low angle: the ball's shadow is a
 * little longer than it is wide because a sphere lit from off to one side throws
 * an ellipse, and the needle's is barely there because the needle is barely
 * there.
 *
 * `at` is the number the layer needs. The shadow is anchored at the pin's FOOT
 * and sized by its whole LENGTH, so the caller works out where the ball's shadow
 * belongs and divides by this to get the length that puts it there.
 */
const CAST = {
  w: 100,
  h: 240,
  at: 0.771,
  ball: { cy: 55, rx: 46, ry: 52 },
  stalk: { cy: 122, rx: 14, ry: 118, alpha: 0.55 },
};

const n = (v) => Number(v.toFixed(3));

/**
 * The drawing's box and the landmarks in it, for anything that has to place it.
 *
 * `tipY` is the one that matters: the pin marks a place with its FOOT, so a
 * caller anchoring it to a coordinate wants that there. It is NOT the bottom of
 * the box — there is a sliver of padding under it for the foot's antialiasing —
 * so anchoring to the box bottom stands every pin off its roof by that much.
 */
export const PUSH_PIN = {
  w: n(HALF_W * 2 * R),
  h: n((1 + PAD + TIP_DROP + PAD) * R),
  cx: n(HALF_W * R),
  cy: n((1 + PAD) * R),
  r: R,
  tipY: n((1 + PAD + TIP_DROP) * R),
};
PUSH_PIN.aspect = n(PUSH_PIN.h / PUSH_PIN.w);
/** Where the foot sits in the box, as a fraction of its height. */
PUSH_PIN.anchor = n(PUSH_PIN.tipY / PUSH_PIN.h);
/**
 * How high the BALL rides above the foot, as a fraction of the pin's height.
 *
 * For anything working out where the pin's shadow falls: the ball is the only
 * part of this with enough mass to cast one, and under a light that is not
 * directly overhead a shadow's distance from the foot is its caster's height
 * times the light's own slope.
 */
PUSH_PIN.ride = n((PUSH_PIN.tipY - PUSH_PIN.cy) / PUSH_PIN.h);

/** The colour the screenshot's own pin is, for callers that want it named. */
export const PUSH_PIN_RED = '#fa392f';

// --- colour ------------------------------------------------------------------
//
// The pin recolours by rotating hue and leaving lightness and saturation exactly
// as measured, so a green one is the same object under the same light rather
// than a second drawing. Neutrals rotate to themselves, so the white dot and the
// grey needle need no special case.

function toHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r
    ? ((g - b) / d + (g < b ? 6 : 0))
    : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function toHex([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][Math.floor(hp) % 6];
  const m = l - c / 2;
  return `#${[r, g, b]
    .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Spin a measured colour from the screenshot's hue onto another one.
 *
 * No hue at all means "leave this alone", which is what the needle asks for: a
 * green pin still has a grey needle, and rotating a near-neutral is a rounding
 * error rather than a no-op.
 */
function spin(hex, hue) {
  if (hue === undefined || hue === SOURCE_HUE) return hex;
  const [h, s, l] = toHsl(hex);
  return toHex([h - SOURCE_HUE + hue, s, l]);
}

// --- the drawing --------------------------------------------------------------

const stops = (list, hue) => list
  .map(([offset, colour, opacity]) => `<stop offset="${offset}" stop-color="${spin(colour, hue)}"`
    + `${opacity === undefined ? '' : ` stop-opacity="${opacity}"`}/>`)
  .join('');

/**
 * The pin, as an SVG string.
 *
 * `id` keys every gradient in it, because two of these in one document with the
 * same ids is one pin wearing the other's light.
 */
export function pushPinSvg({ colour = PUSH_PIN_RED, id = 'pp', title = '', height = 0 } = {}) {
  const [hue] = toHsl(colour);
  const { w, h, cx, cy, r } = PUSH_PIN;
  // An INTRINSIC size, when asked for, and it is not cosmetic. A percentage-sized
  // SVG has no natural dimensions, so anything that rasterises it outside a
  // layout box — a data: URI handed to an <img>, which is how deck.gl loads an
  // icon — falls back to the 300x150 default and hands back a blurred, squashed
  // pin. Callers that place this in the DOM want the percentages; callers that
  // rasterise it want pixels, at whatever multiple of the display size their
  // device pixel ratio asks for.
  const box = height
    ? ` width="${n(height / PUSH_PIN.aspect)}" height="${n(height)}"`
    : ' width="100%" height="100%"';
  const half = n(NEEDLE_HALF * r);
  const foot = { y: n(cy + FOOT.y * r), rx: n(FOOT.rx * r), ry: n(FOOT.ry * r) };
  // The needle runs from the ball's CENTRE, not from its underside, so the join
  // has no seam to hide: the shaft simply goes up behind the ball and stops.
  const collar = n(cy + r);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"`,
    `${box}${title ? ' role="img"' : ' aria-hidden="true"'}>`,
    title ? `<title>${title}</title>` : '',

    '<defs>',
    `<radialGradient id="${id}-shade" gradientUnits="userSpaceOnUse"`,
    ` cx="${cx}" cy="${n(cy + BALL_SHADE.y * r)}" r="${n(BALL_SHADE.r * r)}">`,
    `<stop offset="0" stop-color="#000000" stop-opacity="${BALL_SHADE.alpha}"/>`,
    `<stop offset="0.50" stop-color="#000000" stop-opacity="${n(BALL_SHADE.alpha * 0.62)}"/>`,
    '<stop offset="1" stop-color="#000000" stop-opacity="0"/>',
    '</radialGradient>',

    `<linearGradient id="${id}-steel" gradientUnits="userSpaceOnUse"`,
    ` x1="${n(cx - half)}" y1="0" x2="${n(cx + half)}" y2="0">`,
    stops(NEEDLE_STOPS),
    '</linearGradient>',

    `<linearGradient id="${id}-fade" gradientUnits="userSpaceOnUse"`,
    ` x1="0" y1="${collar}" x2="0" y2="${foot.y}">`,
    stops(NEEDLE_FADE),
    '</linearGradient>',
    '</defs>',

    // Behind everything, including the needle: it is the ball's shadow on
    // whatever is under the pin, not a darkening of the pin's own parts.
    `<circle cx="${cx}" cy="${n(cy + BALL_SHADE.y * r)}" r="${n(BALL_SHADE.r * r)}"`,
    ` fill="url(#${id}-shade)"/>`,

    `<g><rect x="${n(cx - half)}" y="${cy}" width="${n(half * 2)}"`,
    ` height="${n(foot.y - cy)}" fill="url(#${id}-steel)"/>`,
    `<rect x="${n(cx - half)}" y="${cy}" width="${n(half * 2)}"`,
    ` height="${n(foot.y - cy)}" fill="url(#${id}-fade)"/></g>`,

    `<ellipse cx="${cx}" cy="${foot.y}" rx="${foot.rx}" ry="${foot.ry}"`,
    ` fill="${FOOT_COLOUR}"/>`,

    // Flat, and that is the measurement rather than a shortcut. See the header.
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${spin(PUSH_PIN_RED, hue)}"/>`,
    `<circle cx="${n(cx + DOT.x * r)}" cy="${n(cy + DOT.y * r)}" r="${n(DOT.r * r)}"`,
    ' fill="#fafafa"/>',
    '</svg>',
  ].join('');
}

/**
 * The pin's cast shadow, as an SVG string: a soft round penumbra, black.
 *
 * Black rather than the pin's colour, and no hue to rotate — a shadow is an
 * absence of light and takes the colour of what it falls on, which is the roof.
 * Callers scale and fade it; this is only the shape.
 */
export function pinShadowSvg({ id = 'ps' } = {}) {
  const { w, h, ball, stalk } = CAST;
  // The gradient is in OBJECT BOUNDING BOX units, which is the default and is
  // doing real work here: it maps the gradient's own circle onto each ellipse's
  // box, so one definition softens a stalk 12 wide and a ball 42 wide by the
  // same proportion of each. In user space it would have been one circular
  // falloff clipped by two different shapes, and the stalk would have had a hard
  // edge down both of its long sides.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"`,
    ` width="${w}" height="${h}" aria-hidden="true">`,
    `<defs><radialGradient id="${id}-cast">`,
    stops(CAST_STOPS),
    '</radialGradient></defs>',
    `<ellipse cx="${w / 2}" cy="${stalk.cy}" rx="${stalk.rx}" ry="${stalk.ry}"`,
    ` fill="url(#${id}-cast)" opacity="${stalk.alpha}"/>`,
    `<ellipse cx="${w / 2}" cy="${ball.cy}" rx="${ball.rx}" ry="${ball.ry}"`,
    ` fill="url(#${id}-cast)"/>`,
    '</svg>',
  ].join('');
}

/**
 * The cast shadow's box and the one landmark in it, for whatever places one.
 *
 * Exported rather than restated at the call site, which is not a style point: an
 * icon declared 300 tall against a drawing 240 tall is silently stretched by
 * deck.gl into the box it was promised, and the shadow lands two thirds of a pin
 * further out than it should with nothing to say so.
 *
 * `at` is where the ball's own shadow sits along the length, measured from the
 * FOOT, which is the end the whole thing is anchored by.
 */
export const SHADOW_BOX = { w: CAST.w, h: CAST.h, at: CAST.at };

/** The pin as an element, sized by width; the height follows from the box. */
export function pushPinElement(width, { colour = PUSH_PIN_RED, title = '' } = {}) {
  const el = document.createElement('div');
  el.style.width = `${width}px`;
  el.style.height = `${n(width * PUSH_PIN.aspect)}px`;
  el.innerHTML = pushPinSvg({ colour, id: `pp-${colour.slice(1)}`, title });
  return el;
}

/** The pin as a data URI, for a CSS background or an <img>. */
export const pushPinUri = (options) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pushPinSvg(options))}`;
