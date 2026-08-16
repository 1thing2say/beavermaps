// The survey: the tapped building's own outline, scanned once and then gone.
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
// buildings and src/roofs.json holds a measured ground and peak for each.
//
// A SCAN RATHER THAN AN ANNOTATION, and that is the decision that shapes
// everything below. A permanent cage is a second object in the shot forever: it
// competes with the building it is describing, it survives long past the moment
// anyone needed it, and every metre its data disagrees with Google's mesh is a
// metre somebody has time to notice. A band that rises through the building once
// and leaves says the same thing in under two seconds and gives the picture back.
//
// It passes THROUGH the surface — the whole thing is drawn with the depth test
// off — because a scan that stopped at the near wall would be a sticker on it.
// What this is imitating is a survey pass, and a survey pass goes through.
//
// LINES RATHER THAN AN EXTRUDED POLYGON, and that is legibility rather than
// style. deck.gl draws SolidPolygonLayer's `wireframe` with GL_LINES, whose
// width is capped at one device pixel by essentially every driver — a hairline,
// over photographic imagery, which is the one background that eats hairlines.
// LineLayer takes a width in screen pixels and honours it, and it is also the
// only one of the two that can draw a VERTICAL: PathLayer builds its ribbon in
// the ground plane, so a segment with no horizontal extent has no direction to
// be perpendicular to and renders as nothing at all.

import { DROP_MS } from './flyover-pin.js';

/**
 * When the scan runs, all measured from the pin's landing.
 *
 * It waits for the squash rather than starting with it: the landing already
 * carries a compression, a trail emptying and a shadow tightening, and a second
 * event inside that is one too many to read. A seventh of a second later the pin
 * has settled and the scan has the frame to itself.
 *
 * The sweep is the whole of the visible life. There is no phase where the entire
 * cage is up — see BAND — so the fade is a tail on the band as it tops out
 * rather than a curtain over a finished drawing, and past CAGE_MS there is
 * nothing left to draw and nothing costing a layer.
 */
const WAIT_MS = 140;
const SWEEP_MS = 1200;
const FADE_MS = 380;
export const CAGE_MS = WAIT_MS + SWEEP_MS + FADE_MS;

/**
 * The grid: how many levels it has, how far apart its verticals are on the
 * ground in metres, and how wide the sweep's band is as a share of the crossing.
 *
 * A GRID, not a stack of rings, and the difference is what it says. Contours
 * alone describe a height; a mesh describes a SURFACE, which is the thing that
 * is actually ambiguous when two roofs meet in the picture with no line between
 * them. So the verticals are spaced along the perimeter rather than saved for
 * corners, and the two families together make cells.
 *
 * BIG CELLS. This started at fifteen levels and read as a barcode: at a
 * nineteen-metre building that is a line every metre and a quarter, which is
 * finer than the wall detail underneath it and disappears into it. Six levels
 * and a vertical every twelve metres puts three or four cells across a face,
 * which is a mesh you can see the shape of.
 *
 * The band is a share of the CROSSING — the building's own width along the
 * sweep — so it is the same fraction of a small building as of a large one.
 * 0.12 lights about 45% of the mesh at its widest, and the reason that is not a
 * quarter is structural rather than a bad number: the level lines follow the
 * footprint, so a band crossing it meets the two sides FACING it whatever its
 * width, and halving the band from 0.22 to 0.10 only moved the count from 237
 * lines to 136. What the width actually controls is how much of that is BRIGHT,
 * and the falloff is triangular, so the fifth of the mesh at the band's middle
 * carries nearly all of the ink.
 */
const LEVELS = 6;
const VERTICAL_GAP_M = 12;
const BAND = 0.12;


