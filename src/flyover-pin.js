// The pin the flyover drops on the building you tapped.
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

import { pushPinSvg, PUSH_PIN, PUSH_PIN_RED } from './push-pin.js';

/**
 * How far the pin falls, IN PIXELS OF SCREEN, and how long it takes.
 *
 * Pixels rather than metres, and that is the whole lesson of this file. The
 * first version dropped the pin 0.45 of the framed span — 88 m over the Library
 * — on the reasoning that a vertical rod of height H covers H * sin(55) of the
 * picture. Photographed, the pin was invisible for the entire fall and simply
 * appeared, landed, at the end. There is very little sky in this shot: the
 * camera is pitched 55 degrees at a building it fills a quarter of the frame
 * with, so the roof projects about 85 px below the top edge of a 225 px picture
 * and everything above that is off-camera. A drop measured in metres cannot know
 * that, and 88 m is ten times more than there is room for.
 *
 * So the height is expressed as a multiple of the PIN's own drawn height, which
 * is in pixels by construction and therefore already in the units the headroom
 * is measured in. At 1.6 pin-heights the fall is 66 px against 44 px of sky
 * above a landed 41 px pin: it starts a little over the top edge and is on
 * screen for the last 260 ms, with the trail reaching up out of shot behind it,
 * which is what a thing falling INTO a picture looks like.
 */
const DROP_PINS = 1.6;
export const DROP_MS = 620;

/**
 * How long the tileset has to go quiet — no tile arriving — before the pin is
 * allowed to fall.
 *
 * A SIGNAL RATHER THAN A DELAY, and the two earlier attempts are why. A tile
 * reporting `contentAvailable` is not a tile on screen: Tile3DLayer is a
 * composite and still has to build a ScenegraphLayer for it and upload the
 * glTF. So the first version dropped the pin onto bare grid and the building
 * faded up underneath it a moment later.
 *
 * Tightening the level-of-detail threshold did not fix it — READY_ERROR_M went
 * from 16 m to 8.5 in src/flyover-view.js and the gap barely moved, because the
 * lag is in the renderer rather than in the tiles. Nor did a fixed 450 ms wait,
 * and the reason is the interesting one: the gap is not a constant. The Library
 * is drawn about half a second after its roof tile lands and the Parking Garage
 * about 1.6 s, because the garage is 118 m long, is framed at a 472 m span, and
 * needs several times as many tiles to cover. Any single number is either too
 * short for the garage or a stall on everything else.
 *
 * What both cases have in common is that the picture is complete when tiles
 * STOP ARRIVING. 300 ms of silence is longer than the gap between tiles within
 * one burst and shorter than anyone waits, and it needs no per-building
 * knowledge at all. A building whose tiles are entirely in the cache loads
 * nothing, so it is quiet from the start and the pin falls immediately, which is
 * also right.
 */
export const QUIET_MS = 300;

/**
 * Screen pixels per metre of ALTITUDE, as a multiple of pixels per metre of
 * ground — because those are not the same number and assuming they were is what
 * made the first drop invisible.
 *
 * Measured, by holding the pin at a known height above the Library's roof and
 * reading the ball's centroid off a screenshot: 0 m put it at row 160.2, 10 m at
 * row 120.6, so 10 m of altitude is 39.6 px. The same view draws 196 m of ground
 * across 368 px, or 1.878 px per ground metre, so altitude is drawn 2.11 times
 * larger.
 *
 * Most of that is Mercator — deck.gl scales z by the same factor as x and y, and
 * at my campus's latitude that is 1/cos(38.65) = 1.28 — and the rest is the pitched
 * perspective, where a point above the target is nearer the camera than the
 * target is. Both terms are fixed for this viewport: one latitude, one pitch. It
 * is a constant here, and it would not be in an app that let either move.
 */
const ALTITUDE_GAIN = 2.11;

/**
 * The shutter, in the sense a camera means it: how far back in TIME the trail
 * reaches, and how many samples of it are drawn.
 *
 * There is no directional blur in CSS or in deck.gl — `filter: blur()` is
 * isotropic and reads as fog rather than as speed — so this does what
 * src/pin-select.js does for the map's own marker and samples time instead of
 * filtering space. Each ghost is not an approximation of where the pin has
 * been; it is the pin as it was, SHUTTER_MS per step, running the same fall.
 *
 * The span is chosen from the pin's actual speed, which is now the same on every
 * building by construction: the fall is DROP_PINS pin-heights and the pin is a
 * fixed fraction of the viewport, so nothing about the building enters it. A
 * 41 px pin falls 66 px in DROP_MS and peaks at 2 * 66 / 620 = 0.21 px/ms, so
 * five samples 26 ms apart trail about 28 px behind it — two thirds of a pin
 * length, which is what reads as speed rather than as a smudge.
 */
const GHOSTS = 5;
const SHUTTER_MS = 26;
/** The nearest ghost's opacity; the rest fall off linearly behind it. */
const GHOST_ALPHA = 0.34;

/**
 * The moment nothing is moving any more: the fall, plus the shutter emptying.
 *
 * For callers that want the pin where it ends up without playing the drop —
 * `prefers-reduced-motion`, and a test that wants a stable frame.
 */
export const SETTLED_MS = DROP_MS + GHOSTS * SHUTTER_MS;

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
 * 0.18 is a compromise against the headroom rather than a size that was liked.
 * The pin has to fit UNDER the top of the frame with room to fall into it, and
 * there is only about 85 px between the roof and the top edge — see DROP_PINS.
 * At 0.3 the pin was 69 px of that 85 and there was nowhere left to fall from;
 * at 0.18 it is 41 px and leaves 44, which is a fall worth watching and still a
 * marker worth seeing.
 */
