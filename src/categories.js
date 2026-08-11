// The category chips across the top of the map.
//
// Google's are their POI verticals — Restaurants, Hotels, Museums, Things to
// do. None of those mean anything inside one college campus, so this list is
// my campus's own printed key instead, from the legend block on campus-map.pdf
// (Ver. 3/2026):
//
//   P  Daily Parking Permit          Motorcycle Parking
//      Health & Wellness Center      Bike Rack
//      Defibrillator                 All Gender Restrooms
//      Emergency telephone           HOME BASE LOCATIONS
//      Student Drop-Off              BUS (route 1, 82)
//
// Two data sources back them, because the legend's symbols and my campus's directory
// are separate files:
//
//   `kinds`  — pictogram categories in amenities.json, already drawn on the map
//              by the campus-amenities layer. Selecting one filters that layer,
//              so the chip visibly subtracts everything else.
//   `match`  — a predicate over places.json, my campus's directory. Parking lots, bus
//              stops and HomeBases are named rows there and have no pictogram,
//              so the chip supplies its own pins.
//
// A category may use either; none needs both, and `icon` is the disc registered
// in map-images.js for the pins a `match` category draws.

/** Ordered as they appear on the chip strip: most-asked-for first. */
export const CATEGORIES = [
  {
    id: 'restrooms',
    label: 'Restrooms',
    glyph: 'restroom',
    kinds: ['restroom'],
    legend: 'All Gender Restrooms',
  },
  {
    id: 'parking',
    label: 'Parking',
    glyph: 'parking',
    icon: 'parking',
    // Their lot names all end in "Parking Lot", "Parking Garage" or name the
    // metered lot. These are the pins that carry a real name — "Myrtle Parking
    // Lot East" — which is what somebody asking about parking is looking for.
    match: (name) => /parking (lot|garage)|metered parking/i.test(name),
    // ...and the ten machines you buy the permit from, which is the other half
    // of the same question: knowing which lot to use is no help without knowing
    // where to pay. They keep their own row on the key as well — the printed
    // legend lists them separately and this is not the place to overrule it —
    // but a row about parking that omitted them was answering half.
    //
    // Drawn in `parking_meter` rather than in their own `parking_permit` disc,
    // which is the same pictogram in a lighter azure. Both sets arrive together
    // here and Google's single blue made twenty-odd pins one undifferentiated
    // field; on the map at rest, and under Permit machines, a machine is still
    // blue. See the note beside the colour in src/map-images.js.
    kinds: ['parking_permit'],
    kindIcons: { parking_permit: 'parking_meter' },
    // The one row that also names a class of the printed sheet, so PRESSING it
    // outlines all 22 car parks under the pins. Hovering does not — a hover
    // previews objects now, on every row including this one. See previewLegendRow.
    zones: 'parking',
    legend: 'Parking lots, garage and permit machines',
  },
  {
    id: 'food',
    label: 'Food & drink',
    glyph: 'vending',
    icon: 'food',
    kinds: ['food_vending', 'drink_vending'],
    match: (name) => /^cafeteria|oak cafe|culinary/i.test(name),
    legend: 'Cafeteria, cafe and vending machines',
  },
  {
    id: 'bus',
    label: 'Bus stops',
    glyph: 'bus',
    icon: 'bus_stop',
    // The three sign plates come from the sheet; Para Transit is a directory
    // row with real nodes and no printed symbol, so this category needs both.
    kinds: ['bus_stop'],
    match: (name) => /^para transit/i.test(name),
    legend: 'Bus routes 1 and 82',
  },
  {
    id: 'bike',
    label: 'Bike racks',
    glyph: 'bike_rack',
    kinds: ['bike_rack'],
    legend: 'Bike Rack',
  },
  {
    id: 'emergency',
    label: 'Emergency phones',
    glyph: 'emergency_phone',
    kinds: ['emergency_phone'],
    legend: 'Emergency telephone',
  },
  {
    id: 'defibrillator',
    label: 'Defibrillators',
    glyph: 'defibrillator',
    kinds: ['defibrillator'],
    legend: 'Defibrillator',
  },
  {
    id: 'health',
    label: 'Health center',
    glyph: 'health_centre',
    kinds: ['health_centre'],
    legend: 'Health & Wellness Center',
  },
  {
    id: 'dropoff',
    label: 'Drop-off',
    glyph: 'drop_off',
    kinds: ['drop_off'],
    legend: 'Student Drop-Off',
  },
  {
    id: 'motorcycle',
    label: 'Motorcycle parking',
    glyph: 'motorcycle_parking',
    kinds: ['motorcycle_parking'],
    legend: 'Motorcycle Parking',
  },
  {
    id: 'permit',
    label: 'Permit machines',
    glyph: 'parking',
    kinds: ['parking_permit'],
    legend: 'Daily Parking Permit',
  },
  {
    id: 'homebase',
    label: 'HomeBase',
    glyph: 'homebase',
    icon: 'homebase',
    match: (name) => /homebase/i.test(name),
    legend: 'HOME BASE LOCATIONS (inside the LRC)',
  },
];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

/** Every disc a `match` category needs registered as a map image. */
export const CATEGORY_ICONS = [...new Set(CATEGORIES.map((c) => c.icon).filter(Boolean))];

/**
 * The points a category covers, as `{ name, sub, coords, icon }`.
 *
 * `icon` is the map image the pin is drawn with: a legend kind draws its own
 * pictogram, a directory row draws the category's.
 *
 * `category.kindIcons` overrides the first of those for one kind. Only parking
 * uses it, and only because it draws two sets at once: its lots and its permit
 * machines would otherwise arrive in the same blue. A per-category override
 * rather than a second colour in amenities.json, since the machine is only a
 * different colour in THIS row's answer — everywhere else it is what the
 * printed sheet says it is.
 *
 * Deliberately not deduplicated by name: my campus lists "Food Vending Machine" five
 * times because there are five of them, and a list that collapses those to one
 * row answers the wrong question. Search dedupes; a category list must not.
 */
export function collect(category, { amenities, places }) {
  const out = [];

  if (category.kinds && amenities) {
    const wanted = new Set(category.kinds);
    for (const f of amenities.features) {
      if (!wanted.has(f.properties.kind)) continue;
      out.push({
        name: f.properties.label ?? f.properties.kind,
        sub: null,
        coords: f.geometry.coordinates,
        icon: category.kindIcons?.[f.properties.kind] ?? f.properties.kind,
      });
    }
  }

  if (category.match && places) {
    for (const f of places.features) {
      const { name, description } = f.properties;
      if (!f.geometry || !category.match(name ?? '')) continue;
      out.push({
        name,
        sub: description ?? null,
        coords: f.geometry.coordinates,
        icon: category.icon,
      });
    }
  }

  return out;
}
