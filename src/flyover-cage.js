// The wireframe cage: the tapped building's own outline, standing in the shot.
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
// buildings and src/roofs.json holds a measured ground and roof for each. The
// cage lands on the same two planes the imagery does because both numbers were
// read off that imagery.
//
// PATHS RATHER THAN AN EXTRUDED POLYGON, and that is a legibility decision
// rather than a stylistic one. deck.gl draws SolidPolygonLayer's `wireframe`
// with GL_LINES, whose width is capped at one device pixel by essentially every
// driver — a hairline, over photographic imagery, which is the one background
// that eats hairlines. PathLayer takes a width in pixels and honours it.

/**
 * How sharp a turn has to be for a vertex to count as a corner, in degrees.
 *
 * The uprights go on corners rather than on vertices, because a traced footprint
 * is not a drawing of a box: my campus's are 33 points around the Library and up to
 * two hundred around the Student Center, most of them describing a curve or a
 * jog of half a metre. An upright on every one is a picket fence, and a picket
 * fence around a building is not an outline of it.
 *
 * 28 degrees keeps the corners of a rectangle and every real re-entrant, and
 * drops the run of small turns that make up a curved wall.
 *
 * IT IS NOT ENOUGH ON ITS OWN, which the Gym proved: 34 of its 35 vertices turn
 * further than that, because its traced outline is jagged at the metre scale
 * rather than curved. An angle test cannot tell a jagged wall from a corner —
 * both turn sharply — so a spacing rule decides between them. Six metres is
 * about the narrowest a real bay gets on this campus and far wider than the
 * wobble in a trace.
 */
const CORNER_DEG = 28;
const CORNER_GAP_M = 6;

/**
 * How the two passes are drawn: width in pixels, and how strong each is.
 *
 * TWO PASSES, and the second is the one that does the work this was asked for.
 * The solid pass is depth-tested, so the far edges go behind the building and
 * the cage reads as a box the building is standing in. That is correct and it is
 * not sufficient: the case this exists for is a NEIGHBOUR standing in front,
 * and a depth-tested cage is hidden by that neighbour exactly where the
 * ambiguity is.
 *
 * So the same lines are drawn again underneath with the depth test off, faint.
 * What shows through is only the part that failed the first pass — the hidden
 * edges — so the result is a solid outline with an x-ray of what is behind
 * whatever is in front of it. It is the same trick the pin's motion trail uses:
 * one shape, drawn twice, the second saying what the first had to leave out.
 */
const SOLID = { width: 2.0, alpha: 235 };
const XRAY = { width: 1.5, alpha: 70 };

/**
 * Metres per degree at my campus, for the corner spacing.
 *
 * Restated rather than imported, and only here: src/flyover.js exports both, but
 * importing them would make this module depend on the policy file to measure a
 * gap between two of its own vertices. The error from treating the latitude as
 * constant over one building is millimetres.
 */
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 86_900;

/** The roof line is the one that answers the question; the base only grounds it. */
const BASE_ALPHA = 0.55;

const rad = Math.PI / 180;

/**
 * Every ring of a footprint, whatever GeoJSON shape it arrived in.
 *
 * my campus's directory is all MultiPolygon and a third of the buildings have more
 * than one part — nine for the Student Center — so this cannot assume a single
 * outline. Holes are dropped: a courtyard is a real feature of a footprint and
 * an outline of one, drawn at roof height around nothing, reads as a second
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
 * The vertices of a ring where it actually turns a corner.
 *
 * Wrapped rather than clamped at the ends, because the first point of a closed
 * ring is a corner as often as any other and reading it as an endpoint puts an
 * upright in the middle of a wall.
 */
