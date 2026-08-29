// BROWSE BY WHAT A BUILDING IS, rather than by what it is called.
//
// The sheet has answered two questions for a while — "where is X" (the search
// field) and "where is the nearest one of these" (Find nearby, my campus's printed
// legend). It has never answered the third one, which is the one a visitor
// actually arrives with: WHAT IS HERE. Somebody who has never been on this
// campus cannot type "Kaneko Art Gallery", and no row of the printed key is
// about buildings at all — the legend is restrooms, phones, bike racks and bus
// stops, which is infrastructure.
//
// So: one tile per class of building, in that class's own colour, and pressing
// one outlines every building in it and lists them. The classes are src/poi.js's
// — the same ten this map already paints beside the building names — so the
// tiles are a way INTO something the map is already saying rather than a second
// scheme laid over it.
//
// This file is the tile strip's own decisions and nothing else: which classes
// get a tile, what a tile is called, and what order they come in. The
// classification, the colour and the pictogram all live where they already did.

import { POI_CLASSES } from './poi.js';

/**
 * The tiles, in the order they appear.
 *
 * ORDERED BY WHAT SOMEBODY WOULD LOOK FOR, not by size, and the catch-all is
 * last. `campus` holds 15 of the 33 buildings on this campus — it is what a
 * building is when nothing more specific is true of it — so leading with it
 * would put the least informative tile under the thumb. Everything above it
 * answers a question somebody actually has; it answers "show me the rest".
 *
 * `label` is short because a tile is half a phone wide and has a count under
 * it. POI_CLASSES' own strings are sentences — "Arts, music and performance" —
 * which is right where they are used, as the grey line under a building's name
 * on its card, and wrong here.
 */
export const BUILDING_KINDS = [
  { id: 'library', label: 'Library' },
  { id: 'food', label: 'Food' },
  { id: 'sport', label: 'Sport' },
  { id: 'arts', label: 'Arts' },
  { id: 'parking', label: 'Parking' },
  { id: 'store', label: 'Bookstore' },
  { id: 'childcare', label: 'Childcare' },
  { id: 'civic', label: 'Police' },
  { id: 'works', label: 'Operations' },
  { id: 'campus', label: 'Campus buildings' },
];

/** Tile id -> the tile. */
export const BUILDING_KIND_BY_ID = new Map(BUILDING_KINDS.map((k) => [k.id, k]));

/**
 * The id a pressed tile writes into `stickyRow`, namespaced.
 *
 * `legendHighlights` is one table keyed by row id and the two families collide:
 * my campus's legend has a `parking` row and poi.js has a `parking` class, and they
 * are not the same set — one is 22 car parks and the other is the multi-storey.
 * Prefixing is cheaper than renaming either.
 */
export const kindRow = (id) => `building:${id}`;

/**
 * Every directory building, grouped by the class it belongs to.
 *
 * `classify` is passed in rather than imported so this stays a pure function of
 * its arguments — the tests hand it poiFor, and so does main.js, and there is
 * no third caller that could hand it something else by accident.
 *
 * Alphabetical within a group. There is no better order available here: the
 * list opens from a tile rather than from a place, so there is no start point
 * to measure from at the moment it is built, and main.js sorts by distance on
 * the way into the panel where there is one.
 */
export function groupBuildings(directory, classify) {
  const groups = new Map(BUILDING_KINDS.map((kind) => [kind.id, []]));
  for (const feature of directory?.features ?? []) {
    const props = feature.properties;
    if (!props?.name) continue;
    const id = classify(props.name);
    // A class with no tile is not an error — poi.js is free to grow one this
    // file has not caught up with — but it is a building that cannot be browsed
    // to, which the test below the export watches for.
    groups.get(id)?.push(props);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

/** Any class poi.js can return that no tile covers. Empty is the healthy state. */
export const uncoveredClasses = () => Object.keys(POI_CLASSES)
  .filter((id) => !BUILDING_KIND_BY_ID.has(id));
