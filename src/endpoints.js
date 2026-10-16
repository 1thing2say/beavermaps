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
// it. Scattered, it was a variable anyone could increment; here it goes up only
// where something supersedes what is in flight — a reset, a new destination, a
// new route request — and nothing outside this file can touch it.
//
// WHAT A CHOSEN PLACE MEANS still belongs to the caller. This module knows how
// to plant a pin and ask for a route; the place cards and the route panel's
// own fields call `setDestination`, and neither needs to know the other
// exists. Everything else that finds a place — search, the shortcuts, a list
// row — opens that place's card, whose Directions button is the way in here.

import mapboxgl from 'mapbox-gl';
import { point } from '@turf/helpers';
import { distance } from '@turf/distance';
import { nearestPoint } from '@turf/nearest-point';
import { routePin, liftedOffset, ROUTE_PIN_W } from './map-images.js';
import { reachProblem, locationProblem } from './directions.js';
import { UNREACHABLE } from './api.js';

/**
 * What to say when the phone is outside the map's fence and nothing recorded
 * where.
 *
 * `{ code: 'outside' }` is ours rather than the browser's — see currentPosition
 * — so it is answered here, beside the code that raises it, and every other
 * code still goes to locationProblem. It ends the way those do, with the hold
 * that is always a way forward. Normally it is not reached at all: the fix the
 * fence turned away is in hand, and reachProblem says how far off it is, which
 * is the more useful sentence.
 */
export const OUTSIDE_FENCE = 'You are outside the area this map covers, so it cannot route from '
  + 'where you are. Press and hold the map to set a starting point instead.';

// Google's own pin colours, for the two markers the router plants. Origin green
// and destination red is their convention as well as the one this app already
// used; only the values move.
export const GOOGLE_GREEN = '#1e8e3e';
export const GOOGLE_RED = '#ea4335';

/** Nothing to draw, in the shape every geojson source expects. */
const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * @param {object} deps  every collaborator, named for what it does
 * @param {() => object|null} deps.geolocateControl  a GETTER: the control is
 *        built on map load, long after this is
 * @param {() => {at: number[]}|null} [deps.lastPosition]  the last position the
 *        geolocation seam delivered, fence or no fence — see currentPosition
 * @param {(colour: string, title: string, at: number[]) => object} [deps.plantPin]
 *        puts one of the route's two pins on the map and returns the marker.
 *        Mapbox's by default; a seam because a Marker wants a whole browser
 *        under it, and the sequencing these pins take part in is exactly what
 *        test/endpoints.test.js and test/endpoints-reroute.test.js have to
 *        drive end to end.
 */
