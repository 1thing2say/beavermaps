// The highlight: the tapped building's own MASS, drawn as a volume.
//
// WHY A PIN IS NOT ENOUGH, which is the whole reason this exists. A pin marks a
// POINT on top of a mass, and the question a viewer actually has is which MASS.
// At 68 degrees off nadir over a campus where buildings touch — the Gym and the
// Practice Gym share a wall, Fine & Applied Arts holds both Music and the
// Theatre — two roofs meet in the picture with no line between them and a pin on
// one of them is a pin on either. Tracing the building answers the question the
// pin was only pointing at.
//
// IT CANNOT COME FROM THE IMAGERY. Google's photorealistic tiles are one
// continuous mesh: there is no building in there to select, tint, isolate or
// outline, and no amount of shader work invents a boundary the data does not
// carry. So the outline has to be OURS, drawn into their scene — and it can be,
// because src/directory.json holds a real traced footprint for all thirty
// buildings and src/roofs.json holds a measured roof for each.
//
// HELD, NOT SWEPT. This drew a grid once — six levels, verticals every twelve
// metres — and lit a band of it travelling across the building on a 35 degree
// bearing. It read as an effect. What a viewer wants from a card that has just
// opened is to know which building they are looking at for as long as they are
// looking at it, and a mark that erases itself answers that only for the two
// seconds nobody was ready for.
//
// AND VOLUMETRIC, NOT FLAT, which is the other half. A ring lying on the roof
// says where the building's TOP is and leaves the eye to guess how far down it
// goes — and guessing how far down it goes is exactly the question at 68 degrees
// off nadir, where a roof and the ground behind it land on the same pixels. So
// the mark is the building's own volume: the footprint extruded from its
// measured ground to its measured roof, glazed, with the ring at the top, the
// ring at the bottom, and an upright at every corner between them. Three marks
// that together describe a box rather than a lid.
//
// CORNERS, NOT VERTICES, for the uprights. my campus's traced walls run to forty
// points on a curve, and a post at each of them is a fence. Only the vertices
// where the outline actually turns get one, which on a building is its corners.
//
// STILL DRAWN THROUGH THE SURFACE — depth test off — for the reason the sweep
// was: the far half of the outline is the half that says which mass this is when
// a neighbour is standing in front of it. A highlight that stopped at the near
// wall would be a sticker on it.
//
// A PATH RATHER THAN LINE SEGMENTS for the outline, which the sweep could not
// use. deck.gl's PathLayer builds its ribbon in the ground plane, so it cannot
// draw a vertical — the old mesh needed LineLayer for exactly that. This ring
// is horizontal, and PathLayer joins its corners instead of leaving a notch at
// every vertex of a forty-point wall.

import { DROP_MS } from './flyover-pin.js';

/**
 * When the highlight arrives, measured from the pin's landing.
 *
 * It waits for the squash rather than starting with it: the landing already
 * carries a compression, a trail emptying and a shadow tightening, and a second
 * event inside that is one too many to read. A seventh of a second later the pin
 * has settled and the mark has the frame to itself.
 *
 * Then it fades up, HOLDS FOR A SECOND, and goes. A second is long enough to be
 * read — the eye is already on the pin when the box arrives around it — and
 * short enough that the rest of a ninety-second orbit is the building rather
 * than the annotation. A mark that outlives its own answer is competing with the
 * thing it is describing.
 *
 * The rise and the fall are not the same length. Arriving is the event and wants
 * to be seen arriving; leaving should not be an event at all, so it takes longer
 * and nobody watches it happen.
 */
const WAIT_MS = 140;
const RISE_MS = 320;
const HOLD_MS = 1000;
const FALL_MS = 460;
/** When the box is fully up — the frame a still should be parked on. */
export const HIGHLIGHT_UP_MS = WAIT_MS + RISE_MS;
/** ...and when there is nothing left to draw. */
export const HIGHLIGHT_MS = HIGHLIGHT_UP_MS + HOLD_MS + FALL_MS;

/**
 * White, and how strong each part of it gets.
 *
 * THE CASING IS NOT A STYLE CHOICE. Photographed on the Library — pale concrete,
 * white glazing, gravel roof — a white line at 210 alpha was very nearly
 * invisible, because the one background white cannot be drawn on is white. The
 * outline is therefore drawn twice: a wider dark one first and the white one
 * over it, which is the same thing the label does with a grey border and the
 * same thing a map does with every road casing ever drawn.
 *
 * The casing is 2.2 px wider, so about a pixel of it shows on each side. Wider
 * and it is a dark line with a white core; this is a white line that survives.
 *
 * THE GLAZING IS WEAK ON PURPOSE, and weaker than a flat wash would be, because
 * a volume is not a plane: a line of sight through a box crosses two faces, and
 * anywhere the building is in front of itself, four. At 12% a flat wash reads as
 * a tint; the same 12% on a box reads as fog inside it. 7% is about where the
 * far wall still shows through as a second edge rather than as milk.
 */
