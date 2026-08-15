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
 * How wide a piece of ground the camera should hold in frame, in metres.
 *
 * A footprint's area is the only size this map records — there is no bounding
 * box in src/directory.json — so the width is taken as its square root, which
 * is exact for a square and low for a long thin one. Low is the safe direction:
 * it pulls the camera in, and a building that slightly overfills the frame is a
 * better shot than one sitting small in the middle of a car park.
 *
 * 2.6x that width, clamped at both ends. The multiple leaves the building
 * across roughly two fifths of the frame with its own ground around it, which
 * is what makes the shot read as a place rather than as an object on a
 * turntable. The clamps matter more than the multiple: the Parking Garage and
 * Adaptive PE are a factor of fifty apart in area and seven in width, and
 * without a floor the small ones get orbited from so close that the camera
 * sweeps faster than the tiles can stream.
 *
 * `pitch` is the camera's tilt off straight down. 55 degrees is high enough to
 * see roofs — which is how you recognise a building from the air — and low
 * enough that the far side of the orbit is not looking through the near wall.
 *
 * @param {number} [area] footprint in m2
 */
export function framing(area) {
  const width = Math.sqrt(Math.max(area ?? 0, MIN_AREA_M2));
  const span = Math.max(150, Math.min(520, width * 2.6));
  return {
    /** Ground width the viewport should span, in metres. */
    span,
    /** Camera tilt off nadir, in degrees. */
    pitch: 55,
    /** Half-width of the box tiles are loaded inside, in metres. See `boxOf`. */
    reach: span * BOX_REACH,
  };
}

/**
 * The box's half-width, as a multiple of the framed span.
 *
 * MEASURED, and the first value was wrong in an instructive way. The obvious
 * choice is something generous — 1.5x the span, so the box comfortably contains
 * everything a tilted camera might look at. Computing where deck.gl's own far
 * plane already lands showed that box would never once have been consulted: at
 * 55 degrees of pitch the default frustum stops about 0.6 spans past the target
 * on the ground, so any box wider than that is decoration with a comment on it.
 *
 * The crossover is at 0.62 and is scale-free — every term scales with the span,
 * so it is the same multiple for Adaptive PE and for the Parking Garage. 0.55
 * therefore bites at every size, and what it cuts is the band of ground near
 * the top of the frame that the camera looks past the building at. That ground
 * is the most expensive thing in the shot and the least looked at: it is
 * furthest away, it is nobody's answer to "which building is this", and at 1.1
 * spans wide the box still holds the whole footprint with room around it.
 *
 * Below about 0.4 the box starts cutting into the building's own ground at the
 * far side of the orbit, which reads as damage rather than as a boundary.
 */
const BOX_REACH = 0.55;

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
