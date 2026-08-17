// The pin the flyover drops on the building you tapped, and its shadow.
//
// The problem it solves is that the aerial view arrives with no subject. A
// helicopter shot of a campus is a roof among roofs, and at the framing this app
// uses the building fills a quarter of the picture with three of its neighbours
// in shot — so the honest question a first-time viewer asks is "which one".
// Dropping a marker onto its roof answers that in the first second, before the
// orbit has turned far enough to be disorienting.
//
// WHERE IT LANDS is measured, not derived. src/roofs.json holds a roof centre
// per building read off Google's own leaf tiles at 2.01 m geometric error, as
// [lon, lat, z] with z in metres above the WGS84 ellipsoid — which is the datum
// deck.gl positions in here, and the reason that is checkable rather than
// assumed is GRID_DEPTH_M in src/flyover-view.js: the ground grid sits at -8 m
// and draws UNDER the terrain, and my campus's ground measures -5 to -1 m in the same
// file. Two independent numbers agreeing about where zero is.
//
// The alternative was the footprint's centre, which is what the camera already
// aims at, and it is wrong for this: a footprint centre is a point on the GROUND
// and the pin would sink through the roof of every building it marked.
//
// THE FALL IS IN SCREEN PIXELS, and that is the whole lesson of this file. It
// was first written in metres of altitude, which needed a measured constant —
// how many pixels deck.gl draws a metre of height as, against a metre of ground
// — and gave a drop that was invisible for its whole length because there is
// almost no sky in this shot. Fixing that with a smaller number in the same
// units only moved the problem: the requirement is "start above the top edge of
// the window", the top edge is a fact about pixels, and every conversion between
// the two was a place to be wrong. IconLayer takes a `getPixelOffset` that is
// applied after projection, in exactly the units the icon's own size is in, so
// the pin is positioned ON the roof and lifted off it in pixels. The perspective
// no longer has an opinion about how far it falls.

import {
  pushPinSvg, pinShadowSvg, SHADOW_BOX, PUSH_PIN, PUSH_PIN_RED,
} from './push-pin.js';
// The same scale the flyover's own box is built with. Imported rather than
// restated, because a shadow slid on one scale across a building framed on
// another is a picture of two different campuses.
import { M_PER_DEG_LAT, M_PER_DEG_LON } from './flyover.js';

/**
 * How long the fall takes, in ms, and very nearly how long it is WATCHED for.
 *
 * Those used to be different numbers. The pin waits above the top of the window
 * — see CLEAR_PINS, which once parked it a whole pin height higher than it had
 * to — and at 300 ms only 158 of them happened on camera; the rest was a wait
 * with nothing in the frame. 94% of the fall is on screen now, so this whole
 * number is nearly all of it: 150 ms of visible drop against the 158 that 300 ms
 * used to buy, in barely half the time.
 *
 * THE TRAIL IS WHAT MAKES THIS AFFORDABLE, and it is why the number can keep
 * coming down. 150 ms is nine frames at 60fps and about three on the software
 * renderer this was photographed on, which is not enough frames to draw a fall
 * with — but each of them carries six time-samples of the pin behind it, and the
 * trail's LENGTH is solved from the landing speed rather than fixed in
 * milliseconds, so it lengthens by itself every time this shortens.
 *
 * The floor is somewhere below here and it is the pin's own height: once the
 * ball moves further than its own diameter between two frames, the trail is no
 * longer a blur of one object but a row of separate ones.
 */
export const DROP_MS = 160;

/**
 * How long the finished picture is held before the pin falls into it, in ms.
 *
 * A BEAT, not a wait, and the difference is what it is measured against. The
 * gate this replaced timed itself from the last tile to arrive, so it was
 * whatever the network happened to make it; this one starts when the building
 * is on screen and always lasts the same half second. Half a second is about how
 * long it takes to register that a picture has appeared, so the drop lands on
 * somebody who is already looking rather than on somebody still arriving.
 */
export const HOLD_MS = 500;