/**
 * Which way the sweep travels, as a compass bearing.
 *
 * ACROSS, NOT UP. Rising through a building is the obvious reading of "scan" and
 * it is the wrong one here: the camera is 68 degrees off nadir, so vertical
 * motion is the axis the projection compresses hardest, and a band that climbs
 * moves a few pixels while a band that crosses moves the width of the frame. The
 * one that can be seen is the one that goes sideways.
 *
 * 35 degrees rather than 0 or 90 so it crosses the building's own walls at an
 * angle instead of running along one of them — a sweep parallel to a facade
 * lights that whole facade at once and states nothing about depth. It is a
 * bearing in the WORLD, so the orbit turns it with everything else rather than
 * dragging it around with the camera.
 */
const SWEEP_DEG = 35;

/**
 * White, and how strong each part gets at the centre of the band.
 *
 * THE CASING IS NOT A STYLE CHOICE. Photographed on the Library — pale concrete,
 * white glazing, gravel roof — a white line at 210 alpha was very nearly
 * invisible, because the one background white cannot be drawn on is white. Every
 * line is therefore drawn twice: a wider dark one first and the white one over
 * it, which is the same thing the label does with a grey border and the same
 * thing a map does with every road casing ever drawn.
 *
 * The casing is 2.2 px wider, so about a pixel of it shows on each side. Wider
 * and it is a dark line with a white core; this is a white line that survives.
 */
const INK = [255, 255, 255];
const CASE_INK = [24, 24, 27];
const RING_ALPHA = 235;
const CASE_ALPHA = 130;
const RING_WIDTH = 1.6;
const CASE_EXTRA = 2.2;

/**
 * Metres per degree at my campus, for the corner spacing.
 *
 * Restated rather than imported, and only here: src/flyover.js exports both, but
 * importing them would make this module depend on the policy file to measure the
 * gap between two of its own vertices. The error from treating the latitude as
 * constant over one building is millimetres.
 */
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 86_900;

const rad = Math.PI / 180;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Every ring of a footprint, whatever GeoJSON shape it arrived in.
 *
 * my campus's directory is all MultiPolygon and a third of the buildings have more
 * than one part — nine for the Student Center — so this cannot assume a single
 * outline. Holes are dropped: a courtyard is a real feature of a footprint and
 * an outline of one, scanned at height around nothing, reads as a second
 * building rather than as a hole in the first.
 */
function ringsOf(geometry) {
  if (!geometry) return [];
  const polygons = geometry.type === 'MultiPolygon'
    ? geometry.coordinates
    : geometry.type === 'Polygon' ? [geometry.coordinates] : [];
  return polygons.map((polygon) => polygon[0]).filter((ring) => ring?.length > 3);
}


/**
 * The scan, as two layers, or nothing at all once it is over.
 *
 * Nothing at all is the important half: this is called on every frame of a
 * ninety-second orbit and is alive for under two seconds of it, so outside that
 * window it has to cost no layers rather than two empty ones.
 *
 * @param {object} tools             the deck.gl toolkit, for LineLayer
 * @param {object} options
 * @param {object} options.footprint GeoJSON geometry from src/directory.json
 * @param {object} options.mass      { ground, top } in metres, from `massOf`
 * @param {number} options.ms        time since the pin's drop began
 */
