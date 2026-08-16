// Which things on this map are worth flying around, and how to frame them.
//
// Policy only — no renderer, no network, no DOM. src/flyover-view.js draws the
// thing this file decides on, and the split is deliberate: whether the Gym
// deserves a helicopter shot is a judgment about my campus, and it should be
// reviewable without reading a line of WebGL.
//
// THE HIERARCHY, and the one idea underneath it: a flyover is a camera going
// around something, so the thing has to have a something to go around. That is
// not the same question as "is this important" or "does this have a name" —
// Baseball Field has both and is a rectangle of grass, and orbiting it produces
// thirty seconds of lawn. Three tiers, in order:
//
//   SOLID — a roofed structure with a footprint. The Gym, the Library, the
//           Parking Garage. Mass to orbit, a silhouette that changes as you go
//           around it, and a roof that tells you which building it is from the
//           air. These get the flyover.
//
//   FLAT  — real extent, no mass. The surface car parks, the tennis courts, the
//           stadium, a pool. Google's tiles cover these perfectly well and the
//           orbit is worthless: every frame is the same frame from a different
//           angle, and the photograph you would want of a car park is the one
//           looking straight down, which is what the map already is.
//
//   POINT — an amenity. A defibrillator, a bike rack, an emergency telephone.
//           The finest tile over this campus has about 2 m of detail in it (see
//           the note on MIN_AREA_M2), so a bike rack is between one and two
//           samples wide. There is nothing there to show.
//
// Only SOLID earns one. FLAT and POINT are kept apart rather than folded into a
// single "no" because they are different noes: a car park could be given a
// static overhead shot tomorrow and a defibrillator could not, and a table that
// records why something was refused is the one you can extend.

// An import attribute, which the other JSON imports in this app do not need:
// they are only ever loaded by Vite, and this file is also loaded directly by
// node under test/flyover.test.js, where a bare JSON import is a hard error.
import roofs from './roofs.json' with { type: 'json' };

/** The tiers, ordered so `>=` means "at least this much of a thing". */
export const FLYOVER_TIER = { POINT: 0, FLAT: 1, SOLID: 2 };

/**
 * The default tier for each of the ten discs in src/poi.js.
 *
 * Most of them are unambiguous: a library, a bookstore and a police station are
 * buildings wherever they appear, and nothing else in the file is. Two need
 * more than their class and get it below —
 *
 *   `sport`   matches gyms AND pools, courts and fields, because it is a class
 *             about what happens there rather than what is built there. The
 *             Gym is SOLID and the Tennis Courts are FLAT and both are `sport`.
 *
 *   `parking` is on a surface lot and on the Parking Garage alike — `poiFor`
 *             sends "Parking Garage" here by name, and `withPoiIcons` sends
 *             every `kind: 'parking'` label here whether or not it has one. A
 *             lot and a nine-metre concrete deck are the two ends of this
 *             file's whole question and they arrive wearing the same disc.
 *
 * Neither is resolved here, and this table is not where to try: by the time
 * `tierOf` consults it, both stronger kinds of evidence have already been
 * checked and failed. These are the answers for something known ONLY by its
 * disc, which is why each entry is the safer half of its pair.
 */
const CLASS_TIER = {
  campus: FLYOVER_TIER.SOLID,
  library: FLYOVER_TIER.SOLID,
  arts: FLYOVER_TIER.SOLID,
  food: FLYOVER_TIER.SOLID,
  store: FLYOVER_TIER.SOLID,
  civic: FLYOVER_TIER.SOLID,
  childcare: FLYOVER_TIER.SOLID,
  works: FLYOVER_TIER.SOLID,
  sport: FLYOVER_TIER.SOLID,
  parking: FLYOVER_TIER.FLAT,
};

/**
 * Names that describe ground rather than a building, whatever disc they carry.
 *
 * The last word wins in English here — "Baseball and Softball Field" is a
 * field, "Field House" is a house — so these are anchored to the end of the
 * string rather than matched loose. That is the difference between correctly
 * refusing my campus's Baseball and Softball Field and wrongly refusing a building
 * called the Track and Field Center, which is the sort of name a campus adds
 * without telling its cartographer.
 *
 * `Court` is deliberately absent from the plural-only entries: a Tennis Courts
 * is ground and a Food Court is a room inside a building, and only the singular
 * is ever the second kind.
 */