/**
 * How much of the fall already happened before the first frame, as a multiple of
 * the part that is drawn.
 *
 * A dropped object under gravity covers a quarter of its fall in the first half
 * of the time, so a pure `1 - u^2` from a standing start spends most of the
 * animation crawling — and since the pin starts ABOVE the top of the window, all
 * of that crawl is off camera. Measured against the framing this app uses, only
 * about a third of the drop was ever on screen.
 *
 * So the pin is not released at the first frame; it is CAUGHT at one, already
 * moving, which is also the literal truth of a thing that comes in from above
 * the picture. One unit of pre-fall — it has been falling for as long again as
 * we watch it — puts half the animation on screen instead of a third, and the
 * motion is still constant acceleration throughout. It is the same parabola,
 * joined later.
 */
const PRE_FALL = 1;

/**
 * Speed at the moment of landing, in units of `drop / DROP_MS`.
 *
 * Derived rather than measured: the fall is `((l+1)^2 - (u+l)^2) / (1+2l)` of
 * the drop, whose slope at u = 1 is `2(l+1) / (1+2l)`. It is here because the
 * shutter length is chosen from it — see SHUTTER below — and a PRE_FALL changed
 * without this changing with it would silently lengthen or shorten the trail.
 */
const LANDING_SPEED = (2 * (PRE_FALL + 1)) / (1 + 2 * PRE_FALL);

/**
 * How far above the top of the window the pin's FOOT waits, as a multiple of the
 * pin's drawn height, and the shortest fall that is still a fall.
 *
 * A SLIVER, and the first version of this was 1.15 — which was a plain mistake
 * rather than a taste, and one worth leaving written down because it is easy to
 * make twice. A pin extends UPWARD from its foot, so the foot reaching the top
 * edge already puts the entire drawing off camera; there is nothing to clear
 * beyond it. 1.15 therefore parked the pin a whole extra pin height higher than
 * it needed to be, and at the framing this app uses that is 74 px of a 189 px
 * fall spent above the picture. Just over half the drop was on screen and the
 * rest was a wait.
 *
 * At 0.08 it is five pixels, which is there for the half-pixel a device pixel
 * ratio can put back on screen and for nothing else, and 94% of the fall happens
 * where it can be watched.
 *
 * The floor is for the case the projection can produce and the framing normally
 * does not: a roof at or above the top edge, where "start above it" asks for no
 * fall at all. One pin height is the least that reads as a drop.
 */
const CLEAR_PINS = 0.08;
const MIN_DROP_PINS = 1;

/**
 * The shutter, in the sense a camera means it: how far back in TIME the trail
 * reaches, and how many samples of it are drawn.
 *
 * There is no directional blur in CSS or in deck.gl — `filter: blur()` is
 * isotropic and reads as fog rather than as speed — so this does what
 * src/pin-select.js does for the map's own marker and samples time instead of
 * filtering space. Each ghost is not an approximation of where the pin has
 * been; it is the pin as it was, one shutter step earlier, running the same fall.
 *
 * The LENGTH of the trail is what has to be right, and it is specified here in
 * pin heights rather than in milliseconds. A trail is only legible between two
 * bounds: shorter than about half a pin and it hides under the pin's own
 * outline, longer than about one and a half and the ghosts separate into a
 * column of stamps. Fixing the time instead — which the first version did — sets
 * the length only for one particular speed, and this drop is now more than twice
 * as fast as that one was. So the step is solved for: distance over speed, with
 * the landing speed the trail is wanted at.
 */
/**
 * Whether the falling pin trails copies of itself at all. Off for now, by
 * request.
 *
 * One flag rather than a deletion, for the reason SHOW_HIGHLIGHT in
 * src/flyover-view.js is one: everything below still works and still says what
 * a shutter is, and turning it back on is `true`. The constants under it are
 * left alone deliberately — `shutterMs` is what solves the trail's length from
 * the landing speed, and that derivation is the part worth keeping legible.
 */
const SHOW_TRAIL = false;

const GHOSTS = 6;
const TRAIL_PINS = 0.85;
/** The nearest ghost's opacity; the rest fall off linearly behind it. */
const GHOST_ALPHA = 0.34;
const shutterMs = (drop, px) => (TRAIL_PINS * px * DROP_MS) / (LANDING_SPEED * drop * GHOSTS);

