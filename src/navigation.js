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

import { lineString, point } from '@turf/helpers';
import { nearestPointOnLine } from '@turf/nearest-point-on-line';
import { along } from '@turf/along';
import { bearing } from '@turf/bearing';
import { distance } from '@turf/distance';
import { maneuverIcon } from './nav-icons.js';
import { instructionFor, thenPhrase, niceFeet, countdownFeet, FEET_PER_KM } from './maneuvers.js';
import { walkLabel, walkSeconds } from './directions.js';

// Comfortable campus walking pace, for the simulator. The ETA is
// src/directions.js's, so the banner and the route card cannot disagree.
export const WALK_FEET_PER_SEC = 4.6;
// How far short of a corner it counts as taken, in km — about 3 m, a stride
// and a GPS wobble. It used to be 25 ft, and a step retired 25 ft BEFORE its
// corner is a step the walker never sees: over 13,347 walks, 15% never showed
// their first turn, 21.7% of turns were replaced by the next one while still
// ahead, and 1,781 lost their last corner to the arrival. Now a step is done
// at or just before its corner, and never sooner than halfway along its own
// leg (see retireKm), so a turn ten feet from the start is still shown.
export const MANEUVER_PASSED_KM = 10 / FEET_PER_KM;
// A corner this close behind the one on the sign goes on the same sign:
// "Turn left, then turn right".
export const THEN_FEET = 25;
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
  // The coordinates of the route this walk was started on — by identity, which
  // is what changes when the route is set again. See `replaced`.
  let walking = null;
  let lastBearing = 0;
  let userMarker = null;

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
    walking = route.coords;
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

    // From where the walk was asked to start, which for a dotted leg is not
    // the line: the sign says how to get onto the path until you are on it.
    moved(route.ends.from ?? coords[0], { duration: 900 });

    if (simulate) startSimulation();
  }

  function end() {
    stopSimulation();
    if (!active) return;
    active = false;
    walking = null;
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
   * make the dot jump between path endpoints instead of sliding along.
   */
  function moved(coords, { duration = SIM_TICK_MS } = {}) {
    if (!active) return;
    if (replaced()) { end(); return; }
    if (!route.isWalkable) return;

    const snapped = nearestPointOnLine(route.line, point(coords));
    const distanceAlong = snapped.properties.location;  // km travelled so far
    const here = snapped.geometry.coordinates;
    const fix = {
      // How far off the line, and from either end of the walk, in feet.
      offLine: snapped.properties.dist * FEET_PER_KM,
      toStart: feetBetween(coords, route.coords[0]),
      toPin: route.ends.to ? feetBetween(coords, route.ends.to) : null,
    };

    advanceSteps(distanceAlong, fix);
    renderBanner(distanceAlong, fix);
    moveCamera(here, distanceAlong, duration);
  }

  /**
   * Whether the route on screen is no longer the one this walk was started on.
   *
   * The route holder is read live, not copied at start, so a route set while a
   * walk is running changes everything under it but `stepIndex` — which then
   * pointed past the end of a shorter maneuver list, and the next fix threw
   * reading it. endpoints.js ends the walk before it swaps the route; this is
   * the backstop for anything that does not. The walk ENDS rather than carrying
   * on: it was a walk along a line that is gone, and the panel it ends on is
   * showing the one that replaced it, with its own Start.
   */
  function replaced() {
    return route.coords !== walking;
  }

  /**
   * Retire every maneuver we have already walked past.
   *
   * `depart` is retired by getting onto the line rather than by distance along
   * it: it sits at km 0, so by distance it was gone on the first fix, and the
   * one sign that says which way to turn onto the path was never shown. On
   * the line is within MANEUVER_PASSED_KM of it, or already some way along it
   * — a fix that never quite settles on the line still gets you the next sign.
   */
  function advanceSteps(distanceAlong, fix) {
    if (stepIndex === 0) {
      const onLine = fix.offLine <= MANEUVER_PASSED_KM * FEET_PER_KM;
      const underway = distanceAlong >= Math.min(ARRIVED_FEET / FEET_PER_KM, route.maneuverKm(1) / 2);
      if (!onLine && !underway) return;
      stepIndex = 1;
    }
    while (stepIndex < route.maneuvers.length - 1 && distanceAlong >= retireKm(stepIndex)) {
      stepIndex++;
    }
  }

  /**
   * Where along the route maneuver `i` counts as taken: MANEUVER_PASSED_KM
   * short of it, or halfway along the leg that leads to it if that is shorter,
   * so a corner ten feet from the last one is still on the sign for five.
   */
  function retireKm(i) {
    const km = route.maneuverKm(i);
    const leg = km - route.maneuverKm(i - 1);
    return km - Math.min(MANEUVER_PASSED_KM, leg / 2);
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

  function paintStep(card, step, feetToStep, arrived, next) {
    card.arrow.innerHTML = maneuverIcon(step.type, step);
    if (arrived) {
      card.distance.textContent = 'Arrived';
      card.instruction.textContent = 'You have reached your destination';
    } else {
      card.distance.textContent = countdownFeet(feetToStep);
      const now = instructionFor(step.type, step);
      card.instruction.textContent = next ? `${now}, ${thenPhrase(next)}` : now;
    }
  }

  /**
   * The corner after step `i`, if it is close enough to go on the same sign.
   * Not for `depart`, whose sign is already two instructions long.
   */
  function following(i) {
    if (i === 0 || i >= route.maneuvers.length - 1) return null;
    const gapFeet = (route.maneuverKm(i + 1) - route.maneuverKm(i)) * FEET_PER_KM;
    return gapFeet < THEN_FEET ? route.maneuvers[i + 1] : null;
  }

  /**
   * Build a whole new sign and run it in from the left while the finished one
   * runs out to the right — both at once, so two complete banners are on screen
   * for the length of the swap.
   */
  function swapStep(step, feetToStep, arrived, isFirst, next) {
    clearBannerTimers();
    // Clearing the timers also cancelled whatever removal was pending, so any
    // sign still mid-exit has to be swept up here or it leaks into the DOM.
    dom.stack.querySelectorAll('.nav-sign--out').forEach((stale) => stale.remove());

    const incoming = createSignCard();
    paintStep(incoming, step, feetToStep, arrived, next);

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
   * THE DOTTED LEGS ARE PART OF THE WALK. Remaining is what is left of the
   * line, plus the leg from its end to the destination pin — or, once you are
   * on that leg, the distance to the pin — plus, until you are on the line, the
   * way to its start. Arrival is at the pin where there is a leg to walk, and
   * at the end of the line where there is not.
   */
  function renderBanner(distanceAlong, fix) {
    const step = route.maneuvers[stepIndex];
    const legTo = route.legFeet.to;

    const lineLeft = Math.max(0, (route.totalKm - distanceAlong) * FEET_PER_KM);
    const toPin = fix.toPin === null ? legTo : Math.min(legTo, fix.toPin);
    const feetRemaining = lineLeft + toPin + (stepIndex === 0 ? fix.toStart : 0);
    const arrived = (fix.toPin !== null && fix.toPin <= ARRIVED_FEET)
      || (lineLeft <= ARRIVED_FEET && toPin <= ARRIVED_FEET);

    let feetToStep;
    if (step.type === 'depart') feetToStep = fix.toStart;
    else if (step.type === 'arrive') feetToStep = feetRemaining;
    else feetToStep = Math.max(0, (route.maneuverKm(stepIndex) - distanceAlong) * FEET_PER_KM);

    if (arrived) stopSimulation();

    if (stepIndex !== renderedStep) {
      const isFirst = renderedStep === -1;
      renderedStep = stepIndex;
      swapStep(step, feetToStep, arrived, isFirst, following(stepIndex));
    } else if (!bannerBusy && liveCard) {
      // Between turns only the countdown moves — never re-run the animation.
      if (arrived) paintStep(liveCard, step, feetToStep, true);
      else liveCard.distance.textContent = countdownFeet(feetToStep);
    }

    // The ETA in the words the route card uses, from the same function — the
    // banner used to round where the card rounds up, so a 1 min 29 s walk was
    // "2 min" on one and "1 min" on the other.
    dom.remaining.textContent = arrived ? '0 ft' : niceFeet(feetRemaining);
    dom.eta.textContent = arrived ? 'now' : walkLabel(walkSeconds(feetRemaining));
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
    // The dotted legs are walked too, so the simulator shows the depart sign
    // on the way to the path and arrives at the pin rather than beside it.
    const walk = simulatedWalk();
    const totalKm = walk.km;
    const perTickKm =
      (WALK_FEET_PER_SEC * SIM_SPEED * (SIM_TICK_MS / 1000)) / FEET_PER_KM;
    const viaFixture = Boolean(geolocation.fixture);

    simTimer = setInterval(() => {
      if (replaced()) { end(); return; }
      simAlong = Math.min(simAlong + perTickKm, totalKm);
      const position = along(walk.line, simAlong).geometry.coordinates;
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

  /** The line with the dotted legs on either end, where there are any. */
  function simulatedWalk() {
    const coords = route.coords;
    const from = route.ends.from && feetBetween(route.ends.from, coords[0]) >= 1 ? route.ends.from : null;
    const to = route.ends.to && feetBetween(coords[coords.length - 1], route.ends.to) >= 1 ? route.ends.to : null;
    if (!from && !to) return { line: route.line, km: route.totalKm };
    const km = route.totalKm
      + (from ? feetBetween(from, coords[0]) / FEET_PER_KM : 0)
      + (to ? feetBetween(coords[coords.length - 1], to) / FEET_PER_KM : 0);
    return { line: lineString([...(from ? [from] : []), ...coords, ...(to ? [to] : [])]), km };
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
    /** Exposed for tests only — which maneuver the banner is counting down to. */
    stepIndex: () => stepIndex,
    aimKm,
  };
}

function feetBetween(a, b) {
  return distance(point(a), point(b)) * FEET_PER_KM;
}
