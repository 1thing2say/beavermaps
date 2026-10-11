import { point } from '@turf/helpers';
import { bearing } from '@turf/bearing';
import { distance } from '@turf/distance';

// Shared by the browser and by server/index.js so the two can never disagree
// about what counts as a turn.

export const FEET_PER_KM = 3280.84;
const FEET_PER_M = FEET_PER_KM / 1000;

/**
 * A vertex that turns less than this is drawing, not a bend: the sheet traces a
 * straight path as a run of segments a degree or two apart, and a corner as a
 * run of them 10 to 40 degrees apart. Eight sits between the two.
 */
export const BEND_DEG = 8;
/** Bends closer together than this are one corner, however it was drawn. */
export const GROUP_M = 10;
/**
 * How far either side of a corner its bearings are taken from. The segments AT
 * a corner are one to three metres long, and a bearing across one of those is
 * the bearing of the pen, not of the walk.
 */
export const LOOK_M = 6;
/**
 * A curve with a junction on it is said once it has turned this far within
 * CURVE_M, even though no single vertex of it is a bend; see buildManeuvers.
 */
export const CURVE_DEG = 45;
export const CURVE_M = 30;
/** A bend back this sharp, after a full turn, starts a corner of its own. */
export const JOG_DEG = 45;
/** A junction this close to the middle of a corner is where the corner is said. */
export const JUNCTION_M = 4;
/** Another drawn branch this close to the one taken makes going straight a choice. */
export const RIVAL_DEG = 30;
/**
 * A dotted leg at least this long has a direction worth turning from. The
 * router's SNAP_WELD_M (server/graph.js), which is the line below which two
 * points are one place to it; test/maneuvers.test.js holds the two together.
 * Not imported, because this module runs in the browser and that one does not.
 */
export const LEG_TURN_M = 2.0;
/** Past this, classify() calls it a U-turn. */
const UTURN_DEG = 150;
/** A bend this small does not break a curve that is going the other way. */
const NOISE_DEG = 2;

/** Signed angle in degrees between the incoming and outgoing segment at b. */
export function bearingDelta(a, b, c) {
  const incoming = bearing(point(a), point(b));
  const outgoing = bearing(point(b), point(c));
  return wrap(outgoing - incoming);
}

function wrap(delta) {
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

export function classify(delta) {
  const magnitude = Math.abs(delta);
  if (magnitude < 20) return 'straight';
  if (magnitude > UTURN_DEG) return 'uturn';
  if (delta > 0) return magnitude > 60 ? 'right' : 'slight-right';
  return magnitude > 60 ? 'left' : 'slight-left';
}

export function feetBetween(a, b) {
  return distance(point(a), point(b)) * FEET_PER_KM;
}

const metresBetween = (a, b) => distance(point(a), point(b)) * 1000;
const heading = (a, b) => bearing(point(a), point(b));
const sameCoord = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

/** The point `m` metres along the line, clamped to its ends. */
function pointAt(coords, cumulative, m) {
  const total = cumulative[cumulative.length - 1];
  if (m <= 0) return coords[0];
  if (m >= total) return coords[coords.length - 1];
  let lo = 0;
  let hi = coords.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= m) lo = mid;
    else hi = mid;
  }
  const span = cumulative[hi] - cumulative[lo];
  const s = span > 0 ? (m - cumulative[lo]) / span : 0;
  const [a, b] = [coords[lo], coords[hi]];
  return [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])];
}

