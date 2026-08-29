// What a marker earns on this map: which pictogram, which name, and how close
// you have to be before it is drawn at all.
//
// Google's basemap does not label a place with bare text — it draws a small
// coloured disc and sets the name beside it, and the colour says what sort of
// place it is: orange for food, purple for arts, green for sport and outdoors,
// blue for everything civic and institutional. That colour is most of what
// makes their map scannable; my campus's sheet has 39 building names in one ink, so
// finding the gym means reading all 39.
//
// The classification is presentation, not data, which is why it lives here and
// (see the import) so is deciding where to put a marker on a car park the
// cartographer never labelled.
// not in scripts/build-labels.mjs: nothing about my campus's file changes, and the
// rules are applied to `labels.json` on the way into the map source.
//
// Rules are ordered and the first match wins. That ordering is load-bearing in
// two places, both marked below.
//
// The amenity rules at the bottom of the file are the same idea applied to
// amenities.json, and for the same reason: nothing about my campus's data changes,
// only what this map chooses to do with it.

// Ray casting, and the campus ring is only what it happens to be written for —
// the test is "is this point in this ring", and a car park is a ring.
import { inCampus as inRing, M_PER_LON, M_PER_LAT } from './campus-clip.js';

/** Disc id -> what it means. The ids are registered as images in map-images.js. */
export const POI_CLASSES = {
  campus: 'Campus building',
  library: 'Library and learning resources',
  arts: 'Arts, music and performance',
  food: 'Food and drink',
  sport: 'Sport and recreation',
  store: 'Bookstore',
  civic: 'Campus police',
  childcare: 'Child development',
  works: 'Operations and yards',
  parking: 'Parking structure',
};

const RULES = [
  // BEFORE `arts`: the Evangelisti Culinary Arts Center is a kitchen, and it
  // contains the word "Arts". Ordering is the whole reason it lands on food.
  { icon: 'food', test: /culinary|\bcafe\b|cafeteria|dining/i },

  // BEFORE `arts` for the same reason: "Arts & Sci" is Arts and Sciences, a
  // general teaching building, not a gallery.
  { icon: 'campus', test: /arts? (&|and) sci/i },

  { icon: 'arts', test: /gallery|theatre|theater|\bmusic\b|\barts\b/i },
  { icon: 'sport', test: /\bgym\b|\bpool\b|\bPE\b|physical education|athletic|kinesiology|baseball|softball/i },
  { icon: 'library', test: /library|learning resource/i },
  { icon: 'store', test: /bookstore|college store/i },
  { icon: 'civic', test: /police/i },
  { icon: 'childcare', test: /child development/i },
  { icon: 'parking', test: /parking garage/i },

  // "Rec." is the only name on this campus that abbreviates, and it does not
  // abbreviate what it looks like. my campus's directory spells it Receiving: 519 m2
  // of loading dock in the service corner, between the Ranch House and the
  // police office. The sport rule above used to carry a `\brec\b` for it and
  // painted it green, which is the one classification here that a reader could
  // check against the ground and find wrong.
  { icon: 'works', test: /operations|sign shop|auto yard|ranch house|portable village|receiving|^rec\.?$|printing services/i },
];

/**
 * "Closed" is the sheet's word for a fenced-off area, not a building — there is
 * nothing there to pin. Everything else that reaches the default is a campus
 * building, which is a true statement about all of them.
 */
const NOT_A_PLACE = /^closed$/i;

/** The disc for a printed label, or null when the label names no place. */
export function poiFor(text) {
  const name = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!name || NOT_A_PLACE.test(name)) return null;
  return RULES.find((rule) => rule.test.test(name))?.icon ?? 'campus';
}

/** The label kinds that get a disc: my campus's two building-name kinds, and the lots. */
export const POI_LABEL_KINDS = new Set(['building', 'plate', 'parking']);

/**
 * Copy a label collection with a `poi` property on every feature that earns
 * one. Area names (STADIUM, BASEBALL FIELD) are left alone — Apple sets them as
 * plain text beside a glyph and Google as plain text alone, and neither draws a
 * marker on a field.
 *
 * A car park takes the P without being classified at all: there is only one
 * thing a car park is, and running its name through the rules above would send
 * "Stadium" and "Myrtle West" to the general `campus` disc.
 *
 * This is a change of mind, and the note it replaces said the opposite: that
 * the lots needed nothing because "the sheet already draws its own P badge on
 * every lot". It did, and then those badges were folded into the amenity layer
 * along with the phones and the bike racks — see REDRAWN in src/main.js — where
 * they wait until z18 with the rest of the infrastructure. So from the zoom the
 * campus fits the screen at down to the one where you are looking at a single
 * building, my campus's 161,000 m2 of parking was unmarked ground. The reference
 * draws a P on a lot at every zoom it draws the lot at.
 */
