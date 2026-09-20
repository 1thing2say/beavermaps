// The two ends of a walk: where it starts, where it goes, and every way either
// of those can be chosen.
//
// EIGHT VARIABLES THAT ONLY MEAN ANYTHING TOGETHER — the two points, their two
// markers, whether the start came from the GPS, the sequence number that tells
// a stale answer from a live one, the last fix and the destination parked
// waiting for a start. They lived in four separate regions of startApp(), and
// the one function that has to put all eight back — `reset` — was two hundred
// lines away from the six that set them.
//
// THE SEQUENCE NUMBER IS THE REASON THIS WANTS ONE OWNER. Every path in here is
// asynchronous: a GPS fix, a round trip to the router, a card opening. Any of
// them can be superseded while it is in flight, and the guard that catches that
// has to be read by the code that sets the state and by the code that clears
// it. Scattered, it was a variable anyone could increment; here there is one
// place it goes up and one place it is checked.
//
// WHAT A CHOSEN PLACE MEANS still belongs to the caller. This module knows how
// to plant a pin and ask for a route; the cards, the search box and the legend
// rows all call `setDestination` and none of them needs to know the other two
// exist.

import mapboxgl from 'mapbox-gl';
import { point } from '@turf/helpers';
import { distance } from '@turf/distance';
import { nearestPoint } from '@turf/nearest-point';
import { routePin, liftedOffset, ROUTE_PIN_W } from './map-images.js';
import { reachProblem, locationProblem } from './directions.js';

// Google's own pin colours, for the two markers the router plants. Origin green
// and destination red is their convention as well as the one this app already
// used; only the values move.
export const GOOGLE_GREEN = '#1e8e3e';
export const GOOGLE_RED = '#ea4335';

/** Nothing to draw, in the shape every geojson source expects. */
const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * @param {object} deps  every collaborator, named for what it does
 */