const GROUND_NAME = /\b(field|fields|courts|stadium|pool|track|lawn|quad|green|lot|yard|garden|grounds)\s*$/i;

/**
 * A structure has to cover at least this much ground to be worth the flight.
 *
 * Not a taste judgment — a resolution one. Google's finest tile over my campus
 * carries a geometric error of 2.01 m, measured by walking the tileset to the
 * campus centroid, so a building is only as detailed as its size in multiples
 * of that. At 150 m2 a footprint is about 12 m across, or six samples: enough
 * to read as a box and not enough to read as a building, and the orbit spends
 * its whole thirty seconds proving there is nothing to see.
 *
 * Set here rather than tuned: it drops nothing my campus actually has. The smallest
 * structure in src/directory.json is Adaptive PE at 173 m2 and the next is
 * College Police at 291, so the floor sits in a gap rather than through a
 * cluster, and moving it anywhere between 100 and 170 changes no outcome.
 */
export const MIN_AREA_M2 = 150;

/**
 * Places whose imagery is wrong, whatever tier they belong to.
 *
 * A separate refusal from the tiers above, and it has to be: these ARE
 * buildings, they DO have mass to orbit, and the shot is still not worth
 * showing. Google's capture over my campus is a fixed date, and where the campus has
 * changed since, the flyover is confidently showing somebody a building that is
 * not there any more. That is worse than showing nothing — a card with no
 * picture reads as "no picture", and a card with the wrong picture reads as the
 * building.
 *
 * Keyed on the name in src/directory.json, which is the same string the card is
 * titled with. Each entry needs the reason beside it, because the fix is to
 * DELETE the entry once Google reflies, and a bare list gives nobody any way to
 * know when that is.
 */
export const STALE_IMAGERY = new Map([
  // Google's tiles catch the CTE mid-build: bare steel, site fencing and a
  // scraped pad where the frontage now is. Recheck after a Google refly.
  ['Career Technical Education (CTE)', 'under construction in Google\'s imagery'],
]);

/**
 * What tier a tapped thing belongs to.
 *
 * Takes the loose shape both callers already have rather than a constructed
 * one: a directory row has `name`/`area_m2`, a pin hit has `kind`/`name`, and
 * neither has to be reshaped at the call site to ask this question.
 *
 * @param {object}  thing
 * @param {string} [thing.name]      printed name, if it has one
 * @param {string} [thing.poi]       the disc class from src/poi.js
 * @param {string} [thing.labelKind] the label's own kind: building/plate/parking/area
 * @param {number} [thing.area_m2]   footprint, for directory rows
 * @returns {number} one of FLYOVER_TIER
 */
export function tierOf({ name, poi, labelKind, area_m2: area } = {}) {
  // Before every other test, because it is not a claim about what the thing is.
  // A building with bad imagery is still a building; it just has no picture
  // worth showing, so it lands where the other "no" cases land.
  if (name && STALE_IMAGERY.has(name.trim())) return FLYOVER_TIER.FLAT;

  // An area name is my campus's own word for a piece of ground — the five of them are
  // BASEBALL FIELD, SOCCER STADIUM, SOFTBALL FIELD, STADIUM and TENNIS COURTS —
  // so this needs no name rule and no class.
  if (labelKind === 'area') return FLYOVER_TIER.FLAT;

  // The name overrides every piece of evidence below it, which is what makes
  // "Baseball and Softball Field" come out right: it is a directory row with a
  // real traced footprint, and it is still a field.
  if (name && GROUND_NAME.test(name.trim())) return FLYOVER_TIER.FLAT;

  // Then, in order of how much the evidence is worth.
  //
  // A FOOTPRINT IN THE DIRECTORY is the strongest thing this map knows, and it
  // is what separates the two hardest cases in the file. The Parking Garage and
  // a surface car park both carry `poi: 'parking'` — `poiFor` sends the garage
  // there by name and `withPoiIcons` sends every car park label there — so the
  // disc cannot tell them apart and neither can any rule written about it. What
  // can is that one of them is 8,629 m2 in src/directory.json and the other is
  // a label on some tarmac. An earlier draft tried to split them on `labelKind`
  // and got the garage wrong, because a card opened from a footprint carries
  // directory properties and no label kind at all.
  if (area != null) {
    return area >= MIN_AREA_M2 ? FLYOVER_TIER.SOLID : FLYOVER_TIER.FLAT;
  }

  // A PRINTED BUILDING NAME is the next best. my campus's cartographer set these on
  // structures — `building` is a name on a footprint and `plate` is a name
  // plate — and neither is ever put on open ground.
  if (labelKind === 'building' || labelKind === 'plate') return FLYOVER_TIER.SOLID;

  // A CLASS is the weakest, and it is all that is left for something tapped
  // with no footprint and no label kind behind it. `parking` is FLAT here for
  // that reason: with nothing else known, a parking disc is a car park.
  //
  // No entry at all is an amenity — everything in amenities.json arrives with
  // its own `kind` and none of those are in CLASS_TIER.
  return CLASS_TIER[poi] ?? FLYOVER_TIER.POINT;
}