const PIN_FRAC = 0.18;
const PIN_MIN_PX = 26;
const PIN_MAX_PX = 60;

/**
 * Metres above the roof at `ms` into the drop.
 *
 * `1 - u^2` rather than an ease, because this is a fall and a fall is constant
 * acceleration: distance goes as the square of time. It also puts the pin at its
 * fastest at the moment it lands, which is where the trail is wanted — an
 * ease-out would arrive slowest exactly where the motion has to read.
 */
export function fallen(ms, drop) {
  if (!(ms > 0)) return drop;
  if (ms >= DROP_MS) return 0;
  const u = ms / DROP_MS;
  return drop * (1 - u * u);
}

/** How tall to draw the pin in a viewport of this height, in CSS pixels. */
export const pinHeight = (viewportHeight) =>
  Math.round(Math.max(PIN_MIN_PX, Math.min(PIN_MAX_PX, viewportHeight * PIN_FRAC)));

/**
 * How far the pin falls, in METRES, for a drop that covers DROP_PINS pin-heights
 * of screen.
 *
 * The conversion the first version did not have. `width / span` is what one
 * ground metre is worth in pixels — the framing's own scale — and ALTITUDE_GAIN
 * is how much more a metre of height is worth than that.
 */
export function dropMetres(span, width, height) {
  const perGroundMetre = width / span;
  return (DROP_PINS * pinHeight(height)) / (ALTITUDE_GAIN * perGroundMetre);
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
 * place with its POINT, and the point is at the very bottom of its box, so the
 * anchor is the box's full height rather than the middle of a head.
 */
const icons = new Map();
function iconFor(colour, px) {
  const key = `${colour}@${px}`;
  const cached = icons.get(key);
  if (cached) return cached;
  const height = px * 2;
  const width = Math.round(height / PUSH_PIN.aspect);
  const icon = {
    id: key,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      pushPinSvg({ colour, id: key.replace(/[^a-z0-9]/gi, ''), height })) }`,
    width,
    height,
    anchorX: width / 2,
    anchorY: height,
  };
  icons.set(key, icon);
  return icon;
}

/**
 * The pin and its trail, as one layer.
 *
 * One layer rather than one per ghost because deck.gl draws a layer's items in
 * data order, so putting the oldest sample first and the pin last gets the
 * back-to-front order a trail needs without any depth sorting — which would not
 * work here anyway, since every sample is on the same vertical line and the
 * depth test is off.
 *
 * OFF, deliberately. The pin is a marker, not an object in the scene: its job is
 * to say which building this is, and a marker that disappears behind a roof for
 * half of every orbit has stopped doing that job. Turning the test off also
 * sidesteps a billboard's real limitation — every fragment of one carries the
 * depth of its anchor, so a pin standing ON a roof either passes or fails the
 * test as a whole and z-fights while it decides.
 *
 * @param {object}   tools    the deck.gl toolkit, for IconLayer
 * @param {object}   options
 * @param {number[]} options.roof   [lon, lat, z] from src/roofs.json
 * @param {number}   options.span   the framed span in metres, for the drop height
 * @param {number}   options.width  the viewport's width in CSS pixels
 * @param {number}   options.height the viewport's height in CSS pixels
 * @param {number}   options.ms     time since the drop began; <=0 holds it up
 * @param {string}  [options.colour]
 */
export function pinLayer({ IconLayer }, { roof, span, width, height, ms, colour = PUSH_PIN_RED }) {
  const px = pinHeight(height);
  const icon = iconFor(colour, px);
  const drop = dropMetres(span, width, height);
  const [lon, lat, z] = roof;

  const landed = z + fallen(ms, drop);
  const samples = [];
  for (let k = GHOSTS; k >= 1; k -= 1) {
    const at = z + fallen(ms - k * SHUTTER_MS, drop);
    // A ghost that has caught up with the pin is not a fainter copy of it, it is
    // extra alpha on top of it — five of them stacked on a landed pin darken it
    // by a third. So the shutter empties itself rather than being switched off
    // at some time that would have to be kept in step with GHOSTS.
    if (at === landed) continue;
    samples.push({ z: at, alpha: Math.round(255 * GHOST_ALPHA * (1 - (k - 1) / GHOSTS)) });
  }
  samples.push({ z: landed, alpha: 255 });

  return new IconLayer({
    id: 'flyover-pin',
    data: samples,
    getPosition: (d) => [lon, lat, d.z],
    getIcon: () => icon,
    getSize: px,
    // Only the alpha is read: the icon is not a mask, so the shader keeps the
    // pin's own colours and multiplies this in. That is what a ghost needs —
    // a fainter copy of the same photograph, not a flat silhouette of it.
    getColor: (d) => [255, 255, 255, d.alpha],
    billboard: true,
    sizeUnits: 'pixels',
    // Below deck.gl's default of 0.05 the faintest ghost survives: it is drawn
    // at 0.068 alpha, so at the default its antialiased edge is discarded and it
    // reads as a hard-edged stamp rather than as a blur.
    alphaCutoff: 0.01,
    parameters: { depthCompare: 'always', depthWriteEnabled: false },
    updateTriggers: { getPosition: ms, getSize: px, getIcon: icon.id },
  });
}