export function withPoiIcons(collection) {
  return {
    ...collection,
    features: collection.features.map((feature) => {
      const { kind, text } = feature.properties;
      if (kind === 'area') {
        return { ...feature, properties: { ...feature.properties, title: titleCase(text) } };
      }
      if (kind === 'parking') {
        return { ...feature, properties: { ...feature.properties, poi: 'parking' } };
      }
      if (!POI_LABEL_KINDS.has(kind)) return feature;
      const icon = poiFor(text);
      if (!icon) return feature;
      return { ...feature, properties: { ...feature.properties, poi: icon } };
    }),
  };
}

// --- the car parks my campus never named -------------------------------------------

/**
 * A lot has to be at least this big to be worth a mark of its own.
 *
 * The sheet carries 24 parking shapes over 161,000 m2, and the tail is not
 * parking in any sense a driver would recognise: below this line are seven
 * kerbside bays, three verges and a pair of 0 m2 slivers. Five lots clear it
 * without a name on them and they are 18,156, 8,379, 7,544, 7,016 and 4,209 m2
 * — the ones you would drive to.
 */
const LOT_MIN_M2 = 4_000;

/**
 * ...and it has to be this far from a mark already placed.
 *
 * my campus draws a car park as several shapes where an aisle or a planted island
 * splits it, so "one lot" and "one polygon" are different counts: the Stadium
 * lot is three shapes and the top row is five. Spacing rather than adjacency
 * because that is the thing actually being protected — two P discs 40 m apart
 * say there are two car parks here, whatever the geometry underneath them says.
 *
 * 120 m clears the four fragments that sit beside a named lot and keeps the
 * four genuinely separate ones, whose nearest existing mark is 192, 192, 215
 * and 362 m away. Nothing lands in the gap between 107 and 192, so the value is
 * a wide choice rather than a fitted one.
 */
const LOT_SPACING_M = 120;

/** Small: a named lot outranks an unnamed one in a collision. See GOOGLE_BAND. */
const LOT_MARK_PT = 6;

const exteriors = (geometry) => (
  geometry.type === 'Polygon' ? [geometry.coordinates[0]]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates.map((rings) => rings[0])
      : []);

/** A ring's area centroid, with the area that produced it. Both in degrees. */
function centroidOf(ring) {
  let twice = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    twice += cross;
    x += (ring[i][0] + ring[i + 1][0]) * cross;
    y += (ring[i][1] + ring[i + 1][1]) * cross;
  }
  if (!twice) return null;
  return { area: Math.abs(twice / 2), pt: [x / (3 * twice), y / (3 * twice)] };
}

const metres = (a, b) => Math.hypot((a[0] - b[0]) * M_PER_LON, (a[1] - b[1]) * M_PER_LAT);

/**
 * Copy a label collection with a nameless P added over every substantial car
 * park my campus left unlabelled.
 *
 * Five of the sheet's lots carry a printed name and those need nothing from
 * here — they are `parking` labels already and withPoiIcons gives them the same
 * disc, so the two arrive as one family: a P with a name beside it where there
 * is one, a P alone where there is not.
 *
 * Placed at the area centroid, and skipped rather than nudged when that point
 * falls outside its own lot. Three shapes here are L-shaped or crescent enough
 * for that to happen and all three are under 900 m2, so the size floor has
 * already dropped them; the check stays because the alternative failure — a P
 * floating on the road beside the car park it means — is worse than no P.
 */
export function withParkingMarks(collection, sheet) {
  if (!sheet) return collection;

  const marks = collection.features
    .filter((feature) => feature.properties.kind === 'parking')
    .map((feature) => feature.geometry.coordinates);

  const lots = sheet.features
    .filter((feature) => feature.properties.kind === 'parking')
    .map((feature) => {
      const rings = exteriors(feature.geometry);
      const [biggest] = rings.map(centroidOf).filter(Boolean).sort((a, b) => b.area - a.area);
      return biggest && { rings, pt: biggest.pt, m2: biggest.area * M_PER_LON * M_PER_LAT };
    })
    .filter((lot) => lot && lot.m2 >= LOT_MIN_M2)
    // Biggest first, so where two lots are close enough that only one can be
    // marked, the mark lands on the one more of the campus thinks of as a lot.
    .sort((a, b) => b.m2 - a.m2);

  const added = [];
  for (const lot of lots) {
    const holds = (pt) => lot.rings.some((ring) => inRing(pt, ring));
    if (marks.some(holds)) continue;                                  // my campus named this one
    if (!holds(lot.pt)) continue;                                     // centroid is off its own lot
    if (marks.some((mark) => metres(mark, lot.pt) < LOT_SPACING_M)) continue;
    marks.push(lot.pt);
    added.push({
      type: 'Feature',
      properties: { kind: 'parking', pt: LOT_MARK_PT, lines: 1 },
      geometry: { type: 'Point', coordinates: lot.pt },
    });
  }
  return { ...collection, features: [...collection.features, ...added] };
}