/** Whether this thing gets a helicopter shot. The only question most callers ask. */
export const canFlyOver = (thing) => tierOf(thing) >= FLYOVER_TIER.SOLID;

/**
 * Where a building's roof is, as [lon, lat, z] with z in metres above the WGS84
 * ellipsoid — the point the flyover's pin is dropped onto.
 *
 * Measured, not modelled. scripts/build-roofs.mjs reads it off Google's own leaf
 * tiles at 2.01 m geometric error, so the pin lands on the roof the viewer is
 * actually looking at rather than on a height this app believes the roof to be.
 * The two disagree: my campus's ground sits between -5 and -1 m in this datum and the
 * heights in src/directory.json are above local ground, so anything derived
 * would have to guess at the offset per building.
 *
 * Null for a name with no measured roof, which the renderer treats as "no pin"
 * rather than as an error. Only 30 of my campus's rows have one, and a thing that
 * flies without a roof — a footprint with no directory row behind it — is
 * better shown unmarked than marked in the wrong place.
 */
const ROOFS = new Map(roofs.buildings.map((row) => [row.name, row.centre]));
export const roofOf = (name) => (name ? ROOFS.get(name.trim()) ?? null : null);

/**
 * How wide a piece of ground the camera should hold in frame, in metres.
 *
 * SIZED FROM THE FOOTPRINT WHEN THERE IS ONE, and this is the whole of the fix
 * for the clip cutting through buildings. The old version had only `area_m2` to
 * work with and took its square root as the building's width, which is exact
 * for a square and too small for everything else — and my campus's buildings are not
 * squares. The Parking Garage is 118 m by 73 m, so its long half-extent is 59 m
 * against the 46 m that root-of-area implies, and a square built from the
 * smaller number cannot contain it. Nine of the twenty-eight buildings that fly
 * were being sliced this way; see `footprintExtent`, which measures it properly.
 *
 * The area path is kept as the fallback rather than deleted, because `tierOf`
 * will classify a thing that has no footprint at all — a pin with a name and a
 * class — and a camera is still owed for it.
 *
 * `pitch` is the camera's tilt off straight down. 55 degrees is high enough to
 * see roofs — which is how you recognise a building from the air — and low
 * enough that the far side of the orbit is not looking through the near wall.
 *
 * @param {number}  [area]   footprint in m2, for something with no geometry
 * @param {object}  [extent] from `footprintExtent`, when the footprint is known
 */