export function createEndpoints({
  map,
  route,
  nav,
  camera,
  api,
  geolocateControl,
  lastPosition = () => null,
  networkPoints,
  routingEnabled,
  status,
  panel,
  ui,
  paintLegs,
  clearSelection,
  clearSearchField,
  startLocating,
  plantPin = (colour, title, at) => new mapboxgl.Marker({
    element: routePin(colour, { title }),
    anchor: 'bottom',
    offset: liftedOffset(ROUTE_PIN_W),
  })
    .setLngLat(at)
    .addTo(map),
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

  /**
   * Take the walk off the screen and out of reach: the ribbon, its dotted ends,
   * the route state behind them, and the two buttons that would start it.
   *
   * Its own function because it is not only resetMap's. A route that is
   * refused or never answered has to leave the same nothing behind as Clear
   * does, and it used to leave the previous walk instead — still drawn, still
   * set, with Start and Simulate still offering to navigate a route from a
   * start that was no longer the start. Four lines kept in two places is how
   * one of the two came to have none of them.
   */
  function dropRoute() {
    nav.end();
    route.clear();
    map.getSource('calculated-route')?.setData(EMPTY);
    map.getSource('route-legs')?.setData(EMPTY);
    setNavButtonsEnabled(false);
  }

  function resetMap() {
    dropRoute();

    if (startMarker) startMarker.remove();
    if (endMarker) endMarker.remove();
    startPoint = null;
    endPoint = null;
    startIsMine = false;
    startMarker = null;
    endMarker = null;

    requestSeq++;

    clearSelection();

    // Reset UI. The search box is cleared too: leaving a destination showing
    // next to "Not set" is the kind of stale text people act on.
    pendingEnd = null;
    clearSearchField();
    setIdleStatus();
    startCoordText.value = '';
    endCoordText.value = '';
    setRouteSummary(null);
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

  const isFresh = (seen) => Boolean(seen) && Date.now() - seen.when < FIX_FRESH_MS;

  /**
   * The newest thing known about where the phone is, as { at, when }, or null.
   *
   * `lastFix` is fed by `geolocate` alone, so it never holds a fix the fence
   * turned away — and THE FENCE TURNS ONE AWAY ONLY ONCE. On an out-of-bounds
   * fix Mapbox puts its button into the error state and fires `outofmaxbounds`,
   * but it does not fire `trackuserlocationend`: the watch keeps running and
   * locate.js rightly goes on believing the control is locating. So the second
   * Directions press asked for nothing — startLocating was a no-op — and waited
   * on the next report from a watch that, on a desk or in a pocket, may not
   * report again until the phone moves. Nine seconds later, with `lastFix`
   * still empty, it said "Locating timed out" to the same phone that had
   * answered the first press at once. The seam's record holds that fix, so a
   * FRESH one newer than `lastFix` is the answer; otherwise `lastFix` is, at
   * whatever age (see the timer in currentPosition for why age is no bar).
   */
  function lastSeen() {
    const recorded = lastPosition();
    const newer = isFresh(recorded) && (!lastFix || recorded.when > lastFix.when);
    return newer ? recorded : lastFix;
  }

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
   *
   * OUTSIDE THE FENCE THE CONTROL SAYS SOMETHING ELSE. The map has maxBounds,
   * and for a fix beyond them the control fires `outofmaxbounds` instead of
   * `geolocate`. Nothing listened for it, so a phone at home answered at once
   * and Directions still spun for the full nine seconds and then said
   * "Locating timed out" — the one thing that had not happened. The event is
   * built by copying the position's own properties, and a real position has
   * none (its coords are prototype getters), so where it was is read from the
   * geolocation seam's own record instead. With that in hand locateStart's
   * reach check says how far away you are; without it, `{ code: 'outside' }`
   * says you are off the map, which is all that is known. And the second press
   * after that is answered from the same record before anything is waited on —
   * see lastSeen.
   */
  function currentPosition() {
    const seen = lastSeen();
    if (isFresh(seen)) return Promise.resolve(seen.at);

    return new Promise((resolve, reject) => {
      // THROUGH THE GETTER. main.js hands this over as `() => control`, because
      // the control is not built until the map has loaded — and this read it
      // as the control itself. A function is always truthy, so the guard
      // below never fired and `.on` threw inside this executor: the promise
      // rejected on the spot, and Directions answered "could not get a
      // location fix" on every device that had not already put its blue dot
      // up, without ever asking for a fix. The timer then threw `.off is not a
      // function` a few seconds later, which is how it was found.
      const control = geolocateControl();
      if (!control) { reject({ code: 2 }); return; }
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        control.off('geolocate', onFix);
        control.off('error', onFail);
        control.off('outofmaxbounds', onOutside);
        fn(value);
      };
      const onFix = (e) => finish(resolve, [e.coords.longitude, e.coords.latitude]);
      const onFail = (error) => finish(reject, error);
      const onOutside = (e) => {
        // `e.coords` first, in case a later Mapbox starts passing it through.
        const at = e?.coords
          ? [e.coords.longitude, e.coords.latitude]
          : lastPosition()?.at;
        if (at && Number.isFinite(at[0]) && Number.isFinite(at[1])) finish(resolve, at);
        else finish(reject, { code: 'outside' });
      };
      const timer = setTimeout(() => {
        // A STALE FIX BEATS A REFUSAL. A watch that has locked on and gone
        // quiet is what a stationary phone looks like — some browsers report
        // once and then say nothing until you move — and the last thing it said
        // is still where you are standing. Refusing to route somebody who has
        // not moved, because they have not moved, is the worst reading of this.
        //
        // The seam's record counts too, which is the case it is there for: see
        // lastSeen.
        const last = lastSeen();
        if (last) finish(resolve, last.at);
        else finish(reject, { code: 3 });
      }, FIX_TIMEOUT_MS);
      control.on('geolocate', onFix);
      control.on('error', onFail);
      control.on('outofmaxbounds', onOutside);
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
   * Four ways to fail, and all four are said out loud rather than swallowed:
   * the browser refuses or times out (see locationProblem), the phone is past
   * the map's fence with no fix on record (see OUTSIDE_FENCE), or the fix
   * lands outside the routing graph (see reachProblem). The last is the quiet one —
   * the router snaps a start onto the network with no notion of "too far",
   * so opening this at home ten miles away would otherwise draw a confident
   * eight-minute walk between two places neither of which is where you are.
   *
   * Returns whether there is now a start point to route from.
   */
  async function locateStart() {
    // Both are GETTERS — see the note in currentPosition. Read as values, a
    // function is always truthy: the guard never stopped anything, and the
    // snap below was handed a function where it wanted the vertex cloud, found
    // nothing in it and threw on `.geometry`. So a start from your location
    // failed even when a fix arrived, as did Start here on any card.
    if (!routingEnabled() || !networkPoints()) return false;

    // A fix can take nine seconds, and Clear or Close pressed in the meantime
    // is somebody changing their mind. Both go through resetMap, which bumps
    // the sequence — as does a newer setDestination, which is the same change
    // of mind made by picking somewhere else — so the answer that arrives
    // afterwards is checked against this and dropped. It used to put the start
    // back, and its failure used to write "Locating timed out" over the idle
    // line the reset had just put up. Same guard placeEnd keeps, for the same
    // reason.
    //
    // And a walk already drawn runs from the start this is about to replace:
    // nine seconds is plenty of time to press Start on it, and have the
    // re-route that follows swap the route out from under the walk. So it
    // cannot be started while its start is in question. If the start stays
    // where it was, so does the walk, and the buttons come back; unless
    // something newer has been asked for in the meantime (the sequence moved),
    // which owns the buttons now. See placeEnd.
    const seq = requestSeq;
    setNavButtonsEnabled(false);
    const keepRoute = () => { if (seq === requestSeq) setNavButtonsEnabled(route.isWalkable); };

    // The fixture answers on the next tick, so this spinner is a real wait only
    // for a real GPS — which is exactly when it is worth showing.
    setBusy(true);
    setStatus('Finding your location…');
    let at;
    try {
      at = await currentPosition();
    } catch (error) {
      if (seq === requestSeq) {
        setStatus(error?.code === 'outside' ? OUTSIDE_FENCE : locationProblem(error), true);
      }
      keepRoute();
      return false;
    } finally {
      setBusy(false);
    }
    if (seq !== requestSeq) return false;

    // The nearest VERTEX is only the reach check here. It is never nearer
    // than the nearest point on an edge, which is what the server measures,
    // so this check is the stricter of the two — by nothing that matters,
    // since the worst point in the graph's bounding box is about 215 m from a
    // vertex (see REACH_M). What it is not is where the walk starts. It used
    // to be: the fix was replaced by this vertex before it was sent, and since
    // the build collapsed straight runs into single long edges that vertex can
    // be fifty metres along the path you are standing beside, so the walk
    // began by going there. The fix itself goes to the server, which joins the
    // network at the nearest point on it and answers where (`snapped`); the
    // dotted leg from the blue dot to the line is that last bit of ground.
    const node = nearestPoint(point(at), networkPoints()).geometry.coordinates;
    const problem = reachProblem(distance(point(at), point(node)) * 1000);
    if (problem) { setStatus(problem, true); keepRoute(); return false; }

    panel.show();
    startPoint = point(at);
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
    if (!routingEnabled()) return false;

    const vertices = networkPoints();
    if (vertices) {
      const node = nearestPoint(point(coords), vertices).geometry.coordinates;
      const problem = reachProblem(distance(point(coords), point(node)) * 1000);
      if (problem) { setStatus(problem, true); return false; }
    }

    panel.show();
    startPoint = point(coords);
    // Somebody chose this, so Directions on the next card routes FROM it rather
    // than replacing it with a GPS fix. See startIsMine.
    startIsMine = false;
    startMarker?.remove();
    startMarker = plantPin(GOOGLE_GREEN, 'Start', coords);
    startCoordText.value = label ?? coordLabel(coords);
    return true;
  }

  /**
   * A BUILDING'S PIN GOES TO THE DOOR THE WALK USED. A building is asked for
   * by its entrance, and the server may start or end the walk at another of
   * its doors — whichever suits where you are coming from or going to (`door`
   * in the answer; see `entrances` in server/graph.js). The pin moves there
   * rather than staying at the door it was asked about with a dotted line
   * across the building to it; the label still names the building. Moving the
   * point too means a re-route asks for the building again by one of its
   * doors, and is again free to pick.
   */
  function standAtDoors(door) {
    if (door?.to) {
      endPoint = point(door.to);
      endMarker?.setLngLat(door.to);
    }
    if (door?.from && !startIsMine) {
      startPoint = point(door.from);
      startMarker?.setLngLat(door.from);
    }
  }

  async function placeEnd(coords, label) {
    if (!routingEnabled()) return;
    panel.show();
    endPoint = point(coords);
    // Being routed now, so no longer waiting for a start. See the refusal
    // below, which is the one place that parks it again.
    pendingEnd = null;
    endMarker?.remove();
    endMarker = plantPin(GOOGLE_RED, 'Destination', coords);
    endCoordText.value = label ?? coordLabel(coords);
    setStatus('Calculating route…');

    // Guard against a stale response landing after the user has moved on.
    const seq = ++requestSeq;
    // The route still drawn is the one this request replaces, so it cannot be
    // started while the request is out. Left enabled, Start began a walk along
    // the old line, and the answer then swapped the route out from under it:
    // navigation kept counting maneuvers the new route did not have, and
    // threw on every fix after. Enabled again only by an answer that is a walk.
    setNavButtonsEnabled(false);
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
      // The detail is for the console; the visitor gets a sentence they can
      // act on, which is not the dev-server question. See UNREACHABLE.
      console.error(error);
      failure = UNREACHABLE;
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
      // THE OLD WALK GOES, AND THE DESTINATION STAYS. This used to do the
      // opposite. Retyping the start re-routes to the same destination, and
      // when that came back refused — a start inside the building you are
      // going to is "the same place" — the walk from the PREVIOUS start stayed
      // drawn with Start enabled, while the destination it led to was
      // dropped. The end field still named it, so nothing looked wrong, but
      // the next start had nowhere to route to and did nothing at all.
      //
      // So the walk is taken down, as Clear would, and the destination is
      // parked exactly as parkDestination leaves one: pin and label where they
      // are, held in `pendingEnd` for the next start to pick up.
      dropRoute();
      endPoint = null;
      pendingEnd = { coords, name: label };
      return;
    }

    // A walk already running is on the route this replaces. Navigation reads
    // the route live, so swapping it under a running walk left its step
    // counter pointing into a maneuver list it no longer had. The buttons
    // above keep that from starting here; this is for one that already had.
    nav.end();

    // `stepIndex` used to be zeroed here too. It is navigation's, it is only
    // ever read while a walk is running, and nav.start() zeroes it — so this
    // was resetting a counter nothing could have read.
    //
    // The pins are stood at their doors FIRST, because the legs are measured
    // from where the pins end up: a building's leg is from the door the walk
    // used, which is nothing, not from the door it was asked about.
    standAtDoors(result.door);
    route.set(result, { from: startPoint?.geometry.coordinates, to: endPoint?.geometry.coordinates });

    // Optional, as resetMap's is. A basemap, theme or skin change while this
    // request was out replaces the style, and until style.load rebuilds it
    // the source does not exist. The throw that followed skipped everything
    // below — the summary, the buttons, "Route calculated" — and left the panel
    // on "Calculating route…". Nothing is lost by skipping the line: the
    // rebuild seeds the source from route.feature(). See src/route-layers.js.
    map.getSource('calculated-route')?.setData(route.feature());
    paintLegs();

    // The whole walk, dotted legs and all; see measureLegs in route-state.js.
    setRouteSummary(result.distanceFeet + route.legFeet.from + route.legFeet.to);
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
    endMarker = plantPin(GOOGLE_RED, 'Destination', coords);
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
    if (!routingEnabled()) {
      map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 17), duration: 900 });
      return;
    }

    // Both ends already set: start over rather than accumulating markers. The
    // start survives it — see below — so this is only clearing the old walk.
    const keep = startPoint && !startIsMine ? startPoint : null;
    if (startPoint && endPoint) resetMap();
    if (keep) { startPoint = keep; startIsMine = false; }
    // BUMPED, not just read, because a newer destination supersedes this one.
    // It was only read, on the reasoning that nothing but Clear or Close could
    // move it while the GPS was being asked — and a second Directions is the
    // other thing. Pick A, then B while the spinner is still up (nine seconds
    // of it is a long time not to tap another card): with no start point there
    // was no reset, so both calls held the same number; the fix resumed A
    // first, A's placeEnd bumped it, and B — the place actually wanted — saw
    // the change and quietly stood down. Taking a number of our own means A's
    // locateStart and A here are the ones that find it moved, and both stand
    // down without a word, as they would for Clear. After the reset above, so
    // that bump is not mistaken for somebody else's. See locateStart.
    const seq = ++requestSeq;
    // Before the flyTo below, so the camera is framing the space the panel has
    // already taken rather than the space it is about to.
    panel.show();

    if (!(startPoint && !startIsMine)) {
      const located = await locateStart();
      // Cleared while locating: neither branch below is wanted any more. Parking
      // would put back the red pin that Clear just took away, and routing would
      // draw a walk nobody is still asking for.
      if (seq !== requestSeq) return;
      if (!located) {
        // No fix, and locateStart has already said why. The destination still
        // goes down, so that sentence is read next to a map showing where you
        // asked to go rather than next to nothing.
        parkDestination(coords, name);
        return;
      }
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

  /**
   * "Start here" on a pin's card: make the point the start, then route to the
   * destination there already is, whether drawn or parked.
   *
   * placeStart alone only moves the start. With a walk on screen that left
   * the old one drawn from the old start, with Start still offering to walk
   * it, under a start field naming the new one. With a destination parked it
   * left that waiting, though parkDestination promises the next start
   * routes it. The start field's own pick does placeStart and then
   * rerouteFromStart, and the cards now go through the same pair.
   *
   * @returns {Promise<'refused'|'routed'|'waiting'>} refused when placeStart
   *          turned the point down (and has said why); waiting when there is
   *          no destination yet, which the caller may want to say
   */
  async function startHere(coords, label) {
    if (!placeStart(coords, label)) return 'refused';
    if (!endPoint && !pendingEnd) return 'waiting';
    await rerouteFromStart();
    return 'routed';
  }

  return {
    reset: resetMap,
    rerouteFromStart,
    startHere,
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