const INK = [255, 255, 255];
const CASE_INK = [24, 24, 27];
const RING_ALPHA = 235;
const CASE_ALPHA = 130;
const RING_WIDTH = 1.6;
const CASE_EXTRA = 2.2;
const FILL_ALPHA = 18;
/** The uprights, which are thinner than the rings they join. */
const POST_WIDTH = 1.2;
/**
 * How sharply the outline has to turn before a vertex counts as a corner.
 *
 * 25 degrees. A traced curve steps a few degrees at a time and a building's
 * corner is very nearly a right angle, so anywhere in the twenties separates
 * them with room to spare — the Library's outline turns 0.4 to 6 degrees along
 * its curved north wall and 88 to 92 at its four corners.
 */
const CORNER_DEG = 25;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Every polygon of a footprint, whatever GeoJSON shape it arrived in.
 *
 * my campus's directory is all MultiPolygon and a third of the buildings have more
 * than one part — nine for the Student Center — so this cannot assume a single
 * outline. Rings are kept whole, holes included: the wash honours a courtyard
 * by not covering it, which is the whole reason it is worth keeping the inner
 * rings around. The OUTLINE takes ring zero only, because a hole traced at roof
 * height reads as a second building rather than as a gap in the first.
 */
function polygonsOf(geometry) {
  if (!geometry) return [];
  const polygons = geometry.type === 'MultiPolygon'
    ? geometry.coordinates
    : geometry.type === 'Polygon' ? [geometry.coordinates] : [];
  return polygons.filter((polygon) => polygon?.[0]?.length > 3);
}

/**
 * The box's geometry, built once per building rather than once per frame.
 *
 * THIS IS A PERFORMANCE FIX AND IT IS NOT A MICRO-ONE. `highlightLayers` is
 * called on every frame of the orbit, and the first cut rebuilt all of it every
 * time: five layers, each handed a freshly allocated array, with the ring
 * coordinates re-mapped and the corners re-detected from scratch. deck.gl
 * compares `data` by identity, so a new array every frame means it re-uploads
 * every attribute buffer every frame — for a footprint traced to forty points a
 * side, across nine polygons on the Student Center. That lands squarely on the
 * frames the pin is falling through, which is the one part of this anyone is
 * watching.
 *
 * Nothing in here depends on time. The only thing that changes frame to frame is
 * the alpha, and alpha is an accessor, not geometry. So it is computed once,
 * keyed on the footprint object the caller already holds — a card is one
 * building and holds one of these, and a second card gets a second entry — and
 * every layer below reads the same arrays for the whole life of the highlight.
 *
 * One entry, not a map: consecutive frames ask about the same building, and a
 * card that is replaced never asks again. Keeping the last answer is the whole
 * of the cache this needs and cannot grow.
 */
let lastShape = null;
function shapeFor(footprint, mass, roof) {
  if (lastShape && lastShape.footprint === footprint
    && lastShape.mass === mass && lastShape.roof === roof) return lastShape.value;

  const polygons = polygonsOf(footprint);
  if (!polygons.length || !mass) return null;
  const { ground, top } = mass;
  if (!(top - ground > 0)) return null;

  // THE ROOF PLANE, not the peak. `mass.top` is the highest point the building
  // reaches and roofs.json's centre is the roof it actually has — an area
  // weighted level rather than whatever aerial or parapet won. A ring hung at
  // the peak floats over most roofs; a ring at the roof lies on it. The peak is
  // the fallback for anything with no measured centre, which is nothing on this
  // campus but is a better answer than no highlight.
  const z = Number.isFinite(roof?.[2]) ? roof[2] : top;
  const at = (p, height) => [p[0], p[1], height];
  const rings = polygons.map((polygon) => polygon[0]);

  // THE CORNERS, as uprights from the ground ring to the roof ring. A ring is
  // closed — its last point is its first — so the turn at vertex i is measured
  // between the segment arriving at it and the segment leaving it, and the
  // closing duplicate is skipped rather than counted as a vertex of its own.
  const posts = [];
  for (const ring of rings) {
    const n = ring.length - 1;
    for (let i = 0; i < n; i += 1) {
      const before = ring[(i - 1 + n) % n];
      const here = ring[i];
      const after = ring[(i + 1) % n];
      const inbound = Math.atan2(here[1] - before[1], here[0] - before[0]);
      const outbound = Math.atan2(after[1] - here[1], after[0] - here[0]);
      let turn = Math.abs(outbound - inbound) * (180 / Math.PI);
      if (turn > 180) turn = 360 - turn;
      if (turn >= CORNER_DEG) posts.push({ from: at(here, ground), to: at(here, z) });
    }
  }

  const value = {
    volume: polygons.map((polygon) => polygon.map((ring) => ring.map((p) => at(p, ground)))),
    roofRing: rings.map((ring) => ring.map((p) => at(p, z))),
    baseRing: rings.map((ring) => ring.map((p) => at(p, ground))),
    posts,
    lift: z - ground,
  };
  lastShape = { footprint, mass, roof, value };
  return value;
}