export function framing(area, extent) {
  // The half-extent the square has to hold. The LONGER of the two axes, because
  // the square is square and the camera goes all the way round: a box that fits
  // the garage across its 73 m width is still cutting it across its 118 m
  // length, and the orbit spends half its time looking down that length.
  const half = extent
    ? Math.max(extent.halfWidth, extent.halfHeight)
    : Math.sqrt(Math.max(area ?? 0, MIN_AREA_M2)) / 2;
  const required = half * BOX_MARGIN;

  // The span follows from the square rather than the other way round, which is
  // the inversion that makes this work. The old order — pick a span from the
  // area, take a fifth of it as the reach — could only ever produce a square
  // proportional to sqrt(area), so no clamp on it could rescue a long building.
  const span = Math.max(MIN_SPAN_M, Math.min(800, required / BOX_REACH));
  return {
    /** Ground width the viewport should span, in metres. */
    span,
    /** Camera tilt off nadir, in degrees. */
    pitch: 55,
    /**
     * Half-width of the box tiles are loaded inside, in metres. See `boxOf`.
     *
     * `required` wins where the span was clamped, so a building bigger than the
     * 800 m ceiling still gets a square that holds it — the frame stops backing
     * off, the perimeter does not stop growing, and what gives is the margin of
     * grid around it rather than the subject. Below the 230 m floor the clamp
     * wins instead, which only makes the square larger than it needed to be.
     */
    reach: Math.max(required, span * BOX_REACH),
  };
}

/**
 * The closest the camera is allowed to get, as a ground width in metres.
 *
 * THE FLOOR IS WHAT MADE SMALL BUILDINGS UNREADABLE, and it was doing it to two
 * thirds of the campus. Everything below it is framed at whatever the floor
 * says rather than at the 25% of frame the arithmetic promises, so at 230 m
 * Operations — 16 m across — was 6.8% of the picture: a shed, in an aerial shot
 * of four other buildings. Twenty-one of the thirty that fly were clamped, from
 * 6.8% up to 23.9%, and only nine got the framing that was designed.
 *
 * 130 is not a taste. It is where Google's imagery stops having anything more to
 * show, so it is the point past which moving the camera closer magnifies rather
 * than reveals. The finest tiles over my campus carry a geometric error of 2.01 m; the
 * viewport is about 320 CSS px wide and drawn at 2x, so the span lands on 640
 * device pixels and a 130 m span puts 0.20 m on a pixel — which is 2.01 m across
 * ten of them. Below that the leaves are being enlarged past their own detail
 * and the roof turns to soft blobs, which is a worse answer than a small
 * building, because a small building is at least sharp.
 *
 * It has a second effect worth knowing about: at 0.20 m per pixel the 2.01 m
 * leaves project to ~10 px against SCREEN_SPACE_ERROR's 8, so a small building
 * now reaches the FINEST level where at 230 m it stopped at the second finest.
 * More tiles per building, but over a box that shrank with the span — `reach` is
 * a fifth of it — so the ground loaded goes down, not up.
 */
export const MIN_SPAN_M = 130;

/**
 * The perimeter's half-width, as a multiple of the framed span.
 *
 * THIS HAS TO BE SMALLER THAN THE FRAME OR THERE IS NOTHING TO SEE, which is
 * the mistake the previous value made. At 0.55 the perimeter is 1.1 spans
 * across — WIDER than the viewport — so it clipped nothing but a sliver at the
 * top edge, and the honest description of that is "a perimeter that does not
 * appear to work". A boundary you cannot see is indistinguishable from one that
 * is not there.
 *
 * 0.24 puts the square at 0.48 spans, so the grid still surrounds it and the
 * building is about a third of the frame. IT IS THE DIAGONAL THAT HAS TO FIT,
 * which is what makes the ceiling lower than it looks: the camera goes all the
 * way round, so for half of every orbit a CORNER of the square is pointing at
 * it, and the width to accommodate is 1.41 spans of side. 0.48 puts that
 * diagonal at 0.68 of the frame. Photographed at 0.28 — a 0.56 square, a 0.79
 * diagonal — the perimeter ran off the left and right edges of the Parking
 * Garage's shot at most bearings and stopped being a boundary at all.
 *
 * IT WAS 0.2, WHICH IS NOT WHAT THIS COMMENT SAID, and the prose was right where
 * the number was not: at 0.2 the square is 0.4 spans and sits in the middle of
 * the picture with a wide skirt of empty grid all round it, which reads as a
 * model on a turntable — the exact thing described above as the failure.
 * Measured over a full orbit of the Parking Garage, the share of the box that
 * was bare grid went from 31.5% at 0.2 to 20.6% here: a third less margin, and
 * still a fifth of the picture, which is what keeps the boundary a boundary.
 *
 * WHAT IT DOES NOT CHANGE is how much ground is inside the square. `reach` is
 * `required` for any building the span is not clamped for, and `required` is a
 * function of the footprint and BOX_MARGIN alone — so raising this pulls the
 * CAMERA in rather than pushing the boundary out. Same square, less frame around
 * it: 0.4 of the width to 0.56, and the building from a quarter of the frame to
 * about a third. Where the span IS clamped, at the MIN_SPAN_M floor, the square
 * does grow — a small building gets 73 m of ground across instead of 52.
 *
 * The far plane follows from this too and gets tighter with it, so a smaller
 * span is also less loaded: see `farPlaneFor` in src/flyover-view.js. Nothing
 * here is scale-dependent — every term is a multiple of the span — so one value
 * holds from Adaptive PE at 173 m2 to the Parking Garage at 8,629.
 */
