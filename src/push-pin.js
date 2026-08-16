// A push pin, drawn as vector from a photograph of one.
//
// THIS IS THE DRAWING THE FLYOVER USES, and it has been swapped once. It was
// briefly a recreation of the dropped pin in Apple's LocationAwareness
// screenshot — a flat #fa392f disc with a hard white sticker on it and a three
// pixel grey needle, which is a UI marker and reads as one. This is the other
// answer: a lit, glossy, physical object photographed under a real light. Both
// were measured the same way; they are drawings of different things, and which
// one belongs on a photorealistic roof is a taste rather than a fact. The Apple
// one is recoverable from git if the taste changes back.
//
// Not the map's marker. `map-images.js` owns that — a flat disc at rest and a
// teardrop when selected, both measured off Apple Maps — and this is a
// different object in a different language: a lit, glossy, physical thing with a
// steel needle. It is here for the places a PICTURE of a pin is wanted rather
// than a map marker: an empty state, a header, the illustration beside "press
// and hold to drop a pin". Putting it on the map beside the discs would be two
// marker vocabularies on one canvas.
//
// EVERY NUMBER BELOW IS MEASURED, off closeup-shot-single-red-push-pin at
// 740x740. The photo is a 175 px ball centred at (387.5, 278) with a needle to a
// point at (381.5, 570), so the source's own scale is a ball radius of 87.5 px
// and every ratio here is expressed in those radii. Sampling was done on a
// background test of "nearly white and nearly neutral", which drops the white
// and the light grey of the file's transparency checkerboard together — the
// checkerboard is a viewer artifact, not part of the subject, and nothing of it
// reaches this drawing. The alpha here is real alpha.
//
// THE SHADING IS A FITTED PROFILE, not an impression of one. Median colour was
// taken in rings of constant distance from the specular highlight, over every
// pixel inside 0.985r, and it falls off cleanly and monotonically from white at
// the highlight to #ba2330 at the far rim. That profile is what BODY_STOPS is:
// a radial gradient centred on the highlight reproduces it by construction,
// which is why the body needs no hand-tuning and no second guess.
//
// Two things that profile cannot carry, both real and both measured separately:
//
//   the Fresnel rim   Median by radius from the BALL's centre is flat at
//                     #d2030f out to 0.56r and then climbs — #d91427 at 0.84,
//                     #db3840 at 0.92, #de5357 at 0.96. That is an edge lift at
//                     every angle, and a gradient centred on the highlight
//                     cannot produce one because the near rim and the far rim
//                     are at completely different distances from it.
//   the terminator    The lift is not equal at every angle. On the ring at
//                     0.94r it runs #f75b60 at the lit right and #b1383b at the
//                     shaded lower left. A concentric rim alone lifts the shaded
//                     side by about 28 levels too much, so a soft dark crescent
//                     sits over the anti-light quarter and pulls it back.
//
// The needle is chrome, which means it is DARK IN THE MIDDLE and bright at the
// lit edge — it reflects the camera and the ground, not a diffuse surface. The
// cross section at mid length reads #65615a #8e877d #524c42 #aba39b #c8c4bd
// left to right, and drawing it as a plain grey rod is the single thing that
// makes a vector pin look like a drawing of one.

/** Hue of the photographed pin, so a recolour knows what it is rotating from. */
const SOURCE_HUE = 356;

/**
 * The ball's radius, and the only number the drawing scales from.
 *
 * 12 puts the ball on the same 24-unit grid the amenity pictograms are authored
 * on and the whole pin in a 26-wide box, which is `PIN.w` in map-images.js. That
 * is not needed for anything — nothing shares a layer with these — but a second
 * grid in the same app is a second set of ratios to hold in your head.
 */
const R = 12;
/** Room around the ball, so the rim's antialiasing is not clipped by the box. */
const PAD = 1;

/** Where the needle comes to a point, in ball radii below the ball's centre. */
const TIP_DROP = 3.337;
/** Half the needle's width, and the length of its point, in ball radii. */
const NEEDLE_HALF = 0.0686;
const NEEDLE_TAPER = 0.251;

/**
 * The specular highlight: centre in ball radii, then its own radius.
 *
 * Found by centroid of the pixels inside 0.93r above a brightness floor, which
 * is stable across every floor from 120 to 245 — (+0.44, -0.29) either way. The
 * hard white core is 0.115r; it carries a rose halo out to about 0.20r, and that
 * halo is in BODY_STOPS rather than here.
 */
const SPEC = { x: 0.440, y: -0.286, r: 0.115 };

/**
 * How far the body gradient reaches, in ball radii.
 *
 * The specular sits 0.525r off centre, so the far rim is 1.525r from it. This is
 * the denominator every offset in BODY_STOPS was divided by, and changing it
 * without re-deriving them slides the whole profile.
 */
const BODY_REACH = 1.525;

/**
 * The measured falloff, offset -> colour.
 *
 * Median of every pixel at that distance from the highlight. The first three
 * stops are the highlight's own halo, which is why the body already looks lit
 * before the specular is drawn on top of it.
 *
 * It stops at #ba2330 rather than at the #bb585c the rings actually reach,
 * because those last two rings ARE the far rim and the rim is a layer of its
 * own. Leaving them in would light the shaded edge twice.
 */
