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

// How a GPS fix becomes progress along the route. `moved` applies the first
// before anything else sees the fix; `track` reads the rest, and is where each
// is explained. The give-back distance is `advanceSteps`'.
//
// A fix whose own accuracy circle is wider than this is not used for progress
// at all: 35 m is wider than most of the campus's walkways are apart, so a fix
// that vague cannot say which one you are on.
export const MAX_ACCURACY_M = 35;
// The window a fix is snapped inside, around where you were last: a little way
// back, so standing still in noise does not ratchet you forward, and a SHORT
// way ahead — about ten seconds' walk. It is short on purpose. It used to
// reach sixty metres, and wider still for a poor fix, and at the bottom of a U
// sixty metres up the route is the way home, twenty metres beside you: one fix
// drifted ten metres toward it was nearer that than the path you were on, and
// both corners went at once. Nor does it widen with a poor fix any more — a
// vague fix is as likely to be beside you as ahead of you, and what grows with
// accuracy is how poor a fit is forgiven (SNAP_FIT_M, below).
//
// A walker who outpaces the window is not held at its end. A fix just past it
// lands there, near enough to fit. One further past — a jog, or a phone that
// reports every twenty seconds — fits nowhere inside it, and used to wait for
// JUMP_FIXES to agree like any leap: two fixes in every three standing still.
// So a fix that has run off the FRONT of the window, and fits nothing in it,
// is followed up the line as far as SNAP_CATCH_UP_M from where you were, if it
// sits on the line there. Off the front is the point: the fix at the bottom of
// the U is beside the path you are on, not past the end of it, and a fix that
// fits beside you is never looked for further on.
export const SNAP_BEHIND_M = 30;
export const SNAP_AHEAD_M = 15;
export const SNAP_CATCH_UP_M = 45;
// A fix that fits the window this well, or within its own accuracy if that is
// wider, is believed where the window puts it — a fix that sits nicely on the
// stretch you are walking has no reason to be read as anywhere else. A worse
// fit with a better place for it outside the window is a candidate LEAP,
// believed only once JUMP_FIXES in a row agree on roughly where: within
// JUMP_AGREE_M of each other, because fixes a few strides apart while you walk
// are making the same claim.
export const SNAP_FIT_M = 15;
export const JUMP_FIXES = 3;
export const JUMP_AGREE_M = 60;
// Further than this from every part of the line, this many fixes running, and
// you have left the route rather than wobbled off it — once you have been on
// it. On the way to it from an off-network start the measure is different;
// see `track`.
export const OFF_ROUTE_M = 40;
export const OFF_ROUTE_FIXES = 3;
// How much further short of a corner than where its sign was retired — a
// stride short of it, MANEUVER_REACHED_KM — you have to be before the sign
// comes back. Wider than the noise a fix carries, so a corner is not retired
// and restored on alternate fixes while you stand at it.
export const GIVE_BACK_M = 10;

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
  // next two count fixes that are nowhere near the line. `joined` is whether
  // any fix has yet been near the line at all, and until one has,
  // `approachM` is the nearest one has come — see `track`.
  let lastAlong = 0;
  let jump = null;
  let offRouteFixes = 0;
  let offRoute = false;
  let joined = false;
  let approachM = Infinity;
  // The step the last fix wanted the sign moved to, when that was not the one
  // showing — waiting for a second fix to say the same. See `advanceSteps`.
  let pendingStep = null;
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
    pendingStep = null;
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
    // That was the route's own first point, there to put the first sign up
    // and the camera on the line — not a fix. Where the walker is has not been
    // heard yet, and it may be well short of the line; see `track`.
    joined = false;
    approachM = Infinity;

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
    // Off the route — or back near it, but somewhere `track` will not put you
    // until a few fixes agree, which is where a shortcut that rejoins further
    // on comes back. The second case used to fall through to "moves nothing",
    // and with the warning still up that froze it: the sign kept its last
    // distance and the camera stopped following, for a fix or two with no
    // word of either. So the warning keeps counting down to the line until a
    // place on it is believed and the sign is painted whole again.
    if (fix.offRoute || (!fix.snapped && signStale)) {
      warnOffRoute(fix.missM);
      // Follow the walker, not the line they have left: a camera parked on
      // the route would watch the blue dot walk off the edge of the screen.
      ease(coords, duration);
      return;
    }
    // Still on the way to the line from wherever the walk was asked from. The
    // first sign stays up, counting from the start of the line, and the camera
    // follows the walker toward it.
    if (fix.approaching) {
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
   * behind, a short way ahead — rather than to the whole line. Progress can
   * still slide back a few steps in noise, and near a corner a fix can still
   * put you a few metres round it early; but one fix cannot carry you further
   * up the route than SNAP_AHEAD_M past the last believed one, however near
   * the line it passes there — or SNAP_CATCH_UP_M, for a fix that has run
   * off the window's front end and fits nothing inside it. That is the whole
   * of the guarantee, and it is why the window is short: the first version
   * reached sixty metres ahead and took the plain nearest point inside it,
   * and at the bottom of a U the way home is inside sixty metres — one fix
   * drifted ten metres toward it retired both corners. The Geolocation API's own accuracy decides how poor a fit is
   * forgiven, and a fix too vague to be used at all never gets here (see
   * `moved`).
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
   *
   * EXCEPT ON THE WAY TO IT. The line starts where the walk joins the network,
   * and a walk may be asked for from anywhere within REACH_M of the network
   * (src/directions.js) — three hundred metres, against OFF_ROUTE_M's forty.
   * Measured from the line, every fix on the way from the car park to its
   * first point said "left the route", and the sign said so from the first
   * stride. So until a fix has come near the line, a walker is APPROACHING
   * it: the fix places nobody on the route — a fix a hundred metres beside its
   * middle is not a walker at its middle — and is off the route only when it
   * is OFF_ROUTE_M further from the line than the nearest the walk has come,
   * which is walking away from it.
   *
   * `missM`, how far the fix is from the nearest part of the whole line, comes
   * back every time, so the off-route sign can keep counting it down while a
   * walker who has come back waits for a leap to be agreed.
   */
  function track(fix, accuracyM) {
    const whole = nearestPointOnLine(route.line, fix);
    const missM = whole.properties.dist * 1000;
    const nearM = Math.max(OFF_ROUTE_M, accuracyM);
    if (!joined) approachM = Math.min(approachM, missM);

    if (missM > nearM + (joined ? 0 : approachM)) {
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
      if (missM > nearM) return { offRoute: false, missM, snapped: null, approaching: true };
      joined = true;
    }

    const lo = Math.max(0, lastAlong - SNAP_BEHIND_M / 1000);
    const hi = Math.min(route.totalKm, lastAlong + SNAP_AHEAD_M / 1000);
    const fitM = Math.max(SNAP_FIT_M, accuracyM);
    let near = snapBetween(fix, lo, hi);
    const wholeKm = whole.properties.location;

    // Run off the front of the window and fitting nothing in it: followed up
    // the line, if it is on the line there. See SNAP_CATCH_UP_M.
    const reach = Math.min(route.totalKm, lastAlong + SNAP_CATCH_UP_M / 1000);
    if (near.dist * 1000 > fitM && hi - near.location < 1e-4 && reach > hi) {
      const further = snapBetween(fix, hi, reach);
      if (further.dist * 1000 <= fitM) near = further;
    }

    const outside = wholeKm < lo || wholeKm > hi;
    if (outside && near.dist * 1000 > fitM) {
      const count =
        jump && Math.abs(wholeKm - jump.km) <= JUMP_AGREE_M / 1000 ? jump.count + 1 : 1;
      jump = { km: wholeKm, count };
      if (count < JUMP_FIXES) return { offRoute: false, missM, snapped: null };

      jump = null;
      lastAlong = wholeKm;
      // A leap BACK has to give back the corners it passed, or the sign would
      // keep pointing at one you are now behind. Counting up again from the
      // start gives the same answer as before for a leap forward. Done here,
      // at once, rather than left to `advanceSteps`: its give-back keeps
      // GIVE_BACK_M of slack and it waits for a second fix, and a leap has
      // already had JUMP_FIXES agree on it.
      stepIndex = stepAt(0, wholeKm);
      pendingStep = null;
      return {
        offRoute: false,
        missM,
        snapped: { distanceAlong: wholeKm, here: whole.geometry.coordinates },
      };
    }

    jump = null;
    lastAlong = near.location;
    return { offRoute: false, missM, snapped: { distanceAlong: near.location, here: near.here } };
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

  /**
   * Retire every maneuver we have already walked past — and give back one we
   * are now well short of. Either way, only once two fixes in a row say so.
   *
   * This used to only count up, on every fix, which made every mistake
   * permanent: a corner retired by one fix stayed retired however far back the
   * next fixes put you. The window in `track` keeps such mistakes to a few
   * metres round a corner, but at the bottom of a U a few metres round the
   * first corner is the second one too, and a single fix drifted onto the
   * short leg between them took both. So:
   *
   *   - A change of sign waits for a second fix that wants it too. On foot
   *     that is a stride or so, and the sign still turns over a few metres
   *     before the corner; one stray fix no longer turns it at all. Two fixes
   *     wanting to go different distances move it the shorter one, the part
   *     they agree on.
   *   - A corner is given back once you are GIVE_BACK_M further short of it
   *     than where it was retired — far enough that a walker standing at a
   *     corner in noise does not see it come and go, near enough that the
   *     walker the GPS misplaced gets the sign back on the path they are on.
   *     `depart` never comes back: it is behind you wherever you are.
   */
  function advanceSteps(distanceAlong) {
    const due = stepAt(stepIndex, distanceAlong);
    if (due === stepIndex) {
      pendingStep = null;
      return;
    }
    const sameWay = pendingStep !== null && (pendingStep > stepIndex) === (due > stepIndex);
    if (!sameWay) {
      pendingStep = due;
      return;
    }
    stepIndex = due > stepIndex ? Math.min(due, pendingStep) : Math.max(due, pendingStep);
    pendingStep = null;
  }

  /**
   * Which maneuver the sign should be counting down to at `distanceAlong` km,
   * counted from `from`: back while you are GIVE_BACK_M short of where the one
   * before it was retired, then up past every one within MANEUVER_REACHED_KM.
   * From 0 it is simply the right step for that point on the route.
   */
  function stepAt(from, distanceAlong) {
    let i = from;
    while (
      i > 1 &&
      distanceAlong < route.maneuverKm(i - 1) - MANEUVER_REACHED_KM - GIVE_BACK_M / 1000
    ) {
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