const BOX_REACH = 0.24;

/**
 * How much ground the square holds around the building, in half-extents.
 *
 * NOT A NEW NUMBER — it is the one the old arithmetic already produced, pulled
 * out where it can be read. The span was `sqrt(area) * 4` and the reach a fifth
 * of that, so the square came out at `sqrt(area) * 1.6`: 1.6 half-extents of
 * ground on every side of a square building. Naming it is what lets the same
 * framing be built from a measured footprint instead of a guessed one, and
 * keeping it identical is deliberate — everything downstream was tuned at this
 * framing, including SCREEN_SPACE_ERROR in src/flyover-view.js, which is
 * derived from how many metres of ground land on a pixel.
 *
 * What it buys, which is why the camera sits as far back as it does: the square
 * has to close on all four sides of the frame or it reads as a crop rather than
 * a boundary. The camera is tilted 55 degrees off nadir, so the bottom of the
 * picture is the NEAREST ground and only a fraction of a span in front of the
 * target — a square sized to contain the building runs off that bottom edge
 * before it closes. Backing off to four building-widths is what opens the gap,
 * and it costs apparent size: the building is a quarter of the frame rather
 * than the two fifths it would be. That is the right way round for a shot meant
 * to answer "what is around this building".
 */
const BOX_MARGIN = 1.6;

/**
 * Metres per degree at my campus's latitude.
 *
 * Fixed rather than computed per call. The campus is 1 km across and this is
 * only ever used to size a box a few hundred metres wide, so the error from
 * treating the latitude as constant is centimetres — and a box is a budget, not
 * a survey.
 */
export const M_PER_DEG_LAT = 111_132;
export const M_PER_DEG_LON = 86_900; // 111_320 * cos(38.65 degrees)

/**
 * Where a footprint's middle actually is, and how far it reaches from there.
 *
 * Two numbers the rest of this file used to have to guess, and it guessed both
 * wrong in the same direction on the same building.
 *
 * THE SIZE. `area_m2` is one number and a footprint has two dimensions, so
 * every square built from an area is a claim that the building is square. The
 * Parking Garage is 118 m by 73 m and the claim is out by 13 m on the long
 * axis, which is 13 m of concrete deck outside the clip and therefore not
 * drawn. See `framing`.
 *
 * THE CENTRE, which was the larger error of the two and the less obvious.
 * Cards are opened at `anchor`, the pole of inaccessibility — the point
 * furthest inside the footprint. That is the correct place to hang a label and
 * the wrong place to centre a square: it is a point of maximum clearance, not a
 * middle, and on the garage it sits 22 m west of the bounding box's centre. A
 * square perfectly sized to hold the building still cut the east end off it.
 *
 * The bounding box rather than a true centroid, because the bounding box is
 * what has to be contained. They differ on an L-shaped block — the bbox centre
 * can fall in the courtyard — and for framing that is the answer wanted anyway:
 * the camera should be pointed at the middle of the thing's EXTENT, which is
 * what fills the picture, rather than at the middle of its mass.
 *
 * @param {object} [geometry] GeoJSON Polygon or MultiPolygon
 * @returns {{ centre: number[], halfWidth: number, halfHeight: number } | null}
 */
