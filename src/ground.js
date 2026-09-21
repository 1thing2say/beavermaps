// Who draws the ground, and what to say when they will not.
//
// Two providers, and the switch between them is not symmetrical. Mapbox is a
// vector style this app reconfigures; Google is a raster layer under a BLANK
// style, which means every decision the style would have made — lighting,
// label colours, what a mask has to cover — has to be made by hand on that
// side. `sync` is where the two are reconciled, and `styleKey` is what stops it
// doing the work when nothing that matters has changed.
//
// THE REFUSALS ARE SAID ONCE PER STATUS. There is one `error` event per refused
// tile and the renderer keeps asking as the camera moves — 29 for two camera
// moves on a phone-sized viewport — so an unguarded setStatus would rewrite the
// same sentence into the panel several times a second for as long as the map
// was touched. The set is never cleared: nothing a visitor can do from inside
// the page changes a token's URL restrictions, so a second telling would be a
// second telling of something they already know.

import { googleGround } from './google-tiles.js';
import { mapboxRefusal, MAPBOX_HOST } from './basemap-problem.js';
import { styleKey } from './palette.js';
import { CAMPUS_BOUNDS } from './campus-bounds.js';

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {string} deps.googleKey
 * @param {Function} deps.provider
 * @param {Function} deps.basemap
 * @param {Function} deps.theme
 * @param {Function} deps.skin
 * @param {Function} deps.appliedStyleKey()     what is currently on the map
 * @param {Function} deps.setAppliedStyleKey
 * @param {Function} deps.setStyleBuilt
 * @param {Function} deps.litPalette
 * @param {Function} deps.setStatus
 * @param {Function} deps.setNotice  for a refusal the app recovered from
 * @param {Function} deps.rebuild             re-run every layer builder
 * @param {Function} deps.clearHover          a hover cannot survive a style swap
 * @param {Function} deps.standBuildings
 * @param {Function} deps.providerControl()     the toggle, so it can be re-labelled
 */