/**
 * my campus's five area names, as Apple would set them.
 *
 * The printed sheet letterspaces its area names in capitals — BASEBALL FIELD,
 * SOCCER STADIUM, SOFTBALL FIELD, STADIUM, TENNIS COURTS — and so does Google,
 * which is why the classic look keeps them exactly as the cartographer set
 * them. Apple does not: on the reference the same feature reads "Tennis
 * Courts", sentence case, untracked, on one line beside its glyph. Tracked
 * capitals are the single loudest thing our athletics half had that theirs
 * did not.
 *
 * A derived property rather than an edit to labels.json, for the same reason
 * `poi` above is one: casing is presentation, and the data stays what my campus
 * drew. Only these five strings ever reach it, and none of them contains an
 * acronym or a numeral, so the naive rule is the correct one — there is no
 * STEM or ER here to be flattened into Stem or Er.
 */
const titleCase = (text) => text.replace(
  /\p{Lu}[\p{Lu}']*/gu,
  (word) => word[0] + word.slice(1).toLowerCase(),
);

// ---------------------------------------------------------------------------
// Amenities: what gets a name, and when it appears
// ---------------------------------------------------------------------------

/**
 * The zoom each kind of amenity starts being drawn at.
 *
 * 84 markers on one campus is a lot, and they are not evenly interesting. The
 * split is between things you go LOOKING for and things you notice once you are
 * already somewhere: nobody scans a whole campus for an emergency telephone,
 * but plenty of people scan it for a restroom or a defibrillator.
 *
 * So the destinations stay on from 16, and the infrastructure — fourteen
 * phones, fifteen bike racks, eight parking badges, six motorcycle bays — waits
 * until 18, by which point you are looking at a building or two rather than the
 * whole site. On the Parking Garage alone that is the difference between seven
 * markers and one.
 *
 * Nothing is lost by waiting. Every one of these kinds has a chip that draws
 * ALL of them at any zoom, and a legend row that outlines the buildings and car
 * parks holding them. This is the ambient layer only — the one you did not ask
 * for.
 *
 * The ten permit machines are the exception, and they moved up to 16 because
 * the rule above puts them on the wrong side of its own test. You do go looking
 * for one: you have parked, you cannot leave the car until you have paid, and
 * the machine is the thing standing between those two facts. It is a
 * destination that happens to be small. Nine of the ten also sit at the edge of
 * a car park rather than in the middle of a building, so at the zoom the campus
 * fits the screen they land where the answer is wanted and nowhere near the
 * stack of markers the 18 line was drawn to break up.
 */
export const AMENITY_ZOOM = {
  // Destinations.
  health_centre: 16,
  defibrillator: 16,
  restroom: 16,
  bus_stop: 16,
  food_vending: 16,
  drink_vending: 16,
  drop_off: 16,
  parking_permit: 16,
  // Infrastructure.
  emergency_phone: 18,
  bike_rack: 18,
  parking_badge: 18,
  motorcycle_parking: 18,
};

/** Anything not listed above behaves like a destination. */
export const AMENITY_ZOOM_DEFAULT = 16;

/**
 * Give an amenity a printed name only when that name identifies it.
 *
 * This is the rule the category pins have always used, applied to the ambient
 * layer where it matters far more. Of 84 amenities, 80 carry a label shared with
 * at least one other: "Emergency telephone" fourteen times, "Bike rack" fifteen.
 * Printed on the map they are not names, they are the icon's own meaning set in
 * type — and four of them landed on the Parking Garage at once, each one two
 * lines deep, which is what turned one building into a wall of text.
 *
 * Four survive, and they are exactly the four worth reading: the Health &
 * Wellness Center, and the three bus stops, whose labels carry the route and the
 * direction rather than the word "bus".
 *
 * The rest keep their label in `properties.label`, which is what the card prints
 * when one is tapped. Nothing is lost; it is moved to where there is room for it.
 */
export function withAmenityNames(collection) {
  const seen = new Map();
  for (const feature of collection.features) {
    const label = feature.properties.label;
    seen.set(label, (seen.get(label) ?? 0) + 1);
  }
  return {
    ...collection,
    features: collection.features.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        ...(seen.get(feature.properties.label) === 1 ? { name: feature.properties.label } : {}),
      },
    })),
  };
}