/**
 * The landing: how far the pin compresses when it arrives, and how long the
 * whole compression takes.
 *
 * ONE DIP. It was a decaying sine — a squash, an overshoot past full height, and
 * two or three smaller swings ringing down — which is the textbook bounce and is
 * more gesture than this moment can carry. A marker is not a ball; it does not
 * have anywhere to bounce to. What survives is the part that reads: the pin
 * takes the landing on its legs and stands back up, once.
 *
 * Half a sine gives exactly that and nothing else. It leaves full height at the
 * moment of contact, reaches its deepest at the midpoint, and is back at one at
 * the end — no overshoot to suppress and no tail to wait out. It also holds the
 * compression: the curve is within a tenth of its deepest for 60% of its length,
 * which is 114 ms, so the squash is caught by frames rather than falling between
 * them. That was the whole reason the old curve was a sine and not a cosine, and
 * it survives the simplification.
 *
 * 0.26 rather than the 0.38 the decaying version carried, because that amplitude
 * was being multiplied by an exponential that had already taken a third off it
 * before the curve reached its lowest point. Measured on screen the old squash
 * bottomed out at 0.76 of full height; this bottoms out at 0.74.
 */
const SQUASH = 0.26;
const SQUASH_MS = 190;

/**
 * How tall the pin stands at `ms`, as a fraction of its drawn height.
 *
 * One before it lands, because nothing is compressing a pin in mid-air, and one
 * again once it is over — this returns to full height and stays there rather
 * than approaching it.
 */
export function squashed(ms) {
  const t = ms - DROP_MS;
  if (!(t > 0) || t >= SQUASH_MS) return 1;
  return 1 - SQUASH * Math.sin((Math.PI * t) / SQUASH_MS);
}


/**
 * The end of everything: the fall, plus the compression that follows it.
 *
 * For callers that want the pin where it ends up without playing the drop —
 * `prefers-reduced-motion`, and a test that wants a stable frame. It is an exact
 * time rather than a bound now that the squash ends rather than decays. The
 * trail is comfortably inside it: the shutter totals `TRAIL_PINS * px * DROP_MS
 * / (LANDING_SPEED * drop)` and `drop` is never less than `CLEAR_PINS * px`,
 * which caps it at well under half of DROP_MS whatever the viewport is.
 */
export const SETTLED_MS = DROP_MS + SQUASH_MS;

/**
 * How tall the pin is drawn, as a fraction of the viewport's height.
 *
 * A CONSTANT pixel size all the way down, which is the decision that makes the
 * trail legible and is not the physically obvious one — a falling object ought
 * to change size as it nears the camera. src/pin-select.js records what happens
 * when a shutter is pointed at a motion that is mostly scale: every past sample
 * of a growing object is smaller than the present one and hides behind it, and
 * the trail vanishes under the pin's own outline. A pure translation has nowhere
 * to hide, so the blur reads.
 *
 * 0.28 rather than the 0.18 this started at, and the change was affordable
 * rather than merely wanted. The old number was a compromise against headroom:
 * the pin had to fit BETWEEN the roof and the top of the frame with room to fall
 * in, and there is only about 85 px of that. Starting the fall off camera
 * retires the constraint completely — there is no upper bound on the sky when
 * the sky is not where the pin waits — so the size is now free to be chosen for
 * legibility, which at these viewport sizes wants about a quarter of the height.
 */
const PIN_FRAC = 0.28;
const PIN_MIN_PX = 34;
const PIN_MAX_PX = 110;

/**
 * How much of the sky above the roof the LANDED pin may fill.
 *
 * The headroom constraint, which came back the moment the camera dropped to 63
 * degrees off nadir. Starting the fall off camera retired it for the FALLING
 * pin — there is no upper bound on a sky the pin is not waiting in — but the
 * landed one still has to fit between the roof it stands on and the top edge,
 * and at a low angle a tall building's roof rides close to that edge: altitude
 * projects further the more oblique the shot, so the Library's roof sits within
 * a pin height of the top of its own picture. Photographed at a flat 0.28 of the
 * viewport, the ball was cut in half by the frame — and the ball is the marker.
 *
 * So the size is the smaller of what legibility wants and what the shot has.
 *
 * 0.62 RATHER THAN THE 0.9 THIS STARTED AT. That was set while a "Here" label
 * stood above the ball — a third of a pin of gap plus a line of type, about 1.55
 * pins of stack for the sky to hold, and at 0.9 the word was clipped clean off
 * the top of the frame. The label is gone and this is deliberately not back at
 * 0.9: the headroom it bought is what keeps the ball clear of the top edge when
 * a tall building puts the roof high in the shot, which was always the other
 * half of the reason.
 */