function cornersOf(ring) {
  // A closed ring repeats its first point last; the repeat is not a vertex.
  const pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring;
  if (pts.length < 3) return pts;

  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const here = pts[i];
    const next = pts[(i + 1) % pts.length];
    const into = Math.atan2(here[1] - prev[1], here[0] - prev[0]);
    const away = Math.atan2(next[1] - here[1], next[0] - here[0]);
    let turn = Math.abs(away - into);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn <= CORNER_DEG * rad) continue;
    // Far enough from the last upright to be a different corner rather than the
    // same one drawn twice by a jagged trace. Checked against what was KEPT, so
    // a run of ten sharp vertices along one wall yields one upright and not ten.
    const last = out[out.length - 1];
    if (last) {
      const east = (here[0] - last[0]) * M_PER_DEG_LON;
      const north = (here[1] - last[1]) * M_PER_DEG_LAT;
      if (Math.hypot(east, north) < CORNER_GAP_M) continue;
    }
    out.push(here);
  }
  return out;
}

/**
 * The cage, as two layers: the x-ray underneath and the solid outline over it.
 *
 * Returned in draw order rather than sorted, for the same reason the pin's
 * samples are: deck.gl draws a list in the order it is given, and with the depth
 * test off on the first of these there is nothing else deciding.
 *
 * @param {object}   tools            the deck.gl toolkit, for PathLayer and LineLayer
 * @param {object}   options
 * @param {object}   options.footprint GeoJSON geometry from src/directory.json
 * @param {object}   options.mass      { ground, roof } in metres, from `massOf`
 * @param {number[]} options.colour    [r, g, b], the pin's own
 */
export function cageLayers({ PathLayer, LineLayer }, { footprint, mass, colour }) {
  const rings = ringsOf(footprint);
  if (!rings.length || !mass) return [];

  const { ground, roof } = mass;
  const paths = [];
  // THE UPRIGHTS ARE NOT PATHS, and finding out why cost a render. PathLayer
  // builds a ribbon in the GROUND plane — it is a map primitive, and its width
  // runs perpendicular to a horizontal direction — so a segment with no
  // horizontal extent has no direction to be perpendicular to and draws
  // nothing at all. LineLayer is the 3D one: two positions, a width in screen
  // pixels, and no opinion about which way is up.
  const posts = [];
  for (const ring of rings) {
    // The roof line first and the base second, so a caller reading `data` order
    // sees the same priority the alphas state.
    paths.push({ path: ring.map(([lon, lat]) => [lon, lat, roof]), lift: 1 });
    paths.push({ path: ring.map(([lon, lat]) => [lon, lat, ground]), lift: BASE_ALPHA });
    for (const [lon, lat] of cornersOf(ring)) {
      posts.push({ from: [lon, lat, ground], to: [lon, lat, roof] });
    }
  }

  const layer = (id, { width, alpha }, depth) => new PathLayer({
    id,
    data: paths,
    getPath: (d) => d.path,
    getColor: (d) => [...colour, Math.round(alpha * d.lift)],
    getWidth: width,
    widthUnits: 'pixels',
    // A cage that thins to nothing at a distance stops being an outline. The
    // minimum is what holds it together where the building is small in frame.
    widthMinPixels: width,
    jointRounded: true,
    capRounded: true,
    parameters: depth
      ? { depthCompare: 'less-equal', depthWriteEnabled: false }
      : { depthCompare: 'always', depthWriteEnabled: false },
  });

  const uprights = (id, { width, alpha }, depth) => new LineLayer({
    id,
    data: posts,
    getSourcePosition: (d) => d.from,
    getTargetPosition: (d) => d.to,
    getColor: [...colour, Math.round(alpha * BASE_ALPHA)],
    getWidth: width,
    widthUnits: 'pixels',
    widthMinPixels: width,
    parameters: depth
      ? { depthCompare: 'less-equal', depthWriteEnabled: false }
      : { depthCompare: 'always', depthWriteEnabled: false },
  });

  // The x-ray is for the RINGS only. Photographed with the uprights in it too,
  // the ones on a re-entrant corner came through the roof as a row of verticals
  // standing in the middle of it — hidden geometry faithfully shown and read as
  // clutter, because an upright says nothing on its own. The roof line is what
  // has to survive a neighbour standing in front; a post that goes with the
  // corner it is hidden behind has lost nothing.
  return [
    layer('flyover-cage-xray', XRAY, false),
    layer('flyover-cage', SOLID, true),
    uprights('flyover-cage-posts', SOLID, true),
  ];
}
