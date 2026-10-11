// Turn-by-turn, and the simulator that walks it for you.
//
// WHY THIS IS A MODULE AND NOT A SECTION. Thirteen functions in startApp() were
// the only readers and the only writers of ten variables — `stepIndex`,
// `navActive`, `lastBearing`, `userMarker`, `simTimer`, `simAlong`,
// `renderedStep`, `bannerBusy`, `bannerTimers`, `liveCard` — and those ten were
// declared two hundred lines away from the functions that owned them, in a run
// of thirty `let`s belonging to eight different concerns. Nothing said they
// were a set. The banner's three (`renderedStep`, `bannerBusy`, `liveCard`) are
// a small state machine whose invariant — one live card, one pending timer —
// held only as long as every writer remembered it, and every writer was in
// scope of everything else in the file.
//
// Nine of those ten are now unreachable from outside. The tenth, `navActive`,
// is genuinely shared: nine places elsewhere ask whether a walk is running
// before they take the camera, stand up the extrusions or answer a tap. It is
// `isActive()` here, a question rather than a variable, which is the only part
// of this state anything else is allowed to know.
//
// WHAT IT TAKES INSTEAD. Every dependency arrives through the factory, and the
// ones that are really callbacks are named for what they DO rather than for the
// function that happens to implement them — `restCamera`, not `fitBounds`;
// `releaseCameraLock`, not `geolocateControl.trigger`. That is what makes this
// testable without a map: the collaborators are all replaceable.
//
// Mapbox is not imported here, and that is deliberate rather than tidy. What
// this needs is a thing that shows where you are and can be moved — `addTo`,
// `setLngLat`, `remove` — which `mapboxgl.Marker` happens to be. Taking it as
// `makeUserDot` is what lets test/navigation.test.js walk a whole simulated
// route and check the dot went with it.

import { point } from '@turf/helpers';
import { nearestPointOnLine } from '@turf/nearest-point-on-line';
import { along } from '@turf/along';
import { bearing } from '@turf/bearing';
import { distance } from '@turf/distance';
import { maneuverIcon } from './nav-icons.js';
import { instructionFor, niceFeet, FEET_PER_KM } from './maneuvers.js';

// Comfortable campus walking pace. Used for the ETA and for the simulator.
export const WALK_FEET_PER_SEC = 4.6;
// How close you must get before a maneuver is considered done, in km.
export const MANEUVER_REACHED_KM = 25 / FEET_PER_KM;
export const ARRIVED_FEET = 25;
export const SIM_TICK_MS = 200;
export const SIM_SPEED = 4;
// How far up the route the camera aims. Clamped to the next maneuver, so this
// only controls heading stability on long straights, never turn timing.
export const LOOK_AHEAD_KM = 60 / FEET_PER_KM;
export const MIN_AIM_KM = 8 / FEET_PER_KM;
// Banner transition timing, in ms.
// Must match --banner-swap in input.css: it is how long both signs are on
// screen together before the outgoing one is removed from the DOM.
export const BANNER_SWAP_MS = 320;
// Metres in a degree of latitude on the sphere turf measures the route on, so
// the flat sums in `snapBetween` agree with `route.cumulative`.
const METRES_PER_DEGREE = (Math.PI * 6_371_008.8) / 180;