const HEADROOM = 0.62;


/**
 * The cast shadow: the shortest and longest it may reach in pin heights of
 * ground, how quickly height fades it, and how dark it is at contact.
 *
 * A shadow that only fades is a fade; a shadow that only moves is a decal. Both
 * happen here and they are reciprocal on purpose — the same light spread over
 * more ground — so the shadow's total darkness is roughly conserved and what
 * moves is its concentration.
 *
 * SOFTEN is in pin heights of lift, and 2 is not arbitrary either: the fall is
 * around two and a half pin heights at this framing, so the shadow starts at
 * about a third of its landed strength and gathers the whole way down.
 *
 * THE STRENGTH IS ALMOST FULL, which looks wrong written down and is not. The
 * softening is in the DRAWING — see CAST_STOPS in src/push-pin.js, whose alpha
 * is already a penumbra falling to nothing at the edges — so this multiplies a
 * shape that is only briefly opaque at its own core. Photographed at 0.55 over
 * the Library's roof, which is bright mottled gravel with dark plant on it, the
 * shadow lost to the texture at most bearings and simply was not there.
 */
const SHADOW_MIN_PINS = 1.35;
const SHADOW_MAX_PINS = 1.5;
const SHADOW_SOFTEN = 2;
const SHADOW_ALPHA = 0.9;

/**
 * Where the sun is: how far a shadow slides across the ground per unit of its
 * caster's height, and the compass bearing it slides TOWARD.
 *
 * A shadow directly under its object is what an object under a studio softbox
 * does, and on a roof it reads as a dark halo rather than as a shadow at all —
 * there is nothing in it to say the pin is standing up. Sliding it out gives it
 * the one thing a cast shadow is for.
 *
 * NEITHER NUMBER IS A TASTE. The imagery under this pin has its own sun baked
 * into it — every tree in a Google 3D tile carries the shadow it had at capture
 * — so a pin lit from somewhere else is a composite that looks like one. my campus is
 * at 38.65 N, where the sun is due south at noon and shadows therefore run due
 * north; aerial capture runs from mid-morning to mid-afternoon, which swings
 * that a little either way. 15 degrees is that band's middle. The slope is
 * 1/tan of the sun's elevation, and 0.84 is a sun about 50 degrees up — high,
 * as it is when this imagery is flown, and short enough to keep the shadow on
 * the building it belongs to.
 */
const SUN_TOWARD_DEG = 15;
const SUN_SLIDE = 0.7;

/**
 * How far above the roof the pin's anchor sits, in metres, so it can be
 * OCCLUDED without being buried.
 *
 * The pin is depth-tested, which is a reversal: it used to draw over everything
 * so that it could never disappear behind the building it was marking. A tree in
 * front of it drew through it, and a marker that ignores a tree is a sticker on
 * the lens rather than a thing in the shot.
 *
 * A billboard makes that a coarse test rather than a per-pixel one, and it is
 * worth knowing exactly how coarse: every fragment of one carries the depth of
 * its ANCHOR, because deck.gl projects the anchor and then adds the quad's size
 * and offset in clip space. So this pin is at the depth of the point it stands
 * on, and it is hidden by anything nearer the camera than THAT — which is the
 * tree the request is about, and is not, say, a branch that only overlaps the
 * ball. The whole pin goes at once.
 *
 * The clearance is what stops the other failure: an anchor exactly on the roof
 * z-fights with it, and src/roofs.json holds z to one decimal, so a roof written
 * as 0 could be a hand's width under its own surface and swallow the pin
 * entirely. Two metres is past both. It is paid back exactly — see `clear` in
 * `pinLayers`, which pushes the pin back down by however many pixels those two
 * metres bought — so nothing moves on screen for it.
 */
export const CLEAR_M = 2;
/** The same, for the shadow, which is a flat quad lying ON the roof it z-fights. */
const SHADOW_CLEAR_M = 1;

/**
 * Pixels above the roof at `ms` into the drop.
 *
 * Constant acceleration, observed from PRE_FALL of the way down — see there. At
 * `l = 0` this is the plain `1 - u^2` of an object let go at the first frame.
 */
