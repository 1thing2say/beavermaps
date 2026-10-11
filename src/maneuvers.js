import { point } from '@turf/helpers';
import { bearing } from '@turf/bearing';
import { distance } from '@turf/distance';

// Shared by the browser and by server/index.js so the two can never disagree
// about what counts as a turn.

export const FEET_PER_KM = 3280.84;

/**
 * Bends closer together than this can be one turn, in feet.
 *
 * Inside the 25 ft at which navigation counts a maneuver reached, so the
 * second of two such bends comes up on the sign while the first is still being
 * counted down: two signs, a few feet apart, for what a walker does as one
 * movement.
 */
export const JOG_FEET = 20;

/**
 * ...as long as they stay within this of the one turn that replaces them.
 *
 * About the width of a campus path. A jog smaller than this is the line
 * wobbling inside the path you are already on; one wider is a real dogleg —
 * left off the path, a few steps, right into a door — and folding it away
 * would walk you straight past the turn.
 */
export const JOG_WIDTH_FEET = 8;

/** Signed angle in degrees from heading a->b to heading c->d. */
function headingChange(a, b, c, d) {
  let delta = bearing(point(c), point(d)) - bearing(point(a), point(b));
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

/** How far `to` lies to one side of a walker at `from` facing `heading`, in feet. */
function sideways(from, to, heading) {
  const off = (bearing(point(from), point(to)) - heading) * (Math.PI / 180);
  return Math.abs(Math.sin(off)) * feetBetween(from, to);
}

/** Signed angle in degrees between the incoming and outgoing segment at b. */
export function bearingDelta(a, b, c) {
  return headingChange(a, b, b, c);
}

export function classify(delta) {
  const magnitude = Math.abs(delta);
  if (magnitude < 20) return 'straight';
  if (magnitude > 150) return 'uturn';
  if (delta > 0) return magnitude > 60 ? 'right' : 'slight-right';
  return magnitude > 60 ? 'left' : 'slight-left';
}

export function feetBetween(a, b) {
  return distance(point(a), point(b)) * FEET_PER_KM;
}

/**
 * Walk the route and emit one maneuver per genuine turn. Collinear vertices are
 * swallowed into the preceding leg, so "continue straight" never fires just
 * because a path happened to be drawn as several segments.
 *
 * BENDS A FEW FEET APART ARE ONE TURN, judged by where they leave you
 * heading. Each vertex used to be classified on its own, so a path that jogs
 * sideways — right, and eight feet later left again — came out as "Bear
 * right" then "Bear left": two instructions for a walk whose direction barely
 * changes, and a turn count inflated by both. Snapped edges and door spurs
 * leave these in the network, and about one route in eleven had a pair.
 *
 * So a bend is read together with every other bend within JOG_FEET after it:
 * the heading coming in to the first against the heading going out of the
 * last, as one turn made at the first. A jog that comes back to the same
 * heading is no turn at all, and two 45-degree bends in quick succession are
 * the one right turn a walker makes. Only while that one turn stays inside the
 * path, though: a run of bends that strays further than JOG_WIDTH_FEET to one
 * side of it is a dogleg, and each of its bends is announced as before.
 *
 * distanceFeet is the distance travelled *to reach* the maneuver, which is what
 * the banner announces: "in 250 ft, turn left". Whatever is folded into a turn
 * goes on the leg after it.
 */
export function buildManeuvers(coords) {
  if (coords.length < 2) return [];

  const maneuvers = [{ type: 'depart', coordinate: coords[0], distanceFeet: 0, index: 0 }];
  let leg = 0;

  for (let i = 1; i < coords.length - 1; i++) {
    leg += feetBetween(coords[i - 1], coords[i]);
    const delta = bearingDelta(coords[i - 1], coords[i], coords[i + 1]);
    if (classify(delta) === 'straight') continue;

    // The last bend close enough to be part of this one, and how far on it is.
    let last = i;
    let toLast = 0;
    for (let k = i + 1, along = 0; k < coords.length - 1; k++) {
      along += feetBetween(coords[k - 1], coords[k]);
      if (along >= JOG_FEET) break;
      if (classify(bearingDelta(coords[k - 1], coords[k], coords[k + 1])) !== 'straight') {
        last = k;
        toLast = along;
      }
    }

    // One turn at `i`, leaving on the heading the last bend leaves on. Every
    // vertex in between has to lie close to that line, or the walker making
    // the one turn would be walking beside the path rather than on it.
    if (last !== i) {
      const leaving = bearing(point(coords[last]), point(coords[last + 1]));
      for (let k = i + 1; k <= last; k++) {
        if (sideways(coords[i], coords[k], leaving) > JOG_WIDTH_FEET) {
          last = i;
          toLast = 0;
          break;
        }
      }
    }

    const type = last === i
      ? classify(delta)
      : classify(headingChange(coords[i - 1], coords[i], coords[last], coords[last + 1]));
    if (type !== 'straight') {
      maneuvers.push({ type, coordinate: coords[i], distanceFeet: Math.round(leg), index: i });
      leg = 0;
    }
    leg += toLast;
    i = last;
  }

  leg += feetBetween(coords[coords.length - 2], coords[coords.length - 1]);
  maneuvers.push({
    type: 'arrive',
    coordinate: coords[coords.length - 1],
    distanceFeet: Math.round(leg),
    index: coords.length - 1,
  });

  return maneuvers;
}

/** Cumulative along-route distance in km for every vertex. */
export function cumulativeDistances(coords) {
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) {
    cumulative[i] = cumulative[i - 1] + distance(point(coords[i - 1]), point(coords[i]));
  }
  return cumulative;
}

// There are no street names on campus, so an instruction is a direction and
// nothing else.
const PHRASES = {
  depart: 'Start walking',
  straight: 'Continue straight',
  'slight-left': 'Bear left',
  'slight-right': 'Bear right',
  left: 'Turn left',
  right: 'Turn right',
  uturn: 'Make a U-turn',
  arrive: 'Arrive at destination',
};

export function instructionFor(type) {
  return PHRASES[type] ?? 'Continue';
}

/**
 * Round to increments a person can actually act on. Nobody walks "487 feet".
 */
export function niceFeet(feet) {
  if (feet >= 5280) return `${(feet / 5280).toFixed(1)} mi`;
  if (feet < 50) return `${Math.max(0, Math.round(feet / 5) * 5)} ft`;
  if (feet < 500) return `${Math.round(feet / 10) * 10} ft`;
  return `${Math.round(feet / 50) * 50} ft`;
}
