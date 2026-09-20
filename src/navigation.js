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
   * make the dot jump between path endpoints instead of sliding along.
   */
  function moved(coords, { duration = SIM_TICK_MS } = {}) {
    if (!active || !route.isWalkable) return;

    const snapped = nearestPointOnLine(route.line, point(coords));
    const distanceAlong = snapped.properties.location;  // km travelled so far
    const here = snapped.geometry.coordinates;

    advanceSteps(distanceAlong);
    renderBanner(distanceAlong);
    moveCamera(here, distanceAlong, duration);
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
      swapStep(step, feetToStep, arrived, isFirst);
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
    /** Exposed for tests only — which maneuver the banner is counting down to. */
    stepIndex: () => stepIndex,
    aimKm,
  };
}