// How a GPS fix becomes progress along the route. `moved` applies the first
// before anything else sees the fix; `track` reads the rest, and is where each
// is explained. Giving a corner back is `advanceSteps`' and `stepAt`'s.
//
// A fix whose own accuracy circle is wider than this is not used for progress
// at all: 35 m is wider than most of the campus's walkways are apart, so a fix
// that vague cannot say which one you are on.
export const MAX_ACCURACY_M = 35;
// The window a fix is snapped inside: from a little way short of the FURTHEST
// you have been believed, so standing still in noise does not ratchet you
// forward, to a SHORT way ahead of where you were last — about ten seconds'
// walk. The back end hangs off the furthest point rather than the last one so
// that a run of fixes pulled the same way cannot walk you backward without
// limit: at a hairpin, every fix on the way home is a few metres from the way
// out, and a window that slid back with each of them slid you all the way
// down the wrong leg. For the same reason it never reaches back across more
// than one corner (see `cornerBefore`). The front is short on purpose. It used to reach sixty
// metres, and wider still for a poor fix, and at the bottom of a U sixty
// metres up the route is the way home, twenty metres beside you: one fix
// drifted ten metres toward it was nearer that than the path you were on, and
// both corners went at once. Nor does it widen with a poor fix — a vague fix
// is as likely to be beside you as ahead of you, and what grows with accuracy
// is how poor a fit is forgiven (SNAP_FIT_M, below).
//
// A walker who outpaces the window is not held at its end. A fix past it fits
// the window, if at all, only at its very front; one further past — a jog, or
// a phone that reports every twenty seconds — fits nowhere inside it, and
// used to wait for JUMP_FIXES to agree like any leap: two fixes in every three
// standing still. So either is followed up the line, to wherever it fits
// better, as far as the walk could have got since the last fix that was
// believed: SNAP_PACE_MPS for every second of it, and SNAP_AHEAD_M over. A fix
// with no time on it — the simulator's, and the tests' — is followed up to
// SNAP_CATCH_UP_M. See `track`.
export const SNAP_BEHIND_M = 30;
export const SNAP_AHEAD_M = 15;
export const SNAP_CATCH_UP_M = 45;
export const SNAP_PACE_MPS = 3;
// A fix that fits the window this well, or within its own accuracy if that is
// wider, is believed where the window puts it — a fix that sits nicely on the
// stretch you are walking has no reason to be read as anywhere else. A worse
// fit with a better place for it outside the window is a candidate LEAP — as
// is a fit the window only manages by walking you backward, which is the
// wrong leg (WRONG_LEG_M) — believed only once JUMP_FIXES in a row agree on
// it, and only if it is a leap a walker could have made: see LEAP_DETOUR.
//
// Two candidates agree when the second is no more than JUMP_AGREE_M behind the
// first, and no further ahead of it than the walk between the two fixes could
// have carried you (LEAP_DETOUR times as far as the fixes are apart, and
// JUMP_AGREE_M over). Fixes made standing still agree; so do fixes sixty
// metres apart from a jogger with a slow phone, which a fixed distance either
// way never let agree; a stray and the fix that comes back from it do not.
export const SNAP_FIT_M = 15;
export const JUMP_FIXES = 3;
export const JUMP_AGREE_M = 20;
// How much longer than a straight line a walk between two places on the route
// may be. A leap further along the route than LEAP_DETOUR times as far as the
// fix is from where you were believed, and SNAP_FIT_M over — or from the
// furthest you have been — is not a leap but an ambiguity — the
// door of a U twenty metres from its start is two hundred and sixty metres
// along it, and a fix twenty metres north of the start is not someone who
// walked those two hundred and sixty. Twice is generous for a walk round a
// corner or two, and nowhere near a walk that doubles back.
export const LEAP_DETOUR = 2;
// How much better a place further along has to fit than the window's before a
// believed position sliding backward is taken for the wrong leg. See `track`.
export const WRONG_LEG_M = 5;
// Further than this from every part of the line, this many fixes running, and
// you have left the route rather than wobbled off it — once you have been on
// it. On the way to it from an off-network start the measure is different;
// see `track`.
export const OFF_ROUTE_M = 40;
export const OFF_ROUTE_FIXES = 3;
// How much further short of a corner than where its sign was retired — a
// stride short of it, MANEUVER_REACHED_KM — you have to be before the sign
// comes back. At least this, and the fix's own accuracy if that is wider, so
// that a corner is not retired and restored on alternate fixes while you
// stand at it in noise; but never more than half of SNAP_BEHIND_M, or the
// window could not reach back far enough to give it, and never more than
// half the leg before that corner, or on a short leg a walker who belongs on
// it could never get far enough back. See `stepAt`. And it takes
// GIVE_BACK_FIXES in a row to do it; see `advanceSteps`.
export const GIVE_BACK_M = 10;
export const GIVE_BACK_FIXES = 3;

/**
 * @param {object} deps
 * @param {object} deps.map          the Mapbox map; navigation drives its camera
 * @param {object} deps.route        the createRoute() holder — read, never written
 * @param {object} deps.geolocation  createGeolocation(), for the virtual fixture
 * @param {object} deps.dom          the banner's elements, looked up once by the caller
 * @param {object} deps.buildings    { add, remove } — the extrusions, which are navigation-only
 * @param {Function} deps.onStart    chrome to put away before the walk begins
 * @param {Function} deps.restCamera where to leave the camera when the walk ends
 * @param {Function} deps.releaseCameraLock  hand the camera back from the locate control
 * @param {Function} deps.makeUserDot  build the marker that shows where you are
 */