const BODY_STOPS = [
  [0.000, '#fbfdfe'],
  [0.066, '#fbfaf7'],
  [0.098, '#f54859'],
  [0.131, '#f0041c'],
  [0.197, '#ea0214'],
  [0.295, '#e60313'],
  [0.393, '#e10415'],
  [0.492, '#d8051f'],
  [0.590, '#cd041f'],
  [0.689, '#c20520'],
  [0.787, '#bd0f25'],
  [0.885, '#ba2330'],
  [1.000, '#ba2330'],
];

/**
 * The Fresnel rim: offset from the BALL's centre -> colour and opacity.
 *
 * Fitted against the by-radius medians rather than picked. At 0.96r the median
 * is #de5357 over a body of about #cf0620, and #ee868c at 0.55 lands on #e04d5b
 * — within a couple of levels on every channel. Transparent until 0.80 so the
 * fitted body owns everything inside it.
 */
const RIM_STOPS = [
  [0.80, '#e0454e', 0],
  [0.90, '#e5686e', 0.32],
  [0.96, '#ee868c', 0.55],
  [1.00, '#f5a8ac', 0.72],
];

/**
 * The terminator crescent, which is the rim's correction and nothing else.
 *
 * Centred a ball radius beyond the shaded rim along the anti-light direction, so
 * it is strongest where the rim over-lifts and has fallen to nothing by the time
 * it reaches the middle. Without it the pin reads as lit from everywhere at
 * once, which is the look of a vector sphere rather than a photographed one.
 */
const SHADE = { at: 1.30, r: 1.05, colour: '#7d1520', alpha: 0.42 };

/**
 * The needle in cross section, left edge to right edge, at mid length.
 *
 * Chrome, so the order is the point: a middling left edge, a bright band at a
 * quarter, the DARK reflection just left of centre, and the lit right side. Read
 * off the row at source y=450, which is clear of both the ball's shadow and the
 * point.
 */
const NEEDLE_STOPS = [
  [0.00, '#65615a'],
  [0.09, '#747069'],
  [0.18, '#8b847a'],
  [0.27, '#8e877d'],
  [0.36, '#7b7569'],
  [0.45, '#5b5549'],
  [0.55, '#524c42'],
  [0.64, '#7e786e'],
  [0.73, '#aba39b'],
  [0.82, '#b7afa7'],
  [0.91, '#c0b8b2'],
  [1.00, '#bdb5af'],
];

/**
 * What happens to that cross section down the needle's length.
 *
 * Almost nothing, which took a second pass to find out. Row medians run #81,
 * #90, #8b, #85, #89, #88, #93 from source y=400 to 545 — a shaft that is
 * essentially uniform over its whole visible length. The first version of this
 * table ramped it dark-to-light end to end and was wrong for most of the needle.
 *
 * What is real is at the two ends. Under the ball the shaft is in its contact
 * shadow and carries the ball's own colour bounced into it, #5f1e26 at the
 * collar and a near-black #5a3e3a a couple of millimetres down; at the point it
 * lifts to about #a89f95. Two effects in one gradient, which works because the
 * stops between them are fully transparent and so contribute no colour of their
 * own. Alphas solved against the #8b847a the cross section already supplies.
 */
const NEEDLE_LENGTH_STOPS = [
  [0.000, '#4a0d14', 0.80],
  [0.071, '#3a1a18', 0.60],
  [0.167, '#3a1a18', 0.08],
  [0.400, '#8b847a', 0],
  [0.860, '#e8e2d8', 0],
  [0.952, '#e8e2d8', 0.31],
  [1.000, '#e8e2d8', 0.40],
];

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
 * `tipY` is the one that matters: the pin marks a place with its POINT, so a
 * caller anchoring it to a coordinate wants the tip there, and the tip is at the
 * very bottom of the box rather than at the middle of a dot the way the map's
 * lifted marker is.
 */
export const PUSH_PIN = {
  w: R * 2 + PAD * 2,
  h: n(R + PAD + TIP_DROP * R),
  cx: R + PAD,
  cy: R + PAD,
  r: R,
  tipY: n(R + PAD + TIP_DROP * R),
};
PUSH_PIN.aspect = n(PUSH_PIN.h / PUSH_PIN.w);
/**
 * Where the point sits in the box, as a fraction of its height.
 *
 * One, here, because this drawing's tip IS the bottom of its box — but it is
 * exported rather than assumed, because the caller that anchors an icon to it
 * (src/flyover-pin.js) must not care which drawing it was handed. A pin with a
 * sliver of padding under its point would otherwise stand off its roof by that
 * much, silently.
 */
PUSH_PIN.anchor = n(PUSH_PIN.tipY / PUSH_PIN.h);
/**
 * How high the BALL rides above the point, as a fraction of the pin's height.
 *
 * For anything working out where the pin's shadow falls: the ball is the only
 * part of this with enough mass to cast one, and under a light that is not
 * directly overhead a shadow's distance from the point is its caster's height
 * times the light's own slope.
 */