/**
 * Walk the route and emit one maneuver per corner a person would call a corner.
 *
 * WHAT IT USED TO DO was emit one per VERTEX that turned 20 degrees or more,
 * with the bearing taken across the two segments either side of it. That was
 * written for a line whose vertices are decisions, and this network's are not:
 * it is traced from the printed sheet, so a curve is a run of one-to-three
 * metre segments each turning 20 to 40 degrees, and a junction is often a
 * dog-leg of two opposite bends a few metres apart where a stroke was cut and
 * anchored. Over 13,347 walks that gave 81,290 instructions, a median of six a
 * route and a worst of 28; 22.5% of them at vertices with no other way to go,
 * 21.9% less than 25 ft after the one before, and 17,680 pairs of opposite
 * turns within 15 m — "bear left", then nine feet later "bear right", for
 * walking straight across the path west of Administration. Meanwhile a curve
 * drawn finely enough that no single vertex reached 20 degrees was never said
 * at all, however far round it went.
 *
 * WHAT IT DOES NOW is read the line the way a person walks it:
 *
 *   1. BENDS CLOSE TOGETHER ARE ONE CORNER. Consecutive vertices that turn
 *      BEND_DEG or more and are less than GROUP_M apart are one group — except
 *      across a jog. A full turn, a leg longer than LOOK_M and a bend of
 *      JOG_DEG or more back the other way is a walker stepping sideways round
 *      something, and merged it nets to nothing and is never said.
 *   2. A CORNER IS JUDGED BY WHERE IT TAKES YOU. The group's turn is the
 *      bearing from LOOK_M before its first vertex to that vertex, against the
 *      bearing from its last vertex to LOOK_M after it — so a dog-leg that nets
 *      to nothing says nothing, and a corner drawn as five bends is one turn.
 *   3. IT IS SAID WHERE THE TURNING IS, AND AT THE CHOICE THERE. At the
 *      vertex by which half the group's turn has been made; with `degreeAt`,
 *      at the busiest vertex within JUNCTION_M of that, which is the junction
 *      you turn at. Not at the busiest vertex of the whole group: a corner
 *      seven metres past a junction walked straight through was announced at
 *      the junction, where "turn right" points down the other branch.
 *   4. A GENTLE BEND WITH NO CHOICE ON IT IS NOT AN INSTRUCTION. With
 *      `degreeAt`, a "bear" whose group has no vertex of degree 3 or more is
 *      dropped: the path goes one way and you will follow it. A full left or
 *      right is still said, choice or not, because a walker looking at their
 *      phone wants to know the path is about to turn under them.
 *   5. A HAIRPIN IS A TURN, NOT A U-TURN. Two right-angle bends a few metres
 *      apart net to 180 degrees, and "make a U-turn" there reads as "you are
 *      going the wrong way". Only a group with one vertex that itself doubles
 *      back is a U-turn; anything else past 150 degrees is said as a left or
 *      a right.
 *   6. A LONG CURVE IS SAID WHERE THERE IS A CHOICE ON IT. With `degreeAt`,
 *      the bends that were not part of any instruction are summed while they
 *      keep turning the same way; once CURVE_DEG has gone by within CURVE_M
 *      and a junction lies on that stretch, the curve is said at the junction.
 *      A curve with no choice on it stays silent, as Apple's and Google's do.
 *
 * And two things a vertex alone cannot know, both only when the caller says:
 *
 *   - A FORK IS A CHOICE EVEN WHEN IT IS STRAIGHT. `branchesAt` gives the far
 *     end of each drawn edge at a vertex. Where the walk goes straight through
 *     a junction and another drawn branch leaves within RIVAL_DEG of it, the
 *     walk gets "Keep left" or "Keep right" by which side the other one is on.
 *     The caller leaves the plaza crossings out: they are not drawn, so they
 *     are never what a walker could mistake for the way.
 *   - THE ENDS HAVE A DIRECTION. `from` and `to` are the points asked about.
 *     Where the dotted leg from `from` to the line is LEG_TURN_M or longer,
 *     `depart` carries the `turn` onto the path; where the leg from the line
 *     to `to` is, `arrive` carries the `side` the destination is on.
 *
 * Without `opts` it is steps 1, 2, 3 and 5, which is what a line alone can say.
 *
 * On the same walks over today's network, with degrees and branches from the
 * drawn and approach edges: 59,449 instructions where the old pass gives
 * 79,153; 2,091 less than 25 ft after the one before, against 13,587; 7,452
 * opposite pairs within 15 m, against 17,451, and those left are jogs and
 * forks with a choice at each end; 301 bends of 60 degrees in 30 m beside a
 * junction with nothing said, against 516; U-turns 388, against 390.
 *
 * distanceFeet is the distance travelled *to reach* the maneuver, which is what
 * the banner announces: "in 250 ft, turn left".
 *
 * @param {number[][]} coords  the walk, [lon, lat] each
 * @param {object} [opts]
 * @param {(c: number[], i: number) => number} [opts.degreeAt]
 *   how many drawn and approach edges meet at coords[i]
 * @param {(c: number[], i: number) => number[][]} [opts.branchesAt]
 *   the far end of each drawn edge at coords[i], plaza crossings left out
 * @param {number[]} [opts.from]  where the walk was asked to start
 * @param {number[]} [opts.to]    where it was asked to end
 */
