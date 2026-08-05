import { point } from '@turf/helpers';
import { bearing } from '@turf/bearing';
import { distance } from '@turf/distance';

// Shared by the browser and by server/index.js so the two can never disagree
// about what counts as a turn.

export const FEET_PER_KM = 3280.84;

/** Signed angle in degrees between the incoming and outgoing segment at b. */
export function bearingDelta(a, b, c) {
  const incoming = bearing(point(a), point(b));
  const outgoing = bearing(point(b), point(c));
  let delta = outgoing - incoming;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
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
 * distanceFeet is the distance travelled *to reach* the maneuver, which is what
 * the banner announces: "in 250 ft, turn left".
 */
export function buildManeuvers(coords) {
  if (coords.length < 2) return [];

  const maneuvers = [{ type: 'depart', coordinate: coords[0], distanceFeet: 0, index: 0 }];
  let leg = 0;

  for (let i = 1; i < coords.length - 1; i++) {
    leg += feetBetween(coords[i - 1], coords[i]);
    const type = classify(bearingDelta(coords[i - 1], coords[i], coords[i + 1]));
    if (type === 'straight') continue;
    maneuvers.push({ type, coordinate: coords[i], distanceFeet: Math.round(leg), index: i });
    leg = 0;
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
