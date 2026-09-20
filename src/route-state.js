// The walk that is currently on the screen.
//
// FOUR VARIABLES THAT WERE ALWAYS A SET. `routeCoords`, `routeLine`,
// `cumulative` and `maneuvers` lived side by side in startApp() and were only
// ever correct together: placeEnd assigned all four in a row, resetMap nulled
// all four in a row, and the thing keeping a half-set route from existing was
// that both of those places happened to be written correctly. Every reader then
// had to guess which one to test — `if (!routeCoords)` in routeFeature,
// `if (!routeLine)` in onUserMoved, `routeCoords.length < 2` in legsFeature and
// in startNavigation — four different questions that were all asking "is there
// a route".
//
// Here there is one answer, `isSet`, and the four cannot disagree because there
// is one assignment and one clear.
//
// WHAT IS NOT HERE is the start and end pins. They look like they belong — a
// route does run between them — but they outlive the route by design: you can
// drop a start, have no destination yet, and still see a marker. Folding them
// in would mean `clear()` either takes the pins down with the line (wrong) or
// leaves the object half-cleared (the bug this module exists to make
// impossible). They stay in startApp() with the rest of the marker state, and
// `legs()` takes them as arguments, which is the honest description of the
// relationship: the legs are drawn BETWEEN two things the route does not own.

import { lineString, point } from '@turf/helpers';
import { distance } from '@turf/distance';
import { cumulativeDistances, FEET_PER_KM } from './maneuvers.js';

/** Below this a leg is a nub, not a walk, and is better left undrawn. */
export const LEG_MIN_FEET = 12;

const empty = () => ({ type: 'FeatureCollection', features: [] });

/**
 * Hold one route at a time.
 *
 * `set` takes the server's answer verbatim — the `geometry` and `maneuvers` of
 * a 200 from /api/route — and derives the rest, so a caller cannot supply
 * `cumulative` that disagrees with `coords`.
 */
export function createRoute() {
  let held = null;

  return {
    set({ geometry, maneuvers }) {
      const coords = geometry.coordinates;
      held = {
        coords,
        // `lineString` THROWS on a single coordinate rather than returning
        // something degenerate, and a single coordinate is exactly what the
        // server used to answer when both ends snapped to the same vertex. The
        // server refuses that now (see the `same-place` reason in
        // server/graph.js), so this branch should be unreachable — but the
        // throw landed in the middle of an assignment in an async handler,
        // where it became an unhandled rejection and a panel stuck on
        // "Calculating…", and that is too quiet a failure to leave one guard
        // away. `isWalkable` is what the readers ask.
        line: coords.length >= 2 ? lineString(coords) : null,
        cumulative: cumulativeDistances(coords),
        maneuvers,
      };
      return held;
    },

    clear() {
      held = null;
    },

    /** The one question. Everything that used to ask its own asks this. */
    get isSet() {
      return held !== null;
    },

    /** Walkable: set, and long enough to have a direction. */
    get isWalkable() {
      return held !== null && held.coords.length >= 2;
    },

    get coords() { return held?.coords ?? null; },
    get line() { return held?.line ?? null; },
    get cumulative() { return held?.cumulative ?? null; },
    get maneuvers() { return held?.maneuvers ?? null; },

    /** Length of the whole walk in km — the last cumulative distance. */
    get totalKm() {
      return held ? held.cumulative[held.cumulative.length - 1] : 0;
    },

    /** Distance along the route, in km, at which maneuver `i` happens. */
    maneuverKm(i) {
      return held ? held.cumulative[held.maneuvers[i].index] : 0;
    },

    /** The ribbon. A bare Feature, which is what the source was built for. */
    feature() {
      if (!held) return empty();
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: held.coords },
      };
    },

    /**
     * The last few metres at each end, which are not on the network.
     *
     * A route runs between GRAPH VERTICES, and neither end of a journey is one.
     * my campus binds its destinations to their own node ids, which sit a metre
     * or two off ours because this network is traced from the printed sheet
     * rather than taken from their graph; an amenity is wherever its pictogram
     * is, which for half of them is inside a building. So the blue line stopped
     * short of the pin, by up to a few dozen feet, and looked like a routing
     * failure.
     *
     * Drawn as a separate dotted layer rather than by extending the coordinates,
     * and that distinction is the honest one: this is not path, it is the walk
     * from the path to the door. Every mapping app draws it the same way and for
     * the same reason. It also keeps the maneuver list and the simulator working
     * off the network geometry alone, which is the only thing they can follow.
     */
    legs(from, to) {
      if (!held || held.coords.length < 2) return empty();
      const ends = [
        [from, held.coords[0]],
        [held.coords[held.coords.length - 1], to],
      ];
      return {
        type: 'FeatureCollection',
        features: ends
          .filter(([a, b]) => a && b && distance(point(a), point(b)) * FEET_PER_KM >= LEG_MIN_FEET)
          .map(([a, b]) => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: [a, b] },
          })),
      };
    },
  };
}