export function cageLayers({ LineLayer }, { footprint, mass, ms }) {
  const rings = ringsOf(footprint);
  if (!rings.length || !mass || !(ms > DROP_MS + WAIT_MS)) return [];

  const t = ms - DROP_MS - WAIT_MS;
  if (t >= SWEEP_MS + FADE_MS) return [];

  const { ground, top } = mass;
  const height = top - ground;
  if (!(height > 0)) return [];

  // Every piece of the mesh, as a segment with a midpoint. Segments rather than
  // paths because the sweep lights PART of a ring — a band crossing a building
  // cuts every contour it meets — and a path is lit or not as a whole.
  const segs = [];
  const at = (p, z) => [p[0], p[1], z];
  for (const ring of rings) {
    const levels = [];
    for (let i = 0; i <= LEVELS; i += 1) levels.push(ground + (height * i) / LEVELS);

    let walked = 0;
    let nextPost = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i];
      const b = ring[i + 1];
      for (const z of levels) segs.push({ from: at(a, z), to: at(b, z) });

      // The verticals, spaced by DISTANCE along the perimeter rather than by
      // vertex, so a wall traced with forty points and one traced with four get
      // the same mesh. Split at every level so each cell edge lights on its own.
      const east = (b[0] - a[0]) * M_PER_DEG_LON;
      const north = (b[1] - a[1]) * M_PER_DEG_LAT;
      const run = Math.hypot(east, north);
      while (run > 0 && nextPost <= walked + run) {
        const f = (nextPost - walked) / run;
        const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        for (let i2 = 0; i2 < LEVELS; i2 += 1) {
          segs.push({ from: at(p, levels[i2]), to: at(p, levels[i2 + 1]) });
        }
        nextPost += VERTICAL_GAP_M;
      }
      walked += run;
    }
  }
  if (!segs.length) return [];

  // WHERE EACH SEGMENT SITS ALONG THE SWEEP, in metres, measured from wherever
  // the mesh starts. One dot product per segment against the sweep's bearing —
  // the same arithmetic a plane sweeping across the building would do, which is
  // what this is.
  const toward = SWEEP_DEG * rad;
  const axis = (s2) => {
    const lon = (s2.from[0] + s2.to[0]) / 2;
    const lat = (s2.from[1] + s2.to[1]) / 2;
    return lon * M_PER_DEG_LON * Math.sin(toward) + lat * M_PER_DEG_LAT * Math.cos(toward);
  };
  let lo = Infinity;
  let hi = -Infinity;
  for (const seg of segs) {
    seg.u = axis(seg);
    lo = Math.min(lo, seg.u);
    hi = Math.max(hi, seg.u);
  }
  const cross = Math.max(1, hi - lo);
  const reach = BAND * cross;
  // From before the first segment to past the last, so the mesh arrives rather
  // than being already half lit at the opening frame.
  const centre = lo - reach + (cross + 2 * reach) * clamp01(t / SWEEP_MS);
  const tail = 1 - clamp01((t - SWEEP_MS) / FADE_MS);

  const lit = [];
  for (const seg of segs) {
    // Triangular, so a cell edge is brightest as the band's middle crosses it
    // and out by the time the edge has passed. A step would switch a whole
    // column on at once.
    const on = tail * Math.max(0, 1 - Math.abs(seg.u - centre) / reach);
    // Culled at 6% rather than at zero: a white line at 14 of 235 alpha is
    // invisible and still costs a vertex pair, and there are hundreds of them
    // out at the edges of a triangular falloff.
    if (on > 0.06) lit.push({ from: seg.from, to: seg.to, on });
  }
  if (!lit.length) return [];

  // THROUGH the surface: the depth test is off so the band crosses the building
  // rather than stopping at the wall nearest the camera. A survey pass goes
  // through, and the far half of the mesh is the half that says which mass this
  // is when a neighbour is standing in front of it.
  const parameters = { depthCompare: 'always', depthWriteEnabled: false };
  const pass = (id, ink, alpha, width) => new LineLayer({
    id,
    data: lit,
    getSourcePosition: (d) => d.from,
    getTargetPosition: (d) => d.to,
    getColor: (d) => [...ink, Math.round(alpha * d.on)],
    getWidth: width,
    widthUnits: 'pixels',
    widthMinPixels: width,
    parameters,
    updateTriggers: { getSourcePosition: t, getTargetPosition: t, getColor: t },
  });

  // Casing first, then the white over it. Both are depth-off, so this list order
  // is the only thing deciding which covers which.
  return [
    pass('flyover-cage-case', CASE_INK, CASE_ALPHA, RING_WIDTH + CASE_EXTRA),
    pass('flyover-cage', INK, RING_ALPHA, RING_WIDTH),
  ];
}