export function fallen(ms, drop) {
  if (!(ms > 0)) return drop;
  if (ms >= DROP_MS) return 0;
  const u = ms / DROP_MS;
  const l = PRE_FALL;
  return drop * (((l + 1) ** 2 - (u + l) ** 2) / (1 + 2 * l));
}

/**
 * How tall to draw the pin, in CSS pixels.
 *
 * `roofY` is the roof's own distance below the top edge — the sky the landed pin
 * has to stand in. Omitting it asks for the unconstrained size, which is what a
 * caller with no projection to hand can know.
 */
export const pinHeight = (viewportHeight, roofY = Infinity) => Math.round(
  Math.max(PIN_MIN_PX, Math.min(PIN_MAX_PX, viewportHeight * PIN_FRAC, roofY * HEADROOM)),
);

/**
 * How far the pin falls, in CSS pixels, given where the roof projects.
 *
 * `roofY` is the roof's own screen position measured down from the top edge, so
 * the fall is that distance plus enough pin to have the drawing entirely off
 * camera at the first frame. Nothing here knows the pitch, the latitude or the
 * zoom, which is the point: they are all already inside `roofY`.
 */
export function dropPixels(roofY, viewportHeight) {
  const px = pinHeight(viewportHeight, roofY);
  return Math.max(MIN_DROP_PINS * px, roofY + CLEAR_PINS * px);
}

/**
 * The rasterised pin, cached per colour and size.
 *
 * Rasterised at twice the drawn size because deck.gl uploads an icon to a
 * texture atlas once at whatever resolution the image decodes to, and an SVG
 * without intrinsic dimensions decodes at 300x150 — see the `height` option on
 * `pushPinSvg`, which exists for this call.
 *
 * `anchorY` is the whole point of the geometry in push-pin.js: the pin marks a
 * place with its FOOT, and the foot is NOT at the bottom of the box — there is a
 * sliver of padding under it so its antialiasing is not clipped. Anchoring to
 * the box would stand every pin on the campus off its roof by that much, so the
 * anchor comes from the drawing's own measurement of where its foot is.
 */
const icons = new Map();
/**
 * How many distinct heights the squash is allowed to be drawn at.
 *
 * The compression is a half-sine over SQUASH_MS, so it passes through every
 * height twice and only STEPS of it are ever distinct pictures. Quantising is
 * not an economy here, it is a correctness measure: deck.gl loads an icon the
 * first time it sees its id and repacks its atlas when it does, so an unbounded
 * set would mean a fresh image decode on nearly every frame of the landing —
 * which is precisely the moment that must not hitch. Twelve steps over a 26%
 * compression is a little over two percent per step, which is under a pixel on
 * a hundred-pixel pin and is invisible; and all twelve are warmed before the
 * fall begins. See `warmPinIcons`.
 */
const SQUASH_STEPS = 12;
const quantise = (squash) => Math.round(squash * SQUASH_STEPS) / SQUASH_STEPS;

/**
 * The pin, at a height and a compression.
 *
 * THE WIDTH IS THE SAME AT EVERY COMPRESSION, and getting that right is the
 * whole point of taking a `squash` here rather than scaling the layer's own
 * `getSize`. deck.gl draws an icon `getSize` tall and derives its width from the
 * icon's own aspect, so a caller that squashes by handing a smaller size gets a
 * pin that is shorter AND narrower — a pin moving away from the camera. Baking
 * the compression into the icon's box instead means its declared aspect widens
 * by exactly the factor the size shrinks by, and the two cancel: the drawing
 * loses height and keeps its width, which is what hitting the ground looks like.
 *
 * The anchor moves with the box, so the point of the pin stays on the roof
 * rather than sinking into it as the ball comes down.
 */