export function createNavigation({
  map,
  route,
  geolocation,
  dom,
  buildings,
  onStart,
  restCamera,
  releaseCameraLock,
  makeUserDot,
}) {
  let active = false;
  let stepIndex = 0;
  let lastBearing = 0;
  let userMarker = null;

  // Progress, as `track` keeps it. `lastAlong` is how far along the route the
  // last believed fix put the walker, in km, `lastHere` that point on the line
  // and `lastTime` the fix's time, when it had one; `furthest`, with its own
  // point and time, is the furthest along any believed fix has put them since
  // the last leap. `jump` is a run of fixes that all say you are somewhere
  // other than where the window puts you, waiting to be agreed with; the next
  // two count fixes that are nowhere near the line. `joined` is whether any
  // fix has yet been on the line at all, and until one has, `approachM` is the
  // nearest one has come — see `track`. `placed` is whether one has been
  // believed anywhere on it yet.
  let lastAlong = 0;
  let lastHere = null;
  let lastTime = null;
  let furthest = 0;
  let furthestHere = null;
  let furthestTime = null;
  let jump = null;
  let offRouteFixes = 0;
  let offRoute = false;
  let joined = false;
  let approachM = Infinity;
  let placed = false;
  // Which way (+1, -1) the last fixes wanted the sign moved, when they wanted
  // it moved at all, and how many in a row have — waiting for enough of them
  // to say the same. See `advanceSteps`.
  let pendingWay = 0;
  let pendingFixes = 0;
  // Whether the sign is saying "Arrived". See `renderBanner`.
  let hasArrived = false;
  // Set when the live sign has been written over by the off-route warning and
  // has to be painted whole the next time it is painted at all — the countdown
  // between turns only ever touches the distance.
  let signStale = false;

  let simTimer = null;
  let simAlong = 0;

  // The banner's own state machine. `renderedStep` is which sign is showing,
  // `bannerBusy` whether a swap is mid-flight, `liveCard` the one that owns the
  // countdown, and `bannerTimers` the removals still pending.
  let renderedStep = -1;
  let bannerBusy = false;
  let bannerTimers = [];
  let liveCard = null;

  function start({ simulate = false } = {}) {
    if (!route.isWalkable) return;

    active = true;
    // Counted straight past `depart`, which sits at distance zero and so is
    // behind you the moment you set off, rather than waiting the second fix
    // `advanceSteps` would ask for: there is nothing to doubt about where a
    // walk starts.
    stepIndex = stepAt(0, 0);
    pendingWay = 0;
    pendingFixes = 0;
    hasArrived = false;
    lastAlong = 0;
    lastHere = route.coords[0];
    lastTime = null;
    furthest = 0;
    furthestHere = route.coords[0];
    furthestTime = null;
    jump = null;
    offRouteFixes = 0;
    offRoute = false;
    signStale = false;
    resetBannerAnimation();
    buildings.add();
    // The legend goes with the rest of the chrome here, and an outline with
    // nothing left on screen explaining it is just a purple campus. Same for a
    // lifted pin, whose card would float over the turn banner.
    onStart();

    document.body.classList.add('navigating');
    // Published so the sign can tell a simulated walk from a real one: the grid
    // behind it runs at double speed and gains a second, stationary layer to
    // drift against. See body.simulating in src/input.css.
    document.body.classList.toggle('simulating', simulate);
    dom.sidePanel.classList.add('hidden');
    dom.banner.classList.remove('hidden');
    dom.footer.classList.remove('hidden');
    map.resize();

    const coords = route.coords;

    // With the virtual location on, the control's blue dot IS the position —
    // same argument as the start pin, and the same answer: ours would be a
    // second dot sitting on the first. Removed rather than skipped, so a walk
    // begun with the fixture off and resumed with it on does not leave one
    // behind.
    if (geolocation.fixture) {
      userMarker?.remove();
    } else {
      if (!userMarker) userMarker = makeUserDot();
      userMarker.setLngLat(coords[0]).addTo(map);
    }

    // The locate control recentres on every fix while it holds the camera, and
    // navigation has a camera of its own — pitched to 60, zoomed in and turned
    // to face the walk. Dropping the control to background is the one gesture
    // that keeps the dot live and gives the camera up; it is what pressing its
    // button while locked on does.
    releaseCameraLock();

    moved(coords[0], { duration: 900 });
    // That was the route's own first point, there to put the first sign up
    // and the camera on the line — not a fix. Where the walker is has not been
    // heard yet, and it may be well short of the line; see `track`.
    joined = false;
    approachM = Infinity;
    placed = false;

    if (simulate) startSimulation();
  }

  function end() {
    stopSimulation();
    if (!active) return;
    active = false;
    resetBannerAnimation();

    document.body.classList.remove('navigating');
    document.body.classList.remove('simulating');
    dom.sidePanel.classList.remove('hidden');
    dom.banner.classList.add('hidden');
    dom.footer.classList.add('hidden');
    if (userMarker) userMarker.remove();
    buildings.remove();
    map.resize();

    // Flatten the pitched navigation camera and frame the whole campus again.
    restCamera();
  }

  /**
   * Fold a new position into the navigation state. Position is snapped onto the
   * route line rather than to a network vertex — snapping to vertices would
   * make the dot jump between path endpoints instead of sliding along. Where
   * on the line, and whether the fix is believed at all, is `track`'s call.
   *
   * `accuracy` is the fix's own radius in metres, as the Geolocation API gives
   * it. Left out it means exact, which is what the simulator's positions are:
   * they were taken off the line in the first place. `timestamp` is the fix's
   * own time in ms, also as the API gives it; left out, `track` cannot say how
   * far you could have walked since the last fix, and assumes no further than
   * SNAP_CATCH_UP_M.
   */
  function moved(coords, { duration = SIM_TICK_MS, accuracy = 0, timestamp } = {}) {
    if (!active || !route.isWalkable) return;

    const accuracyM = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0;
    // Too vague to say where on the route you are, so it says nothing. The
    // blue dot still moves — it is the locate control's, drawn from the fix
    // itself rather than from here — and the next good fix carries on from
    // the last believed one.
    if (accuracyM > MAX_ACCURACY_M) return;

    const fix = track(coords, accuracyM, Number.isFinite(timestamp) ? timestamp : null);
    // Off the route — or back near it, but somewhere `track` will not put you
    // until a few fixes agree, which is where a shortcut that rejoins further
    // on comes back. The second case used to fall through to "moves nothing",
    // and with the warning still up that froze it: the sign kept its last
    // distance and the camera stopped following, for a fix or two with no
    // word of either. So the warning keeps counting down to the line until a
    // place on it is believed and the sign is painted whole again — and once
    // the fix is ON the line, it stops telling you to head back to it, which
    // at "0 ft" is not a thing anyone can do.
    if (fix.offRoute || (!fix.snapped && signStale)) {
      if (fix.offRoute || fix.missM > Math.max(SNAP_FIT_M, accuracyM)) warnOffRoute(fix.missM);
      else warnRejoining();
      // Follow the walker, not the line they have left: a camera parked on
      // the route would watch the blue dot walk off the edge of the screen.
      ease(coords, duration);
      return;
    }
    // Still on the way to the line from wherever the walk was asked from — or
    // on it, but somewhere further along than the start, where `track` will
    // not put you until a few fixes agree. The first sign stays up, counting
    // from the start of the line, and the camera follows the walker toward
    // it: until a fix has been believed somewhere on the line there is no
    // place on it for the camera to wait at.
    if (fix.approaching || (!fix.snapped && !placed)) {
      ease(coords, duration);
      return;
    }
    if (!fix.snapped) return;

    const { distanceAlong, here, leapt } = fix.snapped;   // km travelled so far
    const slackM = Math.min(Math.max(GIVE_BACK_M, accuracyM), SNAP_BEHIND_M / 2);
    advanceSteps(distanceAlong, slackM);
    renderBanner(distanceAlong, { mayArrive: !leapt, slackM });
    moveCamera(here, distanceAlong, duration);
  }

  /**
   * Where on the route a fix puts you — or that it puts you nowhere yet.
   *
   * THIS USED TO BE ONE CALL: the nearest point on the whole line, taken as
   * gospel. On a walk that doubles back — out along one side of a quad and home
   * along the other, twenty metres apart — a fix ten metres the wrong way at
   * the start is nearer the return leg than the outbound one, and the nearest
   * point is then most of the way to the door. `advanceSteps` only ever counted
   * up, so every corner in between was retired for good, and a phone held
   * still at the start could read "Arrived". Campus GPS between buildings is
   * out by that much routinely.
   *
   * So a fix is snapped inside a WINDOW around where you were last — a little
   * behind, a short way ahead — rather than to the whole line. Progress can
   * still slide back a few steps in noise, and near a corner a fix can still
   * put you a few metres round it early; but one fix cannot carry you further
   * up the route than SNAP_AHEAD_M past the last believed one, however near
   * the line it passes there — or, for a fix that is past the window or fits
   * nothing inside it, further than you could have walked since
   * (SNAP_PACE_MPS), or SNAP_CATCH_UP_M for a fix with no time on it. That is
   * the whole of the guarantee, and it is why the window is short: the first
   * version reached sixty metres ahead and took the plain nearest point inside
   * it, and at the bottom of a U the way home is inside sixty metres — one fix
   * drifted ten metres toward it retired both corners.
   *
   * NOR IS IT THE PLAIN NEAREST POINT INSIDE THE WINDOW. Where the window
   * holds two stretches of path a few metres apart — the two sides of a jog,
   * the two legs of a hairpin — the nearest of them is a coin toss in noise,
   * and the wrong one is a corner away along the route. So each place in the
   * window is scored by how far it is from the fix PLUS however much further
   * along the route it is from where you were than it, or the fix, is from
   * there in a straight line. A fix three metres from where you were cannot
   * be you having walked forty metres round a bend; a fix forty metres away
   * can.
   * Along a straight the two agree and the score is the plain distance.
   *
   * The Geolocation API's own accuracy decides how poor a fit is forgiven, and
   * a fix too vague to be used at all never gets here (see `moved`).
   *
   * A REAL LEAP still happens — the radio lost under a roof for a minute, or a
   * shortcut across a lawn — and the window alone would hold you at its edge
   * for ever. It is believed when the window's best fit is poor (or the
   * window is walking you backward — the wrong leg, below), the whole line
   * has a better one outside it, JUMP_FIXES fixes in a row agree on roughly
   * where, and it is a leap a walker could have made: no more than
   * LEAP_DETOUR times as far along the route as the fix is from where you
   * were, or from the furthest you have been, and no further than
   * SNAP_PACE_MPS would carry you in the time since. A "leap" that fails
   * that — the door of a U, twenty metres north of a phone still at its
   * start — is the window's to place, poor fit or not. Until a leap is
   * agreed, a fix the window fits poorly moves nothing: one bad fix is not a
   * reason to move, let alone to move sixty metres toward it. And a leap
   * never arrives —
   * arriving is for a walker the window has carried to the door (see
   * `renderBanner`).
   *
   * And a fix that is nowhere near ANY of the line, OFF_ROUTE_FIXES times
   * running, is a walker who has left the route; the sign says so rather than
   * counting down to a corner they are not walking toward.
   *
   * EXCEPT ON THE WAY TO IT. The line starts where the walk joins the network,
   * and a walk may be asked for from anywhere within REACH_M of the network
   * (src/directions.js) — three hundred metres, against OFF_ROUTE_M's forty.
   * Measured from the line, every fix on the way from the car park to its
   * first point said "left the route", and the sign said so from the first
   * stride. So until a fix has come ONTO the line — within the fit a snap
   * forgives, not merely inside OFF_ROUTE_M, or a walker hovering round forty
   * metres out would join on one fix and leave on the next three — a walker is
   * APPROACHING it: the fix places nobody on the route — a fix a hundred
   * metres beside its middle is not a walker at its middle — and is off the
   * route only when it is OFF_ROUTE_M further from the line than the nearest
   * the walk has come, which is walking away from it. The fix's own accuracy
   * widens that, because the nearest the walk has come is itself the
   * luckiest of a run of noisy fixes.
   *
   * `missM`, how far the fix is from the nearest part of the whole line, comes
   * back every time, so the off-route sign can keep counting it down while a
   * walker who has come back waits for a leap to be agreed.
   */
  function track(coords, accuracyM, time) {
    const whole = nearestPointOnLine(route.line, point(coords));
    const missM = whole.properties.dist * 1000;
    const nearM = Math.max(OFF_ROUTE_M, accuracyM);
    const fitM = Math.max(SNAP_FIT_M, accuracyM);
    if (!joined) approachM = Math.min(approachM, missM);

    if (missM > nearM + (joined ? 0 : approachM + accuracyM)) {
      jump = null;
      offRouteFixes++;
      if (offRouteFixes >= OFF_ROUTE_FIXES) offRoute = true;
      return { offRoute, missM, snapped: null };
    }
    offRouteFixes = 0;
    if (offRoute) {
      offRoute = false;
      signStale = true;
    }
    if (!joined) {
      if (missM > fitM) return { offRoute: false, missM, snapped: null, approaching: true };
      joined = true;
    }

    // How far the fix is from where you were believed, and how long since.
    const straightM = distance(point(lastHere), point(coords)) * 1000;
    const sinceS = time !== null && lastTime !== null ? Math.max(0, (time - lastTime) / 1000) : null;

    const lo = Math.max(0, furthest - SNAP_BEHIND_M / 1000, cornerBefore(furthest));
    const hi = Math.min(route.totalKm, lastAlong + SNAP_AHEAD_M / 1000);
    let near = snapBetween(coords, lo, hi, straightM);

    // Run off the front of the window, or fitting nothing in it: followed up
    // the line, if it is on the line there (see SNAP_PACE_MPS). A fix the
    // window could only put at its very front end is past it, and is taken
    // wherever further on fits it better; that is what keeps a walker with
    // sparse fixes from falling a window behind on every one. A fix that
    // fits nothing in the window but is not past it — beside the path you
    // are on, at the bottom of a U — goes further on only if that is the
    // easier place to explain, by the same score the window used: the way
    // home twenty metres beside you is not.
    const reachM = sinceS === null ? SNAP_CATCH_UP_M : SNAP_AHEAD_M + sinceS * SNAP_PACE_MPS;
    const reach = Math.min(route.totalKm, lastAlong + reachM / 1000);
    const atFront = hi - near.location < 1e-6;
    if ((near.dist > fitM || atFront) && reach > hi) {
      const further = snapBetween(coords, hi, reach, straightM);
      const better = further.score < near.score || (atFront && further.dist < near.dist);
      if (further.dist <= fitM && better) near = further;
    }

    // A leap is looked for in two cases. The plain one: the window fits the
    // fix poorly and the line somewhere else fits it better. And the WRONG
    // LEG: the window still fits, but only by putting you SNAP_AHEAD_M or more
    // behind the furthest you have been, while a place further on fits
    // WRONG_LEG_M better. That is what being on the wrong side of a hairpin
    // looks like — every fix on the way home is a few metres from the way
    // out, the window can always place it there, and each one walks you a
    // little further backward along it. Walkers walk forward; a believed
    // position that walks backward, with the line ahead fitting better all
    // the while, is the GPS that put you on the wrong leg, and it needs the
    // same JUMP_FIXES to agree as any other leap before it is put right.
    const wholeKm = whole.properties.location;
    const poor = near.dist > fitM;
    const outside = wholeKm < lo || wholeKm > hi;
    const astray =
      !poor &&
      furthest - near.location >= SNAP_AHEAD_M / 1000 &&
      wholeKm - near.location >= SNAP_AHEAD_M / 1000 &&
      missM + WRONG_LEG_M < near.dist;
    if (((poor && outside) || astray) && couldWalk(wholeKm, coords, time)) {
      const count = jump && agrees(jump, wholeKm, coords) ? jump.count + 1 : 1;
      jump = { km: wholeKm, at: coords, count };
      if (count >= JUMP_FIXES) {
        // The run is kept, not cleared: a jogger whose every fix is beyond
        // the window carries on agreeing with it, and is followed a fix at a
        // time rather than held for JUMP_FIXES more at each. The first fix
        // the window can place ends it.
        believe(wholeKm, whole.geometry.coordinates, time);
        furthest = wholeKm;
        furthestHere = lastHere;
        furthestTime = time;
        // A leap BACK has to give back the corners it passed, or the sign
        // would keep pointing at one you are now behind. Counting up again
        // from the start gives the same answer as before for a leap forward.
        // Done here, at once, rather than left to `advanceSteps`: it moves
        // the sign a corner at a time and waits for a second fix, and a leap
        // has already had JUMP_FIXES agree on it.
        stepIndex = stepAt(0, wholeKm);
        pendingWay = 0;
        pendingFixes = 0;
        return {
          offRoute: false,
          missM,
          snapped: { distanceAlong: wholeKm, here: whole.geometry.coordinates, leapt: true },
        };
      }
      // Waiting to be agreed with. A poor fit moves nothing meanwhile; a fix
      // the window still fits is believed there, as it would have been.
      if (poor) return { offRoute: false, missM, snapped: null };
    } else {
      jump = null;
    }

    believe(near.location, near.here, time);
    if (near.location > furthest) {
      furthest = near.location;
      furthestHere = near.here;
      furthestTime = time;
    }
    return { offRoute: false, missM, snapped: { distanceAlong: near.location, here: near.here } };
  }

  /**
   * How far back the window may reach from `km`: across the last corner
   * before it, but not the one before that. A fix pulled back round one
   * corner is a corner retired early being given back; pulled round two, it
   * is the GPS putting you on another leg altogether — the way out of a U you
   * are walking home along — and that is a leap, for JUMP_FIXES to agree on.
   */
  function cornerBefore(km) {
    for (let i = route.maneuvers.length - 1; i >= 1; i--) {
      if (route.maneuverKm(i) <= km) return route.maneuverKm(i - 1);
    }
    return 0;
  }

  function believe(km, here, time) {
    lastAlong = km;
    lastHere = here;
    lastTime = time;
    placed = true;
  }

  /**
   * Whether a walker could have got to `km` km along the route, where the fix
   * at `coords` puts them, from where they were last believed or from the
   * furthest they have been — the second because on the wrong leg of a
   * hairpin the first has been sliding backward, and from there the right
   * leg looks further away than it is. From either: no more than LEAP_DETOUR
   * times as far along the route as the fix is from there in a straight
   * line, and — when the fixes carry their times — no further than
   * SNAP_PACE_MPS would take them since, with SNAP_AHEAD_M over.
   */
  function couldWalk(km, coords, time) {
    return [
      [lastAlong, lastHere, lastTime],
      [furthest, furthestHere, furthestTime],
    ].some(([fromKm, here, when]) => {
      const alongM = Math.abs(km - fromKm) * 1000;
      const straightM = distance(point(here), point(coords)) * 1000;
      if (alongM > LEAP_DETOUR * straightM + SNAP_FIT_M) return false;
      if (time === null || when === null) return true;
      return alongM <= SNAP_AHEAD_M + (Math.max(0, time - when) / 1000) * SNAP_PACE_MPS;
    });
  }

  /** Whether a leap to `km` agrees with the run `run` so far. See JUMP_AGREE_M. */
  function agrees(run, km, coords) {
    const stepM = (km - run.km) * 1000;
    const apartM = distance(point(run.at), point(coords)) * 1000;
    return stepM >= -JUMP_AGREE_M && stepM <= LEAP_DETOUR * apartM + JUMP_AGREE_M;
  }

  /**
   * The best place for the fix at `coords` on the part of the route between
   * `lo` and `hi` km along it, with `location` measured from the start of the
   * whole route, `dist` how far it is from the fix in metres and `score` what
   * it was chosen by — see `track`. `straightM` is how far the fix is from
   * where you were believed.
   *
   * Every segment of the route that overlaps the stretch is a candidate,
   * measured on a flat projection around the fix — at the size of a campus
   * the curve of the earth is centimetres. The point on it is interpolated
   * between the segment's own ends, so `location` agrees with
   * `route.cumulative` exactly.
   */
  function snapBetween(coords, lo, hi, straightM) {
    const { coords: line, cumulative } = route;
    const metresPerLon = METRES_PER_DEGREE * Math.cos((coords[1] * Math.PI) / 180);
    const flat = ([lon, lat]) => [(lon - coords[0]) * metresPerLon, (lat - coords[1]) * METRES_PER_DEGREE];
    const [lx, ly] = flat(lastHere);

    let best = null;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = cumulative[i];
      const b = cumulative[i + 1];
      if (b < lo || a > hi) continue;
      const span = b - a;
      const t0 = span > 0 ? Math.max(0, (lo - a) / span) : 0;
      const t1 = span > 0 ? Math.min(1, (hi - a) / span) : 0;
      const [ax, ay] = flat(line[i]);
      const [bx, by] = flat(line[i + 1]);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      // The fix sits at the origin of the projection.
      const t = Math.min(t1, Math.max(t0, len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0));
      const dist = Math.hypot(ax + t * dx, ay + t * dy);
      const location = a + t * span;
      const here = [
        line[i][0] + t * (line[i + 1][0] - line[i][0]),
        line[i][1] + t * (line[i + 1][1] - line[i][1]),
      ];
      const [hx, hy] = flat(here);
      const apartM = Math.max(straightM, Math.hypot(hx - lx, hy - ly));
      const detourM = Math.abs(location - lastAlong) * 1000 - apartM;
      const score = dist + Math.max(0, detourM);
      if (best === null || score < best.score) best = { location, dist, score, here };
    }
    return best;
  }

  /**
   * Off the route: the live sign says so, and how far away the line is.
   *
   * Painted over the sign that is up rather than swapped in as a step of its
   * own — this is not a maneuver, and the corner you were walking toward is
   * still the corner once you are back. `signStale` makes sure the next paint
   * puts it back whole.
   */
  function warnOffRoute(missM) {
    if (!liveCard) return;
    signStale = true;
    liveCard.arrow.innerHTML = maneuverIcon('uturn');
    liveCard.distance.textContent = niceFeet((missM / 1000) * FEET_PER_KM);
    liveCard.instruction.textContent = 'Head back to the route';
  }

  /**
   * Back on the line after being off it, somewhere `track` is still waiting
   * for JUMP_FIXES fixes to agree on. There is no distance to give —
   * the line is where you are — and the corner the sign showed may be
   * behind you now, so it says only what is true.
   */
  function warnRejoining() {
    if (!liveCard) return;
    signStale = true;
    liveCard.arrow.innerHTML = maneuverIcon('straight');
    liveCard.distance.textContent = '';
    liveCard.instruction.textContent = 'Rejoining the route';
  }

  /**
   * Retire every maneuver we have already walked past — and give back one we
   * are now well short of. A corner at a time, and only once two fixes in a
   * row say so — three to give one back — unless the fix is past the corner
   * itself.
   *
   * This used to only count up, on every fix, which made every mistake
   * permanent: a corner retired by one fix stayed retired however far back the
   * next fixes put you. The window in `track` keeps such mistakes to a few
   * metres round a corner, but at the bottom of a U a few metres round the
   * first corner is the second one too, and a single fix drifted onto the
   * short leg between them took both. So:
   *
   *   - A sign turns over once a second fix wants it too. On foot that is a
   *     stride or so, and the sign still turns over a few metres before the
   *     corner; one stray fix no longer turns it at all. A fix
   *     that puts you past the corner itself turns it on its own, though: a
   *     phone that reports every thirty metres is not jittering, and waiting
   *     for its next fix kept the sign on a corner you were thirty metres past.
   *   - It moves ONE corner at a time, however many the fix has put behind
   *     you. Two fixes that both landed round the second of two close corners
   *     used to take both, and the first one's turn was never shown; now
   *     every sign is up for at least one fix, and it takes another fix past
   *     the corner, or another pair, to move on.
   *   - A corner is given back once GIVE_BACK_FIXES fixes in a row put you
   *     far enough short of where it was retired — see GIVE_BACK_M and
   *     `stepAt` — that a walker standing at a corner in noise does not see
   *     it come and go, while the walker the GPS misplaced gets the sign back
   *     on the path they are on. A third fix rather than a second, because
   *     the sign flipping back and forth at a corner you are waiting at is
   *     worse than it coming back a second later. `depart` never comes back:
   *     it is behind you wherever you are.
   */
  function advanceSteps(distanceAlong, slackM) {
    const due = stepAt(stepIndex, distanceAlong, slackM);
    if (due === stepIndex) {
      pendingWay = 0;
      pendingFixes = 0;
      return;
    }
    const way = due > stepIndex ? 1 : -1;
    pendingFixes = pendingWay === way ? pendingFixes + 1 : 1;
    pendingWay = way;
    const needed = way > 0 ? (distanceAlong >= route.maneuverKm(stepIndex) ? 1 : 2) : GIVE_BACK_FIXES;
    if (pendingFixes < needed) return;
    stepIndex += way;
    pendingWay = 0;
    pendingFixes = 0;
  }

  /**
   * Which maneuver the sign should be counting down to at `distanceAlong` km,
   * counted from `from`: back while you are `slackM` metres short of where the
   * one before it was retired, then up past every one within
   * MANEUVER_REACHED_KM. From 0 it is simply the right step for that point on
   * the route.
   *
   * The slack is capped at half the leg that leads to the corner being given
   * back. On a jog whose middle leg is eight metres, the whole of the stretch
   * where that leg's sign belongs is less than ten metres short of where it is
   * retired; a slack of ten put a walker on it out of reach of the sign that
   * was theirs.
   */
  function stepAt(from, distanceAlong, slackM = GIVE_BACK_M) {
    let i = from;
    while (i > 1) {
      const corner = route.maneuverKm(i - 1);
      const legKm = corner - route.maneuverKm(i - 2);
      const backKm = Math.min(slackM / 1000, legKm / 2);
      if (distanceAlong >= corner - MANEUVER_REACHED_KM - backKm) break;
      i--;
    }
    while (i < route.maneuvers.length - 1 && route.maneuverKm(i) - distanceAlong < MANEUVER_REACHED_KM) {
      i++;
    }
    return i;
  }

  function clearBannerTimers() {
    bannerTimers.forEach(clearTimeout);
    bannerTimers = [];
  }

  function resetBannerAnimation() {
    clearBannerTimers();
    dom.stack.replaceChildren();
    liveCard = null;
    bannerBusy = false;
    renderedStep = -1;
  }

  /** One complete sign, cloned from the template. Each carries its own End. */
  function createSignCard() {
    const el = dom.signTemplate.content.firstElementChild.cloneNode(true);
    el.querySelector('.nav-exit').addEventListener('click', end);
    return {
      el,
      arrow: el.querySelector('.nav-arrow'),
      distance: el.querySelector('.nav-distance'),
      instruction: el.querySelector('.nav-instruction'),
      arrived: false,
    };
  }

  function paintStep(card, step, feetToStep, arrived) {
    card.arrived = arrived;
    card.arrow.innerHTML = maneuverIcon(step.type);
    if (arrived) {
      card.distance.textContent = 'Arrived';
      card.instruction.textContent = 'You have reached your destination';
    } else {
      card.distance.textContent = niceFeet(feetToStep);
      card.instruction.textContent = instructionFor(step.type);
    }
  }

  /**
   * Build a whole new sign and run it in from the left while the finished one
   * runs out to the right — both at once, so two complete banners are on screen
   * for the length of the swap.
   */
  function swapStep(step, feetToStep, arrived, isFirst) {
    clearBannerTimers();
    // Clearing the timers also cancelled whatever removal was pending, so any
    // sign still mid-exit has to be swept up here or it leaks into the DOM.
    dom.stack.querySelectorAll('.nav-sign--out').forEach((stale) => stale.remove());

    const incoming = createSignCard();
    paintStep(incoming, step, feetToStep, arrived);

    const outgoing = isFirst ? null : liveCard;
    if (outgoing) {
      // Taking it out of flow lets the incoming card land in the same box.
      outgoing.el.classList.remove('nav-sign--in', 'nav-sign--first');
      outgoing.el.classList.add('nav-sign--out');
    }

    incoming.el.classList.add(outgoing ? 'nav-sign--in' : 'nav-sign--first');
    dom.stack.appendChild(incoming.el);
    liveCard = incoming;
    bannerBusy = true;

    bannerTimers.push(setTimeout(() => {
      if (outgoing) outgoing.el.remove();
      incoming.el.classList.remove('nav-sign--in', 'nav-sign--first');
      bannerBusy = false;
    }, BANNER_SWAP_MS));
  }

  /**
   * Put the sign and the footer in step with `distanceAlong`.
   *
   * "Arrived" holds once it is said. Standing at the door in noise, fixes
   * either side of ARRIVED_FEET used to take it down and put it back, and
   * taking it down changed only the distance, so the sign read "50 ft | You
   * have reached your destination". Now it is unsaid only by a fix `slackM`
   * further back than that — the slack a corner is given back with — and the
   * whole sign is painted when it is. It is never said by a fix `track`
   * believed as a leap (`mayArrive`): arriving is for a walker the window has
   * carried to the door, not for three fixes that agreed on it.
   */
  function renderBanner(distanceAlong, { mayArrive = true, slackM = GIVE_BACK_M } = {}) {
    const totalKm = route.totalKm;
    const step = route.maneuvers[stepIndex];

    const feetToStep = Math.max(0, (route.maneuverKm(stepIndex) - distanceAlong) * FEET_PER_KM);
    const feetRemaining = Math.max(0, (totalKm - distanceAlong) * FEET_PER_KM);
    const doorFeet = ARRIVED_FEET + (hasArrived ? (slackM / 1000) * FEET_PER_KM : 0);
    hasArrived = feetRemaining <= doorFeet && (mayArrive || hasArrived);
    const arrived = hasArrived;

    if (arrived) stopSimulation();

    if (stepIndex !== renderedStep) {
      const isFirst = renderedStep === -1;
      renderedStep = stepIndex;
      signStale = false;          // the new sign is painted whole anyway
      swapStep(step, feetToStep, arrived, isFirst);
    } else if (liveCard && signStale) {
      // The off-route warning wrote over the sign, and you are back: take it
      // down whole, mid-swap or not — it went up without waiting either.
      paintStep(liveCard, step, feetToStep, arrived);
      signStale = false;
    } else if (!bannerBusy && liveCard) {
      // Between turns only the countdown moves — never re-run the animation —
      // unless the sign is saying it has arrived, or has to stop saying so.
      if (arrived || liveCard.arrived) paintStep(liveCard, step, feetToStep, arrived);
      else liveCard.distance.textContent = niceFeet(feetToStep);
    }

    dom.remaining.textContent = niceFeet(feetRemaining);
    const minutes = feetRemaining / WALK_FEET_PER_SEC / 60;
    dom.eta.textContent = minutes < 1 ? '< 1 min' : `${Math.round(minutes)} min`;
  }

  function moveCamera(here, distanceAlong, duration) {
    // Aim a short way up the route so the heading is stable, but never past the
    // maneuver we are walking toward — looking beyond the corner would start
    // swinging the camera while you are still travelling straight at it.
    const lookAheadKm = aimKm(distanceAlong);

    // Within a stride of the corner the aim point collapses onto us and the
    // bearing goes unstable, so hold the last good one until the step flips.
    if (lookAheadKm - distanceAlong > MIN_AIM_KM) {
      const ahead = along(route.line, lookAheadKm);
      lastBearing = bearing(point(here), ahead);
    }

    ease(here, duration);
  }

  /** The walking camera: centred on `here`, facing the last good bearing. */
  function ease(here, duration) {
    map.easeTo({
      center: here,
      zoom: 18.5,
      pitch: 60,
      bearing: lastBearing,
      duration,
      essential: true,
    });
  }

  /** Where the camera looks from `distanceAlong`, in km along the route. */
  function aimKm(distanceAlong) {
    return Math.min(distanceAlong + LOOK_AHEAD_KM, route.maneuverKm(stepIndex), route.totalKm);
  }

  // -------------------------------------------------------------------------
  // Simulator — walk the route without leaving your desk
  // -------------------------------------------------------------------------

  /**
   * Walk the route.
   *
   * TWO WAYS THROUGH, and which one runs is decided by whether the virtual
   * location is standing in for the GPS.
   *
   *   WITH THE FIXTURE ON, this moves the FIXTURE and nothing else. The
   *   geolocation object delivers the new position to the watch the control
   *   already has open, the control fires its own `geolocate`, and that is what
   *   advances the navigation — so the blue dot, the accuracy ring and the
   *   heading wedge move because the position they are drawn from moved. This is
   *   what the fixture is for: from inside the control nothing about the walk is
   *   made up. It is also the only arrangement where there is ONE dot on the
   *   screen rather than a stationary blue one and a moving grey one.
   *
   *   WITHOUT IT there is no fix to move, so the marker is driven directly, as
   *   it always was.
   *
   * The fixture is left wherever the walk ended rather than being put back. You
   * walked there; a route started afterwards should start from where you are.
   * Toggling the switch off and on again returns it to the centre of campus.
   */
  function startSimulation() {
    stopSimulation();
    simAlong = 0;
    const totalKm = route.totalKm;
    const perTickKm =
      (WALK_FEET_PER_SEC * SIM_SPEED * (SIM_TICK_MS / 1000)) / FEET_PER_KM;
    const viaFixture = Boolean(geolocation.fixture);

    simTimer = setInterval(() => {
      simAlong = Math.min(simAlong + perTickKm, totalKm);
      const position = along(route.line, simAlong).geometry.coordinates;
      if (viaFixture) {
        // The wedge points where the camera is already facing, which is the
        // direction of travel — moved() works it out a stride ahead.
        geolocation.useFixture(position, { heading: lastBearing });
      } else {
        if (userMarker) userMarker.setLngLat(position);
        moved(position);
      }
      if (simAlong >= totalKm) stopSimulation();
    }, SIM_TICK_MS);
  }

  function stopSimulation() {
    if (simTimer) clearInterval(simTimer);
    simTimer = null;
  }

  return {
    start,
    end,
    moved,
    /** The one piece of this state the rest of the app is allowed to read. */
    isActive: () => active,
    /**
     * Whether a simulated walk is pushing fixes. The camera ease has to finish
     * inside one tick when it is, so the caller shortens it.
     */
    isSimulating: () => simTimer !== null,
    /**
     * Whether the last OFF_ROUTE_FIXES fixes were all nowhere near the line.
     * Nothing reroutes on it yet; the sign says so, and this is the question a
     * reroute would ask.
     */
    isOffRoute: () => offRoute,
    /** Exposed for tests only — which maneuver the banner is counting down to. */
    stepIndex: () => stepIndex,
    aimKm,
  };
}
