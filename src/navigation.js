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

import { point, lineString } from '@turf/helpers';
import { nearestPointOnLine } from '@turf/nearest-point-on-line';
import { along } from '@turf/along';
import { bearing } from '@turf/bearing';
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

// How a GPS fix becomes progress along the route. See `track`, which is the
// only reader of all seven, for why each one is what it is.
//
// A fix whose own accuracy circle is wider than this is not used for progress
// at all: 35 m is wider than most of the campus's walkways are apart, so a fix
// that vague cannot say which one you are on.
export const MAX_ACCURACY_M = 35;
// The window a fix is snapped inside, around where you were last: a little way
// back, so standing still in noise does not ratchet you forward, and further
// ahead, so a brisk walk between two fixes is not clipped. The lead widens with
// a poor fix, which is a fix that could honestly be further on.
export const SNAP_BEHIND_M = 30;
export const SNAP_AHEAD_M = 60;
// A fix outside the window is only believed once this many in a row agree, and
// only when the window's own best fit is at least this poor — a fix that sits
// nicely on the stretch you are walking has no reason to be read as anywhere else.
export const JUMP_FIXES = 3;
export const JUMP_MISS_M = 25;
// Further than this from every part of the line, this many fixes running, and
// you have left the route rather than wobbled off it.
export const OFF_ROUTE_M = 40;
export const OFF_ROUTE_FIXES = 3;

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
  // last believed fix put the walker, in km; `jump` is a run of fixes that all
  // say you are somewhere outside the window, waiting to be agreed with; the
  // other two count fixes that are nowhere near the line.
  let lastAlong = 0;
  let jump = null;
  let offRouteFixes = 0;
  let offRoute = false;
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
    stepIndex = 0;
    lastAlong = 0;
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
   * they were taken off the line in the first place.
   */
  function moved(coords, { duration = SIM_TICK_MS, accuracy = 0 } = {}) {
    if (!active || !route.isWalkable) return;

    const accuracyM = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0;
    // Too vague to say where on the route you are, so it says nothing. The
    // blue dot still moves — it is the locate control's, drawn from the fix
    // itself rather than from here — and the next good fix carries on from
    // the last believed one.
    if (accuracyM > MAX_ACCURACY_M) return;

    const fix = track(point(coords), accuracyM);
    if (fix.offRoute) {
      warnOffRoute(fix.missM);
      // Follow the walker, not the line they have left: a camera parked on
      // the route would watch the blue dot walk off the edge of the screen.
      ease(coords, duration);
      return;
    }
    if (!fix.snapped) return;

    const { distanceAlong, here } = fix.snapped;   // km travelled so far
    advanceSteps(distanceAlong);
    renderBanner(distanceAlong);
    moveCamera(here, distanceAlong, duration);
  }

  /**
   * Where on the route a fix puts you — or that it puts you nowhere yet.
   *
   * THIS USED TO BE ONE CALL: the nearest point on the whole line, taken as
   * gospel. On a walk that doubles back — out along one side of a quad and home
   * along the other, twenty metres apart — a fix ten metres the wrong way at
   * the start is nearer the return leg than the outbound one, and the nearest
   * point is then most of the way to the door. `advanceSteps` only ever counts
   * up, so every corner in between was retired for good, and a phone held
   * still at the start could read "Arrived". Campus GPS between buildings is
   * out by that much routinely.
   *
   * So a fix is snapped inside a WINDOW around where you were last — a little
   * behind, further ahead — rather than to the whole line. Progress can still
   * slide back a few steps in noise and can still be wrong for a fix, but it
   * cannot leap to a part of the route you have not walked to. The Geolocation
   * API's own accuracy is what sizes it: a vague fix is not used at all (see
   * `moved`), and a merely poor one widens the window ahead.
   *
   * A REAL LEAP still happens — the radio lost under a roof for a minute, or a
   * shortcut across a lawn — and the window alone would hold you at its edge
   * for ever. It is believed when the window's best fit is poor, the whole
   * line has a better one outside it, and JUMP_FIXES fixes in a row agree on
   * roughly where. Until then the fix moves nothing: one bad fix is not a
   * reason to move, let alone to move sixty metres toward it.
   *
   * And a fix that is nowhere near ANY of the line, OFF_ROUTE_FIXES times
   * running, is a walker who has left the route; the sign says so rather than
   * counting down to a corner they are not walking toward.
   */
  function track(fix, accuracyM) {
    const whole = nearestPointOnLine(route.line, fix);
    const missM = whole.properties.dist * 1000;

    if (missM > Math.max(OFF_ROUTE_M, accuracyM)) {
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

    const lo = Math.max(0, lastAlong - SNAP_BEHIND_M / 1000);
    const hi = Math.min(route.totalKm, lastAlong + Math.max(SNAP_AHEAD_M, 2 * accuracyM) / 1000);
    const near = snapBetween(fix, lo, hi);
    const wholeKm = whole.properties.location;

    const outside = wholeKm < lo || wholeKm > hi;
    if (outside && near.dist * 1000 > Math.max(JUMP_MISS_M, accuracyM)) {
      // Agreement is "about the same place", not the same metre: fixes a few
      // strides apart while you walk are making the same claim.
      const agreeKm = Math.max(SNAP_AHEAD_M, 2 * accuracyM) / 1000;
      const count = jump && Math.abs(wholeKm - jump.km) <= agreeKm ? jump.count + 1 : 1;
      jump = { km: wholeKm, count };
      if (count < JUMP_FIXES) return { offRoute: false, snapped: null };

      jump = null;
      lastAlong = wholeKm;
      // A leap BACK has to give back the corners it passed, or the sign would
      // keep pointing at one you are now behind. Counting up again from the
      // start gives the same answer as before for a leap forward.
      stepIndex = 0;
      return { offRoute: false, snapped: { distanceAlong: wholeKm, here: whole.geometry.coordinates } };
    }

    jump = null;
    lastAlong = near.location;
    return { offRoute: false, snapped: { distanceAlong: near.location, here: near.here } };
  }

  /**
   * The nearest point to `fix` on the part of the route between `lo` and `hi`
   * km along it, with `location` measured from the start of the whole route.
   *
   * Cut by hand from `route.cumulative` rather than with @turf/line-slice-along,
   * which would be a dependency for a dozen lines: `along` gives the two cut
   * ends, and every vertex strictly between them is kept as it is.
   */
  function snapBetween(fix, lo, hi) {
    const { coords, cumulative } = route;
    const piece = [along(route.line, lo).geometry.coordinates];
    for (let i = 0; i < coords.length; i++) {
      if (cumulative[i] > lo && cumulative[i] < hi) piece.push(coords[i]);
    }
    piece.push(along(route.line, hi).geometry.coordinates);

    const snapped = nearestPointOnLine(lineString(piece), fix);
    return {
      location: Math.min(hi, lo + snapped.properties.location),
      dist: snapped.properties.dist,
      here: snapped.geometry.coordinates,
    };
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

  /** Retire every maneuver we have already walked past. */
  function advanceSteps(distanceAlong) {
    while (
      stepIndex < route.maneuvers.length - 1 &&
      route.maneuverKm(stepIndex) - distanceAlong < MANEUVER_REACHED_KM
    ) {
      stepIndex++;
    }
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
    };
  }

  function paintStep(card, step, feetToStep, arrived) {
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

  function renderBanner(distanceAlong) {
    const totalKm = route.totalKm;
    const step = route.maneuvers[stepIndex];

    const feetToStep = Math.max(0, (route.maneuverKm(stepIndex) - distanceAlong) * FEET_PER_KM);
    const feetRemaining = Math.max(0, (totalKm - distanceAlong) * FEET_PER_KM);
    const arrived = feetRemaining <= ARRIVED_FEET;

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
      // Between turns only the countdown moves — never re-run the animation.
      if (arrived) paintStep(liveCard, step, feetToStep, true);
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
