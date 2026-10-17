// What goes under what, for every campus layer whose position is a claim.
//
// ONE LIST, BOTTOM TO TOP, AND THAT IS THE WHOLE OF IT. The order used to be
// spread over three helpers — `belowNetwork`, `belowRoute` and a hard-coded
// `'campus-paths'` — each naming the one layer its caller had to go under, and
// each right only for the add order its author had in mind. The lamps were the
// proof: they anchored to `campus-paths`, a layer that has not existed for a
// long time, so `getLayer` said no, the anchor came back undefined, and every
// glow on campus was drawn over the paths and the route it was written to sit
// under. Nothing failed. It was just wrong, on every load, for as long as the
// id had been gone.
//
// A list cannot go stale that way, because a layer finds its place from where
// it sits IN the list rather than from one neighbour it was told about: it is
// inserted directly under the lowest layer above it that exists right now. That
// is correct whatever order things arrive in — and they arrive in several. The
// sheet comes from the server and can land before the network or long after
// it; the lamps are re-added when the amenities land; a basemap swap rebuilds
// the lot. By induction the layers already standing are in list order, so
// inserting under the first existing successor puts a new one above every
// existing predecessor and below everything that should cover it.
//
// Layers NOT in this list — the directory, the pins, the labels — are not
// ordered by it. They are added after the route by addNetworkLayers and sit
// above all of this. The extruded buildings ARE in it, though they only stand
// during a walk: they go between the dotted legs and the route line, inside
// the stack, and a layer threaded into the middle of the list without being
// on it would break the induction above — the next layer anchored past it
// would land on the wrong side.

/**
 * The campus stack inside Mapbox's `middle` slot, bottom first.
 *
 * Read it as the printed sheet with three things of ours threaded through it:
 *
 *   - THE GROUND. my campus's sheet in its own painter's order: the surfaces,
 *     the bay rake that is painted on them, then the pavement strokes laid over
 *     both. See src/campus-sheet.js for how the sheet is cut into these bands.
 *   - THE CANOPY. The trees, which the print draws over its walkways.
 *   - THE LAMPS AND THE NETWORK. Our ribbon, traced from that pavement, and the
 *     warm pools the lamps along it throw. Above the canopy — a footpath under
 *     a tree is still a footpath to someone walking it — and BELOW the
 *     buildings, which is the point of having bands at all: the print hides the
 *     stretches of its own linework that run under a roof, the network
 *     inherited them, and drawn over the buildings those stubs were the paths
 *     that walked through walls.
 *   - THE BUILDINGS. Footprints, stands, pool, shrubs, their outlines.
 *   - THE ANNOTATIONS. The closed block's wash, the legend's highlight and the
 *     closed block's outline — over the buildings they mark, which is the only
 *     place an outline round a building can be seen.
 *   - THE ROUTE. Last. Nothing here gets to bury the directions somebody is
 *     following. The extruded buildings, which only stand during a walk, are
 *     threaded into it: over the dotted legs — the walk-it-yourself stretches
 *     between a pin and the network, which a building in the way should hide —
 *     and under the route line itself, which nothing hides.
 */
export const CAMPUS_STACK = [
  'campus-mask',

  'campus-sheet-fill',
  'campus-rake',
  'campus-sheet-line',

  'campus-sheet-canopy',

  'campus-lamp-pool',
  'campus-lamp-core',
  'network-casing',
  'network-lines',

  'campus-sheet-upper-fill',
  'campus-sheet-upper-line',

  'campus-closed-fill',
  'highlight-fill',
  'highlight-line',
  'highlight-points',
  'campus-closed-line',

  'route-legs',
  'campus-buildings',
  'route-casing',
  'route-line',
];

/**
 * The `beforeId` that puts layer `id` in its place, given what exists now.
 *
 * Undefined when nothing above it in the list is standing yet, which Mapbox
 * reads as "top of the slot" — the right answer, because whatever belongs over
 * it will itself be inserted under nothing it should cover.
 *
 * Throws on an id that is not in the list. Silently answering `undefined` for
 * an unknown id is exactly how the lamps ended up over the route.
 *
 * @param {{ getLayer: (id: string) => unknown }} map
 * @param {string} id
 */
export function anchorFor(map, id) {
  const at = CAMPUS_STACK.indexOf(id);
  if (at < 0) throw new Error(`${id} has no place in CAMPUS_STACK`);
  return CAMPUS_STACK.slice(at + 1).find((above) => map.getLayer(above));
}