export function buildManeuvers(coords, opts = {}) {
  if (coords.length < 2) return [];
  const { degreeAt, branchesAt, from, to } = opts;
  const n = coords.length;

  const cumulative = [0];
  for (let i = 1; i < n; i++) cumulative[i] = cumulative[i - 1] + metresBetween(coords[i - 1], coords[i]);
  const bend = [0];
  for (let i = 1; i < n - 1; i++) {
    // A zero-length segment has no bearing, and turf calls it north.
    const flat = cumulative[i] - cumulative[i - 1] < 0.01 || cumulative[i + 1] - cumulative[i] < 0.01;
    bend[i] = flat ? 0 : bearingDelta(coords[i - 1], coords[i], coords[i + 1]);
  }
  // Rounded where the walk has got to rather than leg by leg, so the steps add
  // up to the whole walk however many of them there are.
  const feetTo = (i) => Math.round(cumulative[i] * FEET_PER_M);
  const degree = (i) => (degreeAt ? degreeAt(coords[i], i) ?? 0 : 0);
  const isJunction = (i) => degree(i) >= 3;

  const depart = { type: 'depart', coordinate: coords[0], distanceFeet: 0, index: 0 };
  if (from && metresBetween(from, coords[0]) >= LEG_TURN_M) {
    const ahead = pointAt(coords, cumulative, LOOK_M);
    depart.turn = classify(wrap(heading(coords[0], ahead) - heading(from, coords[0])));
  }
  const maneuvers = [depart];
  let last = 0;
  // The bends since the last instruction, for step 6.
  let curve = [];

  function emit(type, at, extra) {
    maneuvers.push({
      type,
      coordinate: coords[at],
      distanceFeet: feetTo(at) - feetTo(last),
      index: at,
      ...extra,
    });
    last = at;
    curve = [];
  }

  /**
   * Where in [i, j] to say it: where the turning is, and at the junction there
   * if there is one. The middle of the turn is the vertex by which half of it
   * has been turned, and the busiest vertex within JUNCTION_M of that wins —
   * the dog-leg west of Administration is said at its junction, not at the
   * kink 2.7 m on. A junction further away than that is somewhere the walk
   * went straight through on its way to the corner, and announcing the turn
   * there sends a walker down whatever branch leaves it.
   */
  function pick(i, j) {
    const total = bend.slice(i, j + 1).reduce((s, b) => s + b, 0);
    let middle = j;
    let turned = 0;
    for (let k = i; k <= j; k++) {
      turned += bend[k];
      if (turned * Math.sign(total) >= Math.abs(total) / 2 - 1e-6) { middle = k; break; }
    }
    let at = middle;
    for (let k = i; k <= j; k++) {
      if (Math.abs(cumulative[k] - cumulative[middle]) > JUNCTION_M) continue;
      const [dk, da] = [degree(k), degree(at)];
      if (dk > da || (dk === da && dk >= 3 && Math.abs(bend[k]) > Math.abs(bend[at]))) at = k;
    }
    return at;
  }

  /** A turn past UTURN_DEG is a U-turn only if one vertex of it doubles back. */
  function capped(type, net, i, j) {
    if (type !== 'uturn') return type;
    for (let k = i; k <= j; k++) if (Math.abs(bend[k]) > UTURN_DEG) return type;
    return net > 0 ? 'right' : 'left';
  }

  /** Step 6: fold a bend nobody was told about into the running curve. */
  function listen(k) {
    if (!degreeAt) return;
    const sum = curve.reduce((s, c) => s + bend[c], 0);
    if (sum && Math.abs(bend[k]) >= NOISE_DEG && Math.sign(bend[k]) !== Math.sign(sum)) curve = [];
    curve.push(k);
    while (cumulative[k] - cumulative[curve[0]] > CURVE_M) curve.shift();
    const total = curve.reduce((s, c) => s + bend[c], 0);
    if (Math.abs(total) < CURVE_DEG || !curve.some(isJunction)) return;
    // Said at the junction, whichever one, because that is the only place on
    // a curve where saying it changes what anybody does.
    const at = curve.reduce((best, c) => (degree(c) > degree(best) ? c : best), curve[0]);
    emit(capped(classify(total), total, curve[0], k), at);
  }

  /** The walk's straight on through [i, j], against the other drawn branches. */
  function fork(i, j) {
    if (!branchesAt) return null;
    for (let k = i; k <= j; k++) {
      if (!isJunction(k) && degreeAt) continue;
      const taken = heading(coords[k], pointAt(coords, cumulative, cumulative[k] + LOOK_M));
      const rivals = [];
      for (const end of branchesAt(coords[k], k) ?? []) {
        if (sameCoord(end, coords[k]) || sameCoord(end, coords[k - 1]) || sameCoord(end, coords[k + 1])) continue;
        const off = wrap(heading(coords[k], end) - taken);
        if (Math.abs(off) < RIVAL_DEG) rivals.push(off);
      }
      if (!rivals.length) continue;
      const right = rivals.some((off) => off > 0);
      const left = rivals.some((off) => off < 0);
      // Another way on each side: the middle one is the one to say.
      if (right && left) return { type: 'straight', at: k };
      return { type: right ? 'slight-left' : 'slight-right', at: k };
    }
    return null;
  }

  let i = 1;
  while (i < n - 1) {
    if (Math.abs(bend[i]) < BEND_DEG && !isJunction(i)) {
      listen(i);
      i++;
      continue;
    }

    let j = i;
    let turned = bend[i];
    for (let k = i + 1; k < n - 1 && cumulative[k] - cumulative[k - 1] < GROUP_M; k++) {
      if (Math.abs(bend[k]) < BEND_DEG) break;
      // A jog: a whole turn made, a leg of its own, and a turn back. That is
      // two corners, and merging them would net it to "straight".
      const back = Math.sign(bend[k]) !== Math.sign(turned) && Math.abs(bend[k]) >= JOG_DEG;
      if (back && Math.abs(turned) >= 60 && cumulative[k] - cumulative[i] >= LOOK_M) break;
      j = k;
      turned += bend[k];
    }

    const before = pointAt(coords, cumulative, cumulative[i] - LOOK_M);
    const after = pointAt(coords, cumulative, cumulative[j] + LOOK_M);
    const incoming = heading(sameCoord(before, coords[i]) ? coords[i - 1] : before, coords[i]);
    const net = wrap(heading(coords[j], after) - incoming);
    let type = capped(classify(net), net, i, j);

    if (degreeAt && type.startsWith('slight')) {
      let choice = false;
      for (let k = i; k <= j && !choice; k++) choice = isJunction(k);
      if (!choice) type = 'straight';
    }

    if (type !== 'straight') {
      emit(type, pick(i, j));
    } else {
      const choice = fork(i, j);
      if (choice) emit(choice.type, choice.at, { fork: true });
      else for (let k = i; k <= j; k++) listen(k);
    }
    i = j + 1;
  }

  const arrive = {
    type: 'arrive',
    coordinate: coords[n - 1],
    distanceFeet: feetTo(n - 1) - feetTo(last),
    index: n - 1,
  };
  if (to && metresBetween(coords[n - 1], to) >= LEG_TURN_M) {
    const behind = pointAt(coords, cumulative, cumulative[n - 1] - LOOK_M);
    const off = wrap(heading(coords[n - 1], to) - heading(behind, coords[n - 1]));
    arrive.side = Math.abs(off) < 20 ? 'ahead' : off > 0 ? 'right' : 'left';
  }
  maneuvers.push(arrive);

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

// A fork is not a bend in the path, it is two paths, and "bear left" there
// reads as "the path curves". Every app says "keep".
const FORKS = {
  'slight-left': 'Keep left',
  'slight-right': 'Keep right',
  straight: 'Keep straight on',
};

const SIDES = {
  left: 'Destination on your left',
  right: 'Destination on your right',
  ahead: 'Destination ahead',
};

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * What the sign says for a maneuver. `detail` is the maneuver itself, for the
 * three that say more than their type: a fork, a depart with a turn onto the
 * path at the end of its dotted leg, and an arrive with a side.
 */
export function instructionFor(type, detail = {}) {
  if (detail.fork && FORKS[type]) return FORKS[type];
  if (type === 'depart' && PHRASES[detail.turn]) {
    if (detail.turn === 'straight') return 'Walk to the path and carry on straight';
    return `Walk to the path, then ${lowerFirst(PHRASES[detail.turn])}`;
  }
  if (type === 'arrive' && SIDES[detail.side]) return SIDES[detail.side];
  return PHRASES[type] ?? 'Continue';
}

/**
 * The second half of a sign that has two corners on it: "Turn left, then turn
 * right". The arrive half is its own sentence because "then destination on
 * your right" is not one.
 */
export function thenPhrase(step) {
  if (step.type === 'arrive') {
    return step.side === 'left' || step.side === 'right' ? `then arrive on your ${step.side}` : 'then arrive';
  }
  return `then ${lowerFirst(instructionFor(step.type, step))}`;
}

/**
 * Round to increments a person can actually act on. Nobody walks "487 feet".
 *
 * Never "0 ft". A distance that rounds to nothing is still somewhere you have
 * not got to yet, and a sign reading "in 0 ft" is one telling you that you have
 * already missed it; the countdown says "now" instead (see countdownFeet).
 */
export function niceFeet(feet) {
  if (feet >= 5280) return `${(feet / 5280).toFixed(1)} mi`;
  if (feet < 50) return `${Math.max(5, Math.round(feet / 5) * 5)} ft`;
  if (feet < 500) return `${Math.round(feet / 10) * 10} ft`;
  return `${Math.round(feet / 50) * 50} ft`;
}

/** The banner's count down to a corner: niceFeet, and "now" once it is here. */
export function countdownFeet(feet) {
  return feet < 2.5 ? 'now' : niceFeet(feet);
}