export function createGround({
  map,
  googleKey,
  provider,
  basemap,
  theme,
  skin,
  appliedStyleKey,
  setAppliedStyleKey,
  setStyleBuilt,
  litPalette,
  setStatus,
  setNotice,
  rebuild,
  clearHover,
  standBuildings,
  providerControl,
  setProvider,
  captureStyleLights,
}) {
  /**
   * When Mapbox itself refuses.
   *
   * Google's half of the switch has always said why it failed; this half drew a
   * black rectangle. See src/basemap-problem.js for the asymmetry that made
   * that seem reasonable, and for what the two statuses mean.
   *
   * SAID ONCE PER STATUS. There is one of these events per refused tile and the
   * renderer keeps asking as the camera moves — 29 for two camera moves, on a
   * phone-sized viewport — so an unguarded setStatus would rewrite the same
   * sentence into the panel several times a second for as long as the map was
   * touched. The set is never cleared: nothing a visitor can do from inside the
   * page changes a token's URL restrictions, so a second telling would be a
   * second telling of something they already know.
   */
  const refusals = new Set();
  map.on('error', (e) => {
    const status = e.error?.status;
    // `url` rather than the event's sourceId: our own sources fetch from this
    // origin and a 403 from one of those would be a different problem with a
    // different fix, and would be a lie in this sentence.
    let host = null;
    try { host = new URL(e.error.url).host; } catch { /* not an AJAXError */ }
    if (host !== MAPBOX_HOST || refusals.has(status)) return;
    const problem = mapboxRefusal(status, window.location.origin);
    if (!problem) return;
    refusals.add(status);
    setStatus(problem, true);
  });

  // Mapbox Standard hides its layers behind a style package, so when something
  // looks wrong the only way to ask what the map actually built is from the
  // console. Dev builds only — Vite strips this branch from production.
  if (import.meta.env.DEV) {
    window.map = map;
    // Mapbox reports bad layer specs through this event rather than by throwing,
    // and the message is the only thing that says *which* property it rejected.
    // Status and URL as well as the message, because the message is empty on
    // exactly the errors that matter most — an AJAXError carries its cause in
    // `status`, and a bare `console.error('map error:', '')` was how a wall of
    // 403s managed to look like nothing at all.
    map.on('error', (e) => console.error(
      'map error:', e.error?.message || e.error?.status || e, e.error?.url ?? '',
    ));
  }

  // Which provider the layers currently on the map were built for. Compared
  // against the live value when a session resolves, so a toggle back to Mapbox
  // during the round trip cannot land Google's tiles on the Mapbox style.
  let groundGeneration = 0;
  // `providerControl` arrives as a getter rather than being held here: main.js
  // builds the toggle, and the failure path below only needs to be able to put
  // its button back.

  /**
   * Put Google's raster underneath everything, when Google is the provider.
   *
   * Asynchronous because the tiles cannot be requested until a session token
   * has been minted, which means this resolves well after style.load has
   * returned and our own layers already exist. Hence the explicit `beforeId`:
   * the raster has to go to the *bottom* whenever it arrives, not on top of the
   * campus it is supposed to sit under.
   */
  async function addGoogleGround() {
    if (provider() !== 'google') return;
    const generation = ++groundGeneration;

    // Only while THIS request is the current one. A toggle away and back mints
    // a second session, and the first one resolving must not take the spinner
    // off a request that is still in flight — hence the generation check in the
    // finally rather than an unconditional clear.
    providerControl()?.busy(true);
    try {
      const source = await googleGround({
        key: googleKey,
        basemap: basemap(),
        theme: theme(),
        // The raster has to wear the same look as the campus drawn on top of
        // it, or the mask edge becomes a seam between two design languages —
        // the same reason the theme is passed, one axis further out.
        skin: skin(),
        bounds: CAMPUS_BOUNDS,
      });

      // The style may have been swapped out from under this request. The
      // generation counter is the whole check: it is bumped by every setStyle,
      // and this only ever runs from style.load, so the style is initialised by
      // definition.
      //
      // Explicitly NOT map.isStyleLoaded(). That reports whether the style is
      // *idle* — it returns false while any source cache is still loading, any
      // image is in flight, or any pattern is pending. The campus sheet is ~2 MB
      // of GeoJSON fetched over the network, so by the time a session token has
      // been minted it is reliably still false, and gating on it meant this
      // returned silently and the ground was never added. No error, no layer.
      if (generation !== groundGeneration || provider() !== 'google') return;
      if (map.getLayer('google-basemap')) return;

      if (!map.getSource('google-tiles')) map.addSource('google-tiles', source);
      // Bottom of the stack, whoever else got there first. Our own layers were
      // added synchronously back in style.load, so there is normally something
      // to go under; the optional chain covers the case where there is not.
      map.addLayer(
        { id: 'google-basemap', type: 'raster', source: 'google-tiles' },
        map.getStyle().layers[0]?.id,
      );
    } catch (error) {
      // A refused key is not a bug the user can see the shape of, and Google's
      // own message names the cause (API not enabled, referrer not allowed, key
      // invalid), so the sentence goes to the strip — for the person who
      // deployed this, who is the only one who can act on it and may well be
      // reading it on a phone with no console to look in.
      //
      // A NOTICE RATHER THAN A REFUSAL, though, and the two lines below are why:
      // the toggle drops back to a provider that works, so by the time this is
      // said there is a map again. An error opens the panel it is written into
      // — which on a phone is not a card in a sidebar, it is the bottom sheet,
      // so announcing a successful fallback cost a third of the screen and the
      // app came up with a panel over the campus. See `notice` in
      // src/status-line.js: it holds the strip the way a problem does and
      // leaves the layout alone.
      console.error('Google basemap unavailable:', error);
      setNotice(`Google basemap unavailable: ${error.message}`);
      if (generation !== groundGeneration) return;
      setProvider('mapbox');
      providerControl()?.revert();
      syncBasemapStyle();
    } finally {
      // `revert()` above already repainted the buttons, and `busy(false)` calls
      // the same `paint()`, so the failure path is idempotent rather than
      // fighting itself.
      if (generation === groundGeneration) providerControl()?.busy(false);
    }
  }

  // Fires on first load *and* after every setStyle, which is exactly when the
  // custom layers need rebuilding.
  map.on('style.load', () => {
    // Before the builders, not after. A swap rebuilds every pin layer with its
    // plain size expression, so a hover held across one would be a pin that is
    // no longer big while `hoveredPin` still says it is — and the next mousemove
    // over the same pin would match, do nothing, and leave it flat for good.
    clearHover();
    // Standard's own lights, before anything has had a chance to override them.
    // Captured per style load rather than once, because a setStyle replaces
    // them wholesale — and satellite's are not the map style's.
    captureStyleLights(structuredClone(map.getLights() ?? null));
    setStyleBuilt(true);
    rebuild();
    addGoogleGround();
  });

  /**
   * Swap the basemap if the current provider/basemap/theme triple calls for a
   * different one. All three toggles route through here: on satellite the theme
   * no longer changes the Mapbox map, so this becomes a no-op and only the page
   * chrome restyles.
   */
  function syncBasemapStyle() {
    const nextKey = styleKey(provider(), basemap(), theme(), skin());

    if (nextKey !== appliedStyleKey()) {
      setAppliedStyleKey(nextKey);
      // Invalidate any session request still in flight for the outgoing style.
      groundGeneration++;
      // Nothing to configure between here and the next style.load: the layers
      // the bench writes to are about to stop existing. style.load sets it back.
      setStyleBuilt(false);
      // diff:false forces a full style reload. The default diffing path can
      // drop custom layers without firing style.load, leaving a bare basemap.
      // style.load re-adds our layers and re-requests the ground.
      map.setStyle(litPalette().style, { diff: false });
      return;
    }

    // Both toggles call this once on startup to publish their initial state,
    // and that can land before the first style has loaded. There is nothing to
    // restyle yet and every builder below would throw; style.load runs them.
    if (!map.isStyleLoaded()) return;

    // Same style, different look: light and dark are one Standard style under
    // two light presets. Re-running the builders applies the new palette to
    // layers that already exist, so the map recolours without a reload and
    // without dropping the route or the campus mask.
    //
    // The hover goes first for the same reason it does on a style swap: those
    // builders push a plain `text-color` and a plain `icon-size` over whatever
    // the hover had written, and a `hoveredPin` still naming the pin underneath
    // would make the next mousemove over it a no-op.
    clearHover();
    rebuild();
    if (map.getLayer('campus-buildings')) standBuildings();
  }
  return { addGoogle: addGoogleGround, sync: syncBasemapStyle };
}
