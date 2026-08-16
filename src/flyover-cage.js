// The highlight: the tapped building's own outline and a wash over its roof.
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
// HELD, NOT SWEPT, and that is a change from what this module used to be. It
// drew a grid — six levels, verticals every twelve metres — and lit a band of it
// travelling across the building on a 35 degree bearing, a survey pass that said
// its piece in under two seconds and gave the picture back. It read as an
// effect. What a viewer wants from a card that has just opened is to know which
// building they are looking at for as long as they are looking at it, and a mark
// that erases itself answers that only for the two seconds nobody was ready for.
// So the mesh is gone and what is left is the two marks that say "this one":
// the outline, and a wash inside it.
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
 * Then it fades up and STAYS. There is no end: the building is the subject of
 * the card for as long as the card is open, and the orbit is ninety seconds of
 * looking at it. The fade is short enough not to be an event of its own and long
 * enough that the mark does not pop.
 */
const WAIT_MS = 140;
const RISE_MS = 320;
/** When the highlight is fully up. Nothing happens to it after this. */
export const HIGHLIGHT_MS = WAIT_MS + RISE_MS;

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
 * THE WASH IS WEAK ON PURPOSE, and 12% is about where it stops being a tint and
 * starts being paint. It is not there to be seen for itself — the outline
 * already says where the building is — it is there so the inside of the outline
 * reads as the subject rather than as an empty ring lying on a roof. Push it
 * much past this and it stops being photographic imagery underneath.
 */
const INK = [255, 255, 255];
const CASE_INK = [24, 24, 27];
const RING_ALPHA = 235;
const CASE_ALPHA = 130;
const RING_WIDTH = 1.6;
const CASE_EXTRA = 2.2;
const FILL_ALPHA = 31;

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
 * The highlight, as three layers, or nothing at all before it is due.
 *
 * @param {object} tools             the deck.gl toolkit
 * @param {object} options
 * @param {object} options.footprint GeoJSON geometry from src/directory.json
 * @param {object} options.mass      { ground, top } in metres, from `massOf`
 * @param {number[]} [options.roof]  [lon, lat, roof_m], from `roofOf`
 * @param {number} options.ms        time since the pin's drop began
 */
export function highlightLayers({ PathLayer, SolidPolygonLayer }, {
  footprint, mass, roof, ms,
}) {
  const polygons = polygonsOf(footprint);
  if (!polygons.length || !mass || !(ms > DROP_MS + WAIT_MS)) return [];

  const { ground, top } = mass;
  if (!(top - ground > 0)) return [];

  // THE ROOF PLANE, not the peak. `mass.top` is the highest point the building
  // reaches and roofs.json's centre is the roof it actually has — an area
  // weighted level rather than whatever aerial or parapet won. A ring hung at
  // the peak floats over most roofs; a ring at the roof lies on it. The peak is
  // the fallback for anything with no measured centre, which is nothing on this
  // campus but is a better answer than no highlight.
  const z = Number.isFinite(roof?.[2]) ? roof[2] : top;

  const up = clamp01((ms - DROP_MS - WAIT_MS) / RISE_MS);
  const at = (p) => [p[0], p[1], z];

  // Depth off, so the whole outline is visible even where a neighbouring roof
  // stands in front of the far side of it. See the head of this file.
  const parameters = { depthCompare: 'always', depthWriteEnabled: false };

  const rings = polygons.map((polygon) => polygon[0].map(at));
  const outline = (id, ink, alpha, width) => new PathLayer({
    id,
    data: rings,
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
    new SolidPolygonLayer({
      id: 'flyover-highlight-fill',
      data: polygons.map((polygon) => polygon.map((ring) => ring.map(at))),
      getPolygon: (d) => d,
      getFillColor: [...INK, Math.round(FILL_ALPHA * up)],
      extruded: false,
      parameters,
      updateTriggers: { getFillColor: up },
    }),
    // Casing first, then the white over it. Both are depth-off, so this list
    // order is the only thing deciding which covers which.
    outline('flyover-highlight-case', CASE_INK, CASE_ALPHA, RING_WIDTH + CASE_EXTRA),
    outline('flyover-highlight', INK, RING_ALPHA, RING_WIDTH),
  ];
}