PUSH_PIN.ride = n((PUSH_PIN.tipY - PUSH_PIN.cy) / PUSH_PIN.h);

/** The colour the photograph's own pin is, for callers that want it named. */
export const PUSH_PIN_RED = '#e60313';

/**
 * The source leans 1.18 degrees: its tip sits 6 px left of the ball's centre
 * over a 292 px needle, consistently, on every row sampled. It is drawn upright
 * anyway, because a pin whose tip is not under its own centre makes every caller
 * do arithmetic to put the point on a coordinate. Anyone who wants the
 * photograph's exact attitude can rotate the whole thing about the tip:
 * `transform="rotate(-1.18 13 53.044)"`.
 */
export const SOURCE_LEAN_DEG = 1.18;

// --- colour ------------------------------------------------------------------
//
// The pin recolours by rotating hue and leaving lightness and saturation exactly
// as measured, so a green one is the same photograph of the same object under
// the same light rather than a second drawing. Neutrals rotate to themselves, so
// the white highlight and the steel needle need no special case.

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
 * Spin a measured colour from the photograph's hue onto another one.
 *
 * No hue at all means "leave this alone", which is what the steel asks for: a
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

/** The silhouette of the needle: a parallel shaft that comes to a point. */
function needlePath() {
  const { cx, cy, h } = PUSH_PIN;
  const half = NEEDLE_HALF * R;
  const taper = NEEDLE_TAPER * R;
  const shoulder = n(h - taper);
  // A quadratic rather than a straight bevel. The photograph's point is convex —
  // 7 px wide where a straight taper would be 5.5 — because it is a cone seen
  // side on, and a straight one reads as a wedge at any size worth drawing.
  const belly = n(h - taper * 0.35);
  return [
    `M${n(cx - half)} ${cy}`,
    `L${n(cx - half)} ${shoulder}`,
    `Q${n(cx - half * 0.62)} ${belly} ${cx} ${n(h)}`,
    `Q${n(cx + half * 0.62)} ${belly} ${n(cx + half)} ${shoulder}`,
    `L${n(cx + half)} ${cy}`,
    'Z',
  ].join(' ');
}

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
  // Where the needle leaves the ball, which is where its own shading starts.
  const collar = cy + r;
  const spec = { x: n(cx + SPEC.x * r), y: n(cy + SPEC.y * r) };
  // The shaded quarter sits opposite the highlight, at the same angle.
  const away = Math.hypot(SPEC.x, SPEC.y);
  const shade = {
    x: n(cx - (SPEC.x / away) * SHADE.at * r),
    y: n(cy - (SPEC.y / away) * SHADE.at * r),
  };

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"`,
    `${box}${title ? ' role="img"' : ' aria-hidden="true"'}>`,
    title ? `<title>${title}</title>` : '',

    '<defs>',
    `<radialGradient id="${id}-body" gradientUnits="userSpaceOnUse"`,
    ` cx="${spec.x}" cy="${spec.y}" r="${n(BODY_REACH * r)}">`,
    stops(BODY_STOPS, hue),
    '</radialGradient>',

    `<radialGradient id="${id}-rim" gradientUnits="userSpaceOnUse"`,
    ` cx="${cx}" cy="${cy}" r="${r}">`,
    stops(RIM_STOPS, hue),
    '</radialGradient>',

    `<radialGradient id="${id}-shade" gradientUnits="userSpaceOnUse"`,
    ` cx="${shade.x}" cy="${shade.y}" r="${n(SHADE.r * r)}">`,
    `<stop offset="0" stop-color="${spin(SHADE.colour, hue)}" stop-opacity="${SHADE.alpha}"/>`,
    `<stop offset="1" stop-color="${spin(SHADE.colour, hue)}" stop-opacity="0"/>`,
    '</radialGradient>',

    `<linearGradient id="${id}-steel" gradientUnits="userSpaceOnUse"`,
    ` x1="${n(cx - NEEDLE_HALF * r)}" y1="0" x2="${n(cx + NEEDLE_HALF * r)}" y2="0">`,
    stops(NEEDLE_STOPS),
    '</linearGradient>',

    `<linearGradient id="${id}-shaft" gradientUnits="userSpaceOnUse"`,
    ` x1="0" y1="${collar}" x2="0" y2="${n(h)}">`,
    stops(NEEDLE_LENGTH_STOPS),
    '</linearGradient>',
    '</defs>',

    // The needle first and the ball over it, so the join needs no seam: the
    // shaft simply runs up behind the ball to its centre and is covered.
    `<g><path d="${needlePath()}" fill="url(#${id}-steel)"/>`,
    `<path d="${needlePath()}" fill="url(#${id}-shaft)"/></g>`,

    // Rim before crescent, not after. The crescent exists to say the rim does
    // not happen on the shaded side, and a rim painted over it says it does —
    // that order left the far edge 24 levels light against the photograph.
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}-body)"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}-rim)"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}-shade)"/>`,
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