/**
 * The highlight, as a box, or nothing at all before it is due.
 *
 * @param {object} tools             the deck.gl toolkit
 * @param {object} options
 * @param {object} options.footprint GeoJSON geometry from src/directory.json
 * @param {object} options.mass      { ground, top } in metres, from `massOf`
 * @param {number[]} [options.roof]  [lon, lat, roof_m], from `roofOf`
 * @param {number} options.ms        time since the pin's drop began
 */
export function highlightLayers({ PathLayer, SolidPolygonLayer, LineLayer }, {
  footprint, mass, roof, ms,
}) {
  const shape = shapeFor(footprint, mass, roof);
  if (!shape || !(ms > DROP_MS + WAIT_MS)) return [];

  // Up, held, then away — and nothing at all once it is over, which is the half
  // that matters for cost: this is asked on every frame of a ninety-second orbit
  // and is alive for under two of them.
  const t = ms - DROP_MS - WAIT_MS;
  if (t >= RISE_MS + HOLD_MS + FALL_MS) return [];
  const up = t < RISE_MS
    ? clamp01(t / RISE_MS)
    : 1 - clamp01((t - RISE_MS - HOLD_MS) / FALL_MS);

  const { volume, roofRing, baseRing, posts, lift } = shape;

  // Depth off, so the whole box is visible even where a neighbouring roof stands
  // in front of the far side of it. See the head of this file.
  const parameters = { depthCompare: 'always', depthWriteEnabled: false };

  const outline = (id, data, ink, alpha, width) => new PathLayer({
    id,
    data,
    getPath: (d) => d,
    getColor: [...ink, Math.round(alpha * up)],
    getWidth: width,
    widthUnits: 'pixels',
    widthMinPixels: width,
    jointRounded: true,
    capRounded: true,
    parameters,
    updateTriggers: { getColor: up },
  });

  return [
    // THE VOLUME. Based at the ground ring and extruded to the roof, so the
    // box is the building's own mass rather than a prism starting at sea level
    // — deck.gl adds the elevation to each vertex's own z, which is why the
    // polygons are handed over in three dimensions.
    new SolidPolygonLayer({
      id: 'flyover-highlight-volume',
      data: volume,
      getPolygon: (d) => d,
      getFillColor: [...INK, Math.round(FILL_ALPHA * up)],
      getElevation: lift,
      extruded: true,
      wireframe: false,
      // Unlit, or deck.gl's default material shades the four walls differently
      // and the box reads as a solid object standing in the scene rather than as
      // a mark drawn over it.
      material: false,
      parameters,
      updateTriggers: { getFillColor: up },
    }),
    // The uprights, under the rings so a corner reads as the ring passing over
    // a post rather than the other way round. LineLayer because this is the one
    // part of the box PathLayer cannot draw: its ribbon is built in the ground
    // plane, so a segment with no horizontal extent has no direction to be
    // perpendicular to and renders as nothing at all.
    ...(posts.length ? [
      new LineLayer({
        id: 'flyover-highlight-post-case',
        data: posts,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getColor: [...CASE_INK, Math.round(CASE_ALPHA * up)],
        getWidth: POST_WIDTH + CASE_EXTRA,
        widthUnits: 'pixels',
        widthMinPixels: POST_WIDTH + CASE_EXTRA,
        parameters,
        updateTriggers: { getColor: up },
      }),
      new LineLayer({
        id: 'flyover-highlight-post',
        data: posts,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getColor: [...INK, Math.round(RING_ALPHA * up)],
        getWidth: POST_WIDTH,
        widthUnits: 'pixels',
        widthMinPixels: POST_WIDTH,
        parameters,
        updateTriggers: { getColor: up },
      }),
    ] : []),
    // Casing first, then the white over it. Both are depth-off, so this list
    // order is the only thing deciding which covers which. The base ring is
    // drawn before the roof ring for the same reason: where a building hides its
    // own footing, the top edge is the one to keep.
    outline('flyover-highlight-base-case', baseRing, CASE_INK, CASE_ALPHA, RING_WIDTH + CASE_EXTRA),
    outline('flyover-highlight-base', baseRing, INK, RING_ALPHA, RING_WIDTH),
    outline('flyover-highlight-case', roofRing, CASE_INK, CASE_ALPHA, RING_WIDTH + CASE_EXTRA),
    outline('flyover-highlight', roofRing, INK, RING_ALPHA, RING_WIDTH),
  ];
}
