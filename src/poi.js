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
// not in scripts/build-labels.mjs: nothing about my campus's file changes, and the
// rules are applied to `labels.json` on the way into the map source.
//
// Rules are ordered and the first match wins. That ordering is load-bearing in
// two places, both marked below.
//
// The amenity rules at the bottom of the file are the same idea applied to
// amenities.json, and for the same reason: nothing about my campus's data changes,
// only what this map chooses to do with it.

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
  { icon: 'sport', test: /\bgym\b|\bpool\b|\bPE\b|physical education|athletic|kinesiology|\brec\b/i },
  { icon: 'library', test: /library|learning resource/i },
  { icon: 'store', test: /bookstore|college store/i },
  { icon: 'civic', test: /police/i },
  { icon: 'childcare', test: /child development/i },
  { icon: 'parking', test: /parking garage/i },
  { icon: 'works', test: /operations|sign shop|auto yard|ranch house|portable village/i },
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

/** The label kinds that get a disc: my campus's two building-name kinds. */
export const POI_LABEL_KINDS = new Set(['building', 'plate']);

/**
 * Copy a label collection with a `poi` property on every feature that earns
 * one. Area names (STADIUM, BASEBALL FIELD) and the parking lots are left
 * alone: Google sets area names as plain text too, and the sheet already draws
 * its own P badge on every lot.
 */
export function withPoiIcons(collection) {
  return {
    ...collection,
    features: collection.features.map((feature) => {
      if (!POI_LABEL_KINDS.has(feature.properties.kind)) return feature;
      const icon = poiFor(feature.properties.text);
      if (!icon) return feature;
      return { ...feature, properties: { ...feature.properties, poi: icon } };
    }),
  };
}

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
 * So the thirty-one destinations stay on from 16, and the fifty-three pieces of
 * infrastructure — fourteen phones, fifteen bike racks, ten permit machines,
 * eight parking badges, six motorcycle bays — wait until 18, by which point you
 * are looking at a building or two rather than the whole site. On the Parking
 * Garage alone that is the difference between seven markers and one.
 *
 * Nothing is lost by waiting. Every one of these kinds has a chip that draws
 * ALL of them at any zoom, and a legend row that outlines the buildings and car
 * parks holding them. This is the ambient layer only — the one you did not ask
 * for.
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
  // Infrastructure.
  emergency_phone: 18,
  bike_rack: 18,
  parking_permit: 18,
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