export function pinIcon(colour, px, squash = 1) {
  const s = quantise(squash);
  const key = `${colour}@${px}@${s}`;
  const cached = icons.get(key);
  if (cached) return cached;
  // The FULL height is what the width is derived from, so it does not move.
  const full = px * 2;
  const height = full * s;
  const width = Math.round(full / PUSH_PIN.aspect);
  const icon = {
    id: key,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      pushPinSvg({ colour, id: key.replace(/[^a-z0-9]/gi, ''), height: full, squash: s })) }`,
    width,
    height,
    anchorX: width / 2,
    anchorY: height * PUSH_PIN.anchor,
  };
  icons.set(key, icon);
  return icon;
}

/**
 * Decode every compression the landing will ask for, before it asks.
 *
 * Called once when a flyover knows what size it is drawing, which is a beat and
 * a fall — the better part of a second — before the first squashed frame is
 * needed. Without it the first appearance of each step is an image decode and an
 * atlas repack inside the 190 ms the pin is compressing, and the pin flickers
 * exactly where it is supposed to look solid.
 */
const warmed = new Set();
export function warmPinIcons(colour, px) {
  // IDEMPOTENT, because the caller is inside an animation loop and the whole
  // point is to do this work once, early. Thirteen image decodes are cheap in
  // the abstract and are not cheap on the frame the pin starts falling.
  const key = `${colour}@${px}`;
  if (warmed.has(key)) return;
  warmed.add(key);
  for (let i = 0; i <= SQUASH_STEPS; i += 1) {
    const icon = pinIcon(colour, px, i / SQUASH_STEPS);
    if (typeof Image === 'undefined') continue;
    const img = new Image();
    img.src = icon.url;
  }
}

/**
 * The shadow, which is one shape at one size: the layer scales and turns it.
 *
 * Anchored at the BOTTOM of its box, because that end of it is the pin's foot —
 * the one point of a cast shadow that does not move when the caster rises. The
 * rest of the shape stretches away from there.
 */
let shadowIcon = null;
export const pinShadowIcon = () => (shadowIcon ??= {
  id: 'pin-shadow',
  url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pinShadowSvg({}))}`,
  width: SHADOW_BOX.w,
  height: SHADOW_BOX.h,
  anchorX: SHADOW_BOX.w / 2,
  anchorY: SHADOW_BOX.h,
  // A MASK, so `getColor` alone decides how dark it is. The drawing is a stencil
  // — black shapes whose whole content is their alpha — and letting the layer
  // own the colour is what lets one shape serve a shadow that fades as its
  // caster rises.
  mask: true,
});

/**
 * The shadow and the pin, as two layers, back to front.
 *
 * The pin's own samples are one layer rather than one per ghost because deck.gl
 * draws a layer's items in data order, so putting the oldest sample first and
 * the pin last gets the back-to-front order a trail needs without any depth
 * sorting — which would not work here anyway, since every sample is on the same
 * vertical line and they all share one depth.
 *
 * BOTH ARE DEPTH-TESTED and neither writes depth. Tested, so a tree between the
 * camera and the building hides them — see CLEAR_M for how coarsely a billboard
 * can manage that, and for the two metres of clearance that stop the pin being
 * swallowed by the roof it stands on. Not written, because seven overlapping
 * copies of one pin at one depth have nothing to say to each other and a shadow
 * has nothing to say to the pin above it.
 *
 * The shadow is the one thing here that is NOT a billboard. It is drawn with
 * `billboard: false` and sized in metres, which puts its quad flat in the ground
 * plane at the roof's own height — so the pitch squashes it into an ellipse and
 * the orbit turns it, for free and correctly, instead of it following the camera
 * around like a sticker on the lens. That is what "projected onto the building"
 * has to mean for it to read as a shadow at all.
 *
 * @param {object}   tools    the deck.gl toolkit, for IconLayer
 * @param {object}   options
 * @param {number[]} options.roof   [lon, lat, z] from src/roofs.json
 * @param {number}   options.drop   the fall's length in CSS pixels, from dropPixels
 * @param {number}   options.clear  what CLEAR_M of altitude is worth, in CSS pixels
 * @param {number}   options.px     the pin's drawn height, from `pinHeight`
 * @param {number}   options.span   the framed span in metres, for the shadow's size
 * @param {number}   options.width  the viewport's width in CSS pixels
 * @param {number}   options.height the viewport's height in CSS pixels
 * @param {number}   options.ms     time since the drop began; <=0 holds it up
 * @param {string}  [options.colour]
 */
