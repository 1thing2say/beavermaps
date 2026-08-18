// How long the walk takes, and whether it is a walk at all.
//
// The arithmetic behind the route summary — the "12 min · 8:24 PM · 0.3 mi"
// line and the one refusal it can print instead. Kept out of main.js because
// every value in here is a judgement about the physical world rather than about
// the interface, and each one is worth stating where it can be argued with.

import { FEET_PER_KM, niceFeet } from './maneuvers.js';

/**
 * Walking speed, metres per second.
 *
 * 1.4 m/s is unimpeded adult walking on the level — the figure the pedestrian
 * literature settles on and the one Apple and Google's walking ETAs land near.
 * It is deliberately NOT the 1.2 m/s that crossing-signal timing uses: that
 * number is chosen to be slow enough for the slowest pedestrian to finish
 * crossing, which is the right way to be wrong when someone is in a junction
 * and the wrong way to be wrong on a card that says how long a walk takes.
 *
 * This campus is flat and its network is paved paths, so there is no grade
 * correction and no surface penalty. Both would be invented precision: the
 * error in the fix at either end of a 400 m walk is larger than either.
 */
export const WALK_M_PER_S = 1.4;

const METRES_PER_KM = 1000;

/**
 * How far from the routing graph a position may be and still be routed from.
 *
 * MEASURED, not chosen. Sampling a 60x60 grid over the graph's own bounding box
 * gives a median distance to the nearest vertex of 26 m, a 99th percentile of
 * 121 m and a worst case of 215 m — so anywhere the graph actually covers, you
 * are within about 200 m of it. 300 m clears that worst case with room for a
 * poor fix and still fails immediately for somebody two suburbs away.
 *
 * The failure this exists to stop is specific and silent. The router snaps a
 * start to the NEAREST vertex, with no notion of "too far": open the app from
 * home ten miles away and it will cheerfully draw a route that begins at the
 * corner of the approach network and announce it as an eight minute walk. The
 * distance is real, the walk is real, and it is not yours.
 */
export const REACH_M = 300;

/** Seconds of walking for a distance in feet. */
export function walkSeconds(feet) {
  return (feet / FEET_PER_KM) * METRES_PER_KM / WALK_M_PER_S;
}

/**
 * A duration as a person says it: "3 min", "45 min", "1 hr 11 min".
 *
 * Rounded up rather than to nearest, and never to zero. A walk announced as
 * "0 min" is a walk the card is claiming you have already finished, and the
 * shortest real answer to "how long" is one minute.
 */
export function walkLabel(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/**
 * The clock time you arrive, in the reader's own locale and timezone.
 *
 * `toLocaleTimeString` rather than arithmetic on the hours, because this is the
 * one place in the app where a wall clock is correct and UTC is not — the
 * opposite of src/daylight.js, which refuses timezones on purpose. Somebody
 * reading "8:24 PM" is going to compare it against the clock on their own
 * phone, and that clock is in their timezone whatever the sun is doing.
 */
export function arrivalLabel(date, seconds) {
  return new Date(date.getTime() + seconds * 1000)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The whole summary line for a route, given its length in feet.
 *
 * One function so the three numbers cannot disagree about which route they
 * describe — the time, the arrival and the distance are all derived from the
 * same `feet`, and `niceFeet` is maneuvers.js's opinion rather than a second
 * one invented here.
 */
export function routeSummary(feet, now = new Date()) {
  const seconds = walkSeconds(feet);
  return {
    seconds,
    time: walkLabel(seconds),
    arrival: arrivalLabel(now, seconds),
    distance: niceFeet(feet),
  };
}

/**
 * The way forward every refusal in this file ends with.
 *
 * Stated once because it is the same way forward in all four cases and it is
 * the whole reason those refusals are not dead ends: the map still takes a
 * start point directly, and a hold on it is a complete answer to "I am here".
 */
const HOLD = 'Press and hold the map to set a starting point instead.';

/**
 * Why a position cannot be walked from, or null if it can.
 *
 * `metres` is the distance from the fix to the nearest vertex of the routing
 * graph — which is a better question than "how far from campus", because what
 * breaks is the snap and not the geography.
 */
export function reachProblem(metres) {
  if (!Number.isFinite(metres)) return `Could not work out where you are on the map. ${HOLD}`;
  if (metres <= REACH_M) return null;
  const miles = (metres / METRES_PER_KM) * 0.621371;
  const away = miles >= 0.2 ? `${miles.toFixed(1)} mi` : niceFeet(metres * 3.28084);
  return `You are about ${away} from the campus paths — too far to walk from here. ${HOLD}`;
}

/**
 * What to say when the browser refuses to say where you are.
 *
 * Every sentence names a way forward, because all three of these are states the
 * user can do something about and none of them is the app being broken. The
 * fallback offered is always the same one: the map itself still takes a start
 * point, and a hold on it is a whole answer to "I am here".
 */
export function locationProblem(error) {
  switch (error?.code) {
    case 1:
      return `Location is turned off for this site. Allow it in your browser, or press and hold the map to set a starting point.`;
    case 3:
      return `Locating timed out. ${HOLD}`;
    default:
      return `Your device could not get a location fix. ${HOLD}`;
  }
}