export function footprintExtent(geometry) {
  let west = Infinity; let south = Infinity;
  let east = -Infinity; let north = -Infinity;

  // Depth-agnostic, because the directory holds both Polygon and MultiPolygon
  // and a building whose parts were folded together is exactly the case that
  // needs its real extent. A position is the first array whose head is a
  // number, which is true at every nesting level any of them use.
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number') {
      const [lon, lat] = node;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry?.coordinates);

  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  return {
    centre: [(west + east) / 2, (south + north) / 2],
    halfWidth: ((east - west) / 2) * M_PER_DEG_LON,
    halfHeight: ((north - south) / 2) * M_PER_DEG_LAT,
  };
}

/**
 * How far the box reaches below and above the campus, in metres.
 *
 * MEASURED against the live tileset over the Parking Garage, by walking every
 * tile whose footprint covers it and reading back the ellipsoidal height band
 * of each. The answer is that the real geometry here is thin:
 *
 *     finest (4.01 m)   -6.4 ..  +13.8 m      60 m footprint
 *     8.03 m            -8.8 ..  +13.8
 *     16.05 m          -10.7 ..  +30.5
 *     64.20 m          -24.4 ..  +36.9
 *
 * my campus sits near ZERO metres ellipsoidal, which is the fact that makes these
 * numbers look wrong until you know it: the campus is about 30 m above sea
 * level and the geoid over Sacramento is about -32 m below the ellipsoid, so
 * the two nearly cancel. (Verified independently — probing the tileset at h=0
 * reaches the 2.01 m leaves, and probing at h=30 stops at 32 m.)
 *
 * -50 and +60 therefore clear every tile Google actually serves here by a wide
 * margin, while still being a bound. They are set from the measurement rather
 * than from the building, because a wall of numbers this asymmetric is exactly
 * where a plausible guess goes wrong: 0 to `height` would have cut the ground
 * the building stands on.
 */
const BOX_FLOOR_M = -50;
const BOX_CEIL_M = 60;

/**
 * The most a tile may exceed the box and still count as inside it.
 *
 * A vertical bound alone cuts almost nothing, and it is worth being clear about
 * why rather than shipping a box that reads as thorough and does nothing. Every
 * ancestor of a tile over my campus necessarily CONTAINS my campus — that is what makes it
 * an ancestor — so an overlap test can never reject one, however tall it is.
 * Of the eighteen tiles covering the Parking Garage, an overlap test against
 * the band above rejects exactly one: the depth-2 slab that starts 742 km up.
 *
 * The tiles worth rejecting are the ones that are mostly NOT the building: a
 * 30 km slab covering half of California, drawn at four pixels of detail, which
 * exists only to be replaced. A tile more than four box-widths across is that,
 * and rejecting it is a faithful reading of "stop at the box" rather than a
 * separate heuristic — a volume that is 99% outside the box is outside it.
 *
 * Refinement is unaffected. This is applied to what gets DRAWN, and the
 * traversal keeps descending through these tiles to reach their children.
 */
const BOX_MAX_TILE_RATIO = 4;

/**
 * The volume tiles are allowed inside, for one place.
 *
 * A box in three dimensions, which the first version of this was not: it
 * returned two corners of a lon/lat rectangle, and since a tile carries a
 * height range too, testing only the horizontal pair made it a column of
 * infinite height rather than a box. Over a tileset whose coarse levels are
 * kilometres tall that is not a small distinction.
 *
 * Used for both costs — see src/flyover-view.js. Loading is clamped by
 * shrinking the camera's far plane to the box, which is the only thing that
 * stops the traversal ever asking for what is outside it; drawing is clamped by
 * dropping selected tiles that fall outside, which is exact where a far plane
 * is only a plane. Whatever the box excludes shows the grid placeholder.
 *
 * @param {number[]} centre [lon, lat]
 * @param {number}   reach  half-width in metres, from `framing`
 * @returns {{ min: number[], max: number[], span: number }} lon/lat/metres
 */
export function boxOf([lon, lat], reach) {
  const dLon = reach / M_PER_DEG_LON;
  const dLat = reach / M_PER_DEG_LAT;
  return {
    min: [lon - dLon, lat - dLat, BOX_FLOOR_M],
    max: [lon + dLon, lat + dLat, BOX_CEIL_M],
    /** Width on the ground in metres, for the size test. */
    span: reach * 2,
    /** How many box-widths a tile may span before it counts as outside. */
    maxTileSpan: reach * 2 * BOX_MAX_TILE_RATIO,
  };
}