export function createEndpoints({
  map,
  route,
  nav,
  camera,
  api,
  geolocateControl,
  networkPoints,
  routingEnabled,
  status,
  panel,
  ui,
  paintLegs,
  clearSelection,
  clearSearchField,
  startLocating,
}) {
  const { setStatus, setBusy, setRouteSummary, setNavButtonsEnabled, setIdleStatus } = status;
  const { startCoordText, endCoordText } = ui;

  // State variables
  let startMarker = null;
  let endMarker = null;
  let startPoint = null;
  let endPoint = null;
  let requestSeq = 0;
  /**
   * Whether `startPoint` is where the phone says you are, or somewhere chosen.
   *
   * The one bit that decides what "Directions" does on a card. A start somebody
   * put down on purpose — "Start here" on a building, a pin they dropped — is an
   * answer to a question the app did not ask, and overwriting it with a GPS fix
   * would throw it away silently. A start this app adopted from the GPS is not
   * a choice and can be replaced by a better fix without asking.
   */
  let startIsMine = false;
  /**
   * The last position the locate control reported, and when.
   *
   * Not a cache for its own sake: `getCurrentPosition` on a cold radio can take
   * several seconds, and pressing Directions on a second building right after
   * the first should not spend them again. `maximumAge` on the request itself
   * covers the same ground inside the browser, so this is only what lets the
   * FIXTURE and the real API be asked the same question — see currentPosition.
   */
  let lastFix = null;

  function resetMap() {
    nav.end();

    if (startMarker) startMarker.remove();
    if (endMarker) endMarker.remove();
    startPoint = null;
    endPoint = null;
    startIsMine = false;
    startMarker = null;
    endMarker = null;

    route.clear();
    requestSeq++;

    if (map.getSource('calculated-route')) {
      map.getSource('calculated-route').setData(EMPTY);
    }
    map.getSource('route-legs')?.setData(EMPTY);

    clearSelection();

    // Reset UI. The search box is cleared too: leaving a destination showing
    // next to "Not set" is the kind of stale text people act on.
    pendingEnd = null;
    clearSearchField();
    setIdleStatus();
    startCoordText.value = '';
    endCoordText.value = '';
    setRouteSummary(null);
    setNavButtonsEnabled(false);
  }

  /** Re-route from the existing start to a newly chosen destination. */
  async function rerouteTo(coords, name) {
    if (endMarker) endMarker.remove();
    endMarker = null;
    endPoint = null;
    await placeEnd(coords, name);
  }

  // -------------------------------------------------------------------------

  const coordLabel = (c) => `${c[1].toFixed(4)}, ${c[0].toFixed(4)}`;

  /** A destination chosen before a start point, held until there is one. */
  let pendingEnd = null;

  // The debug menu can take the route GUI away, and these three functions are
  // where it is taken: they are the only places an endpoint is put on the map,
  // so between them they are the whole of the offer. Guarded here rather than at
  // the four things that CALL them — a map click, a card button, a search
  // result, a category row — because a rule stated once at the funnel cannot be
  // half-applied, and the stylesheet is already hiding the affordances. See
  // routingEnabled, and body.no-routing in src/input.css.
  //
  // A tap still lifts a pin, opens a building and clears a category with the
  // GUI off, because none of those are about going anywhere.

  // `adoptFixtureStart` and `haveStart` stood here, and both are gone.
  //
  // They were the app's whole answer to "where am I": the fixture's coordinates
  // if the debug menu had put one on the campus, and otherwise nothing. Their
  // ONE PIN, NOT TWO argument was right and is kept below in locateStart — with
  // a position on the map there is already a blue dot saying where you are, and
  // a green Start pin beside it is the second pin. What was wrong was the
  // premise that only a fixture could supply one.

  /** How long to wait for a fix before saying so. */
  const FIX_TIMEOUT_MS = 9000;
  /** A fix this fresh is worth reusing rather than waking the radio for. */
  const FIX_FRESH_MS = 30_000;

  /**
   * Where the phone says it is, as a promise.
   *
   * THROUGH THE LOCATE CONTROL, not through a second geolocation request of our
   * own, and that is the whole shape of this function. The obvious version asks
   * `getCurrentPosition` directly; it was written that way first and it was
   * wrong twice over.
   *
   * The first is visible: the control is what draws the blue dot, and a
   * position obtained behind its back leaves "from your location" as a claim
   * with nothing on the map behind it. Triggering it as well means TWO watches
   * on one radio — which is also what caught this. In headless Chrome the
   * second consumer simply never receives a fix, so the dot sat spinning at
   * "waiting" forever while the route drew perfectly. That specific behaviour
   * is an emulator artifact and a real phone would have served both; running
   * two watches to answer one question is a waste on any of them.
   *
   * The second is that the control is ALREADY watching whenever the dot is up,
   * so most of the time the answer is in hand and no radio needs waking at all.
   *
   * The fixture reaches this the same way — it delivers through the control's
   * watch like a real fix does, so nothing here needs to know which it has.
   */
  function currentPosition() {
    const fresh = lastFix && Date.now() - lastFix.when < FIX_FRESH_MS;
    if (fresh) return Promise.resolve(lastFix.at);

    return new Promise((resolve, reject) => {
      if (!geolocateControl) { reject({ code: 2 }); return; }
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        geolocateControl.off('geolocate', onFix);
        geolocateControl.off('error', onFail);
        fn(value);
      };
      const onFix = (e) => finish(resolve, [e.coords.longitude, e.coords.latitude]);
      const onFail = (error) => finish(reject, error);
      const timer = setTimeout(() => {
        // A STALE FIX BEATS A REFUSAL. A watch that has locked on and gone
        // quiet is what a stationary phone looks like — some browsers report
        // once and then say nothing until you move — and the last thing it said
        // is still where you are standing. Refusing to route somebody who has
        // not moved, because they have not moved, is the worst reading of this.
        if (lastFix) finish(resolve, lastFix.at);
        else finish(reject, { code: 3 });
      }, FIX_TIMEOUT_MS);
      geolocateControl.on('geolocate', onFix);
      geolocateControl.on('error', onFail);
      // No-op if it is already locked on, in which case the next fix its watch
      // delivers is the one resolved above.
      startLocating();
    });
  }

  /**
   * Make where you are the start of the route. The whole of "from my location".
   *
   * THIS IS WHAT DIRECTIONS WAS MISSING. The button has been on both cards from
   * the beginning, and pressing it on a phone produced "…now press and hold the
   * map to set a start point" — because the only position this app would ever
   * adopt was the debug fixture. Everybody without the debug menu open was
   * being asked to tell a map with a GPS in it where they were standing.
   *
   * Three ways to fail, and all three are said out loud rather than swallowed:
   * the browser refuses or times out (see locationProblem), or the fix lands
   * outside the routing graph (see reachProblem). The last is the quiet one —
   * the router snaps a start to the nearest vertex with no notion of "too far",
   * so opening this at home ten miles away would otherwise draw a confident
   * eight-minute walk between two places neither of which is where you are.
   *
   * Returns whether there is now a start point to route from.
   */
  async function locateStart() {
    if (!routingEnabled || !networkPoints) return false;

    // The fixture answers on the next tick, so this spinner is a real wait only
    // for a real GPS — which is exactly when it is worth showing.
    setBusy(true);
    setStatus('Finding your location…');
    let at;
    try {
      at = await currentPosition();
    } catch (error) {
      setStatus(locationProblem(error), true);
      return false;
    } finally {
      setBusy(false);
    }

    const node = nearestPoint(point(at), networkPoints).geometry.coordinates;
    const problem = reachProblem(distance(point(at), point(node)) * 1000);
    if (problem) { setStatus(problem, true); return false; }

    panel.show();
    startPoint = point(node);
    startIsMine = true;
    // No green pin, for the same reason the fixture plants none: the blue dot
    // is what says where you are, and a marker on top of it is the second pin.
    startMarker?.remove();
    startMarker = null;
    startCoordText.value = 'Your location';
    return true;
  }

  /**
   * Set the start of the route to a coordinate somebody chose.
   *
   * THE SAME REACH CHECK locateStart makes, and for the same reason — it was
   * only ever on the GPS door. A fix that lands too far from the graph was
   * refused; a press-and-hold that landed in the same place was not, and went
   * on to produce a route from a vertex nowhere near where the pin is. The
   * fence in ROUTABLE_BOUNDS keeps the camera over ground the server can route,
   * but that box is a rectangle and the network inside it is not, so its corners
   * are still further from a path than anybody should be routed from.
   *
   * A no-op for the three callers that pass a named campus place — every one of
   * those is on the graph by construction, which test/directions.test.js holds
   * them to. It is the dropped pin this is here for.
   *
   * Skipped entirely until the vertices have landed, because "we cannot check
   * yet" is not the same as "too far" and refusing a press during the cold load
   * would be the wrong sentence at the one moment it is most confusing.
   *
   * @returns {boolean} whether there is now a start point
   */
  function placeStart(coords, label) {
    if (!routingEnabled) return false;

    if (networkPoints) {
      const node = nearestPoint(point(coords), networkPoints).geometry.coordinates;
      const problem = reachProblem(distance(point(coords), point(node)) * 1000);
      if (problem) { setStatus(problem, true); return false; }
    }

    panel.show();
    startPoint = point(coords);
    // Somebody chose this, so Directions on the next card routes FROM it rather
    // than replacing it with a GPS fix. See startIsMine.
    startIsMine = false;
    startMarker?.remove();
    startMarker = new mapboxgl.Marker({
      element: routePin(GOOGLE_GREEN, { title: 'Start' }),
      anchor: 'bottom',
      offset: liftedOffset(ROUTE_PIN_W),
    })
      .setLngLat(coords)
      .addTo(map);
    startCoordText.value = label ?? coordLabel(coords);
    return true;
  }

  async function placeEnd(coords, label) {
    if (!routingEnabled) return;
    panel.show();
    endPoint = point(coords);
    endMarker?.remove();
    endMarker = new mapboxgl.Marker({
      element: routePin(GOOGLE_RED, { title: 'Destination' }),
      anchor: 'bottom',
      offset: liftedOffset(ROUTE_PIN_W),
    })
      .setLngLat(coords)
      .addTo(map);
    endCoordText.value = label ?? coordLabel(coords);
    setStatus('Calculating route…');

    // Guard against a stale response landing after the user has moved on.
    const seq = ++requestSeq;
    let result;
    let failure = null;
    // The only wait in this app the user asked for directly. "Calculating
    // route…" has been the whole of the feedback here, and a sentence that does
    // not change cannot distinguish a server thinking from a server gone.
    //
    // setBusy is ref-counted, so this pair balances whatever else is in flight:
    // two overlapping requests take the spinner to two and the first to finish
    // leaves it up for the second. That is why the `finally` is unconditional
    // while everything below it is not.
    setBusy(true);
    try {
      result = await api.route(startPoint.geometry.coordinates, coords);
    } catch (error) {
      console.error(error);
      failure = 'Routing server unreachable — is `npm run dev` still running?';
    } finally {
      setBusy(false);
    }

    // EVERY OUTCOME IS CHECKED AGAINST THE SEQUENCE, the failures included.
    //
    // This check used to sit below the catch, so it guarded the success path
    // and nothing else — and the failure path is the one that tears state down.
    // A slow request that failed after a later one had already succeeded would
    // null `endPoint`, remove the marker belonging to the route now on screen,
    // and overwrite its summary with "Routing server unreachable". Worse, the
    // teardown ran `endMarker.remove()` unguarded: press Clear while a request
    // is in flight and resetMap() sets endMarker to null, so the failure that
    // arrived afterwards threw a TypeError out of an async function nobody was
    // awaiting.
    //
    // resetMap() bumps requestSeq for exactly this reason. It was only ever
    // half-read.
    if (seq !== requestSeq) return;

    // One teardown for the three ways this can come to nothing — a dead server,
    // an unroutable end, and two points the graph does not join. They differ
    // only in the sentence, and they used to differ in whether setRouteSummary
    // was cleared as well, which was not a decision anybody made.
    const refusal = failure ?? result?.refused
      ?? (result ? null : 'No path found between those two points.');
    if (refusal) {
      setStatus(refusal, true);
      setRouteSummary(null);
      endPoint = null;
      endMarker?.remove();
      endMarker = null;
      return;
    }

    // `stepIndex` used to be zeroed here too. It is navigation's, it is only
    // ever read while a walk is running, and nav.start() zeroes it — so this
    // was resetting a counter nothing could have read.
    route.set(result);

    map.getSource('calculated-route').setData(route.feature());
    paintLegs();

    setRouteSummary(result.distanceFeet);
    const turns = route.maneuvers.length - 2;
    setStatus(`Route calculated — ${turns} turn${turns === 1 ? '' : 's'}.`);
    setNavButtonsEnabled(true);

    // A walk that starts off campus does not fit the campus view it was planned
    // in, and half a route running off the top of the screen is the same bug as
    // a category whose pins are behind the panel. Same helper, so it leaves the
    // camera alone when the whole thing is already in front of you.
    camera.frame(route.coords, { maxZoom: 17 });
  }

  /**
   * Make a named point the destination, whichever list it was picked from.
   *
   * Shared by the search box and the category panel. Both can be used before a
   * start point exists, which is the case `pendingEnd` covers: the pin and the
   * label go down now, and the route is calculated the moment the next map
   * click supplies somewhere to walk from.
   */
  /**
   * Put the red pin down and hold the destination, without routing to it.
   *
   * What is left when there is a place but no start: the pin, the label and the
   * camera. `pendingEnd` is what makes it not a dead end — the next thing that
   * supplies a start point picks this up and routes it.
   *
   * Writes no status of its own. It is only ever reached after something else
   * has explained why there is no route yet, and that sentence is better than
   * anything this could say over the top of it.
   */
  function parkDestination(coords, name) {
    // The destination is the only thing worth looking at. With a start already
    // down the camera belongs to the route instead, and placeEnd frames it —
    // flying here first would land on the destination at z17, then test the
    // route against the view it had *before* the flight, decide it was already
    // visible, and leave half the walk off the top of the screen. Which is
    // exactly what it did.
    //
    // Padding stated rather than inherited: showRoutePanel started a 300 ms
    // padding ease, and a flight that did not carry its own would interrupt
    // that ease and keep whatever partial value it had reached.
    map.flyTo({
      center: coords,
      zoom: Math.max(map.getZoom(), 17),
      padding: panel.padding(),
      duration: 900,
    });
    pendingEnd = { coords, name };
    endMarker?.remove();
    endMarker = new mapboxgl.Marker({
      element: routePin(GOOGLE_RED, { title: 'Destination' }),
      anchor: 'bottom',
      offset: liftedOffset(ROUTE_PIN_W),
    })
      .setLngLat(coords).addTo(map);
    endCoordText.value = name ?? coordLabel(coords);
  }

  /**
   * "Take me there." Every Directions button on this map ends up here.
   *
   * ONE PATH, and that is the point of it. A building's card, a pin's card, a
   * dropped pin, a search result and a category row were four callers with
   * three different ideas about what happens when there is no start point —
   * park it, ask for a hold, or quietly do nothing — and none of them asked the
   * GPS. They ask one function now, and it asks the GPS.
   *
   * The rule about an existing start is the only subtle thing here: a start
   * somebody CHOSE outranks the phone, because they chose it. A start this app
   * adopted from a previous fix does not, because it was never a choice and a
   * newer fix is strictly better. See startIsMine.
   */
  async function setDestination(coords, name) {
    // With the route GUI off, a search result and a category row still mean
    // something — "show me where that is" — so this degrades to the camera
    // rather than to nothing. Dropping the red pin here without a route panel
    // to explain it would be the worst of the three options.
    if (!routingEnabled) {
      map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 17), duration: 900 });
      return;
    }

    // Both ends already set: start over rather than accumulating markers. The
    // start survives it — see below — so this is only clearing the old walk.
    const keep = startPoint && !startIsMine ? startPoint : null;
    if (startPoint && endPoint) resetMap();
    if (keep) { startPoint = keep; startIsMine = false; }
    // Before the flyTo below, so the camera is framing the space the panel has
    // already taken rather than the space it is about to.
    panel.show();

    if (!(startPoint && !startIsMine) && !(await locateStart())) {
      // No fix, and locateStart has already said why. The destination still
      // goes down, so that sentence is read next to a map showing where you
      // asked to go rather than next to nothing.
      parkDestination(coords, name);
      return;
    }

    if (endPoint) await rerouteTo(coords, name);
    else await placeEnd(coords, name);
  }
  /**
   * Draw the walk again after one of its ends was retyped.
   *
   * The destination is read back off the map rather than remembered separately,
   * because `endPoint` is where the route actually goes and a second copy of it
   * is a second thing that can be wrong.
   */
  async function rerouteFromStart() {
    if (!startPoint) return;
    if (endPoint) {
      await rerouteTo(endPoint.geometry.coordinates, endCoordText.value || null);
    } else if (pendingEnd) {
      const { coords, name } = pendingEnd;
      pendingEnd = null;
      await placeEnd(coords, name);
    }
  }

  return {
    reset: resetMap,
    rerouteFromStart,
    rerouteTo,
    locateStart,
    placeStart,
    placeEnd,
    setDestination,
    parkDestination,
    currentPosition,
    coordLabel,
    /** Whether either pin is planted. */
    hasRoute: () => Boolean(startPoint || endPoint),
    start: () => startPoint,
    end: () => endPoint,
    lastFix: () => lastFix,
    /** The destination parked waiting for a start, taken and cleared. */
    takeParked: () => {
      const held = pendingEnd;
      pendingEnd = null;
      return held;
    },
    /**
     * A start that exists with no marker under it.
     *
     * The state left by the locate control being switched off: the fix it
     * adopted is still the origin and the pin that showed it is gone. It is the
     * state itself rather than a flag kept alongside it.
     */
    startWithoutMarker: () => startPoint !== null && startMarker === null,
    noteFix: (fix) => { lastFix = fix; },
  };
}
