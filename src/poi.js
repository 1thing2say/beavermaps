// Which pictogram a printed building name earns.
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