export function pinLayers(
  { IconLayer },
  { roof, drop, clear, px, span, width, height, ms, colour = PUSH_PIN_RED },
) {
  // The compression is the icon's, so the icon is chosen per frame. The ghosts
  // share it: a trail of uncompressed pins behind a compressed one would read
  // as the pin having been replaced rather than squashed.
  const icon = pinIcon(colour, px, squashed(ms));
  const shutter = shutterMs(drop, px);

  const lift = fallen(ms, drop);
  const samples = [];
  for (let k = SHOW_TRAIL ? GHOSTS : 0; k >= 1; k -= 1) {
    const at = fallen(ms - k * shutter, drop);
    // A ghost that has caught up with the pin is not a fainter copy of it, it is
    // extra alpha on top of it — six of them stacked on a landed pin darken it
    // by a third. So the shutter empties itself rather than being switched off
    // at some time that would have to be kept in step with GHOSTS.
    if (at === lift) continue;
    samples.push({ lift: at, alpha: Math.round(255 * GHOST_ALPHA * (1 - (k - 1) / GHOSTS)) });
  }
  samples.push({ lift, alpha: 255 });

  // EVERY SQUASH FRAME, DRAWN INVISIBLY, WHILE THE PIN IS STILL FALLING.
  //
  // Safari flickered here and Chrome did not, and the difference is decode
  // speed rather than anything either browser does wrong. The compression is
  // baked into the icon (see pinIcon), so the landing steps through twelve
  // distinct icon ids — and deck.gl loads an icon the FIRST time it sees one,
  // asynchronously, repacking its atlas when it arrives. Between the request
  // and the repack there is nothing to draw, so the pin blinks out for a frame
  // or two. Chrome decodes a 400-byte data: URI fast enough to land inside one
  // frame; Safari does not, and the whole landing strobes.
  //
  // `new Image()` warming does not fix it: that fills the BROWSER's image
  // cache, and deck.gl's atlas is a separate thing that is still built the
  // first time a layer references the id. The only way to have an icon in the
  // atlas is to have asked for it, so they are asked for — at zero alpha, at
  // the pin's own position, during the fall. Twelve invisible quads for a
  // hundred and sixty milliseconds, and every icon the landing needs is
  // resident before the landing starts.
  //
  // Dropped the moment the compression begins, so the settled pin is one quad.
  if (ms < DROP_MS) {
    for (let i = 0; i < SQUASH_STEPS; i += 1) {
      samples.push({ lift, alpha: 0, warm: i / SQUASH_STEPS });
    }
  }

  // Reciprocal, so the shadow's total darkness is conserved: the same light is
  // spread over more shadow the higher its caster is.
  const spread = 1 + lift / (SHADOW_SOFTEN * px);

  // HOW FAR THE SHADOW REACHES. Only the ball casts one worth drawing, so the
  // shadow's far end is where the ball's own height — the fall, plus how high it
  // rides on its needle — puts it once the sun's slope has carried it out along
  // the ground.
  //
  // THE HEIGHT HAS TO BE CONVERTED, and getting that wrong is what made the
  // first version of this reach four times too far. Everything else in this file
  // is in screen pixels, and a screen pixel of ALTITUDE is not a screen pixel of
  // GROUND: deck.gl scales z by the Mercator factor and the pitched camera
  // magnifies it again, which at this latitude and pitch is a little over two to
  // one. `clear` is that ratio, already measured by the projection itself —
  // CLEAR_M metres of altitude came out as `clear` pixels — so it converts the
  // ball's height into metres exactly, with no constant to keep in step.
  //
  // Then bounded at both ends, because past a point the physics stops being the
  // point. A pin two hundred pixels up genuinely throws its shadow fifty metres,
  // which is off the building, into the trees, and no longer says anything about
  // where the pin is going to land; and a landed pin under a high sun throws one
  // barely longer than its own foot, which says nothing either.
  const ballM = ((lift + PUSH_PIN.ride * px) * CLEAR_M) / clear;
  const perMetre = width / span;
  const reach = Math.min(
    Math.max((SUN_SLIDE * ballM * perMetre) / SHADOW_BOX.at, SHADOW_MIN_PINS * px),
    SHADOW_MAX_PINS * px,
  );
  // The shadow is anchored at the pin's FOOT and stretches from there, so the
  // position is the roof itself and `getAngle` does the aiming.
  //
  // SIZED IN PIXELS, and it is a flat quad in the GROUND plane, which is a
  // combination worth reading twice. `billboard: false` is what lays it down —
  // the quad is built in the ground plane, so the pitch foreshortens it and the
  // orbit turns it, the way it does every real shadow in the imagery, instead of
  // it following the camera around like a sticker on the lens. `sizeUnits` then
  // says what a unit of `getSize` means, and 'meters' is the answer that looks
  // right and is not: measured against the roof it lies on, a shadow asked for
  // in metres came out 1.87 times too long — the metres-to-pixels conversion is
  // applied on the way in and the pixels-to-common one on the way out, and for a
  // ground-plane quad those do not cancel. In pixels it is one conversion and it
  // measures true, which is also the unit `reach` was worked out in.
  const cast = [roof[0], roof[1], roof[2] + SHADOW_CLEAR_M];

  // The word, a second after the pin is down. Placed off the pin's CURRENT
  // height so it rides the squash with the head rather than hanging still over
  // a pin that is still moving — by the time it shows, that is nearly settled
  // anyway, and "nearly" is exactly the kind of thing that is only invisible
  // until it is not.

  return [
    new IconLayer({
      id: 'flyover-pin-shadow',
      data: [cast],
      getPosition: (d) => d,
      getIcon: pinShadowIcon,
      getSize: reach,
      // Negative, and it is worth writing down why rather than trying it twice.
      // The icon's own up is (0,-1); the shader rotates by `mat2(cos,-sin,sin,
      // cos)`, flips y, and lands the result in common space where +y is north.
      // Following (0,-1) through comes out at (-sin a, cos a) east-north, and a
      // compass bearing B is (sin B, cos B), so a = -B.
      getAngle: -SUN_TOWARD_DEG,
      getColor: [0, 0, 0, Math.round((255 * SHADOW_ALPHA) / spread)],
      billboard: false,
      sizeUnits: 'pixels',
      alphaCutoff: 0.01,
      parameters: { depthCompare: 'less-equal', depthWriteEnabled: false },
      updateTriggers: { getPosition: cast, getSize: reach, getColor: spread },
    }),
    new IconLayer({
      id: 'flyover-pin',
      data: samples,
      // Every sample is at the SAME place, CLEAR_M above the roof so the depth
      // test has something to work with — and pushed straight back down by
      // `clear`, which is what those metres are worth in pixels here. The fall
      // is the rest of the offset, so the pin's foot is exactly on the roof at
      // the end of it rather than nearly.
      getPosition: () => [roof[0], roof[1], roof[2] + CLEAR_M],
      getPixelOffset: (d) => [0, clear - d.lift],
      // A warm sample names its own compression so deck.gl actually loads that
      // icon; everything else is the pin as it is right now.
      getIcon: (d) => (d.warm === undefined ? icon : pinIcon(colour, px, d.warm)),
      // The landing squash. Anchored at the point, so compressing the pin drops
      // its head toward the roof and leaves the point where it landed.
      // DERIVED FROM THE ICON rather than recomputed, and it has to be. The
      // compression rides the icon's box (see pinIcon) and is quantised to
      // twelve steps there; asking `squashed(ms)` for the size again would hand
      // deck.gl a continuous height against a stepped aspect, and the width
      // would wobble by up to four percent through the landing. Taken from the
      // chosen icon the two cannot disagree: the drawn width is `icon.width / 2`
      // whatever the compression is.
      getSize: icon.height / 2,
      // Only the alpha is read: the icon is not a mask, so the shader keeps the
      // pin's own colours and multiplies this in. That is what a ghost needs —
      // a fainter copy of the same drawing, not a flat silhouette of it.
      getColor: (d) => [255, 255, 255, d.alpha],
      billboard: true,
      sizeUnits: 'pixels',
      // Below deck.gl's default of 0.05 the faintest ghost survives: it is drawn
      // at 0.057 alpha, so at the default its antialiased edge is discarded and
      // it reads as a hard-edged stamp rather than as a blur.
      alphaCutoff: 0.01,
      parameters: { depthCompare: 'less-equal', depthWriteEnabled: false },
      updateTriggers: { getPixelOffset: ms, getSize: ms, getIcon: icon.id },
    }),
  ];
}

