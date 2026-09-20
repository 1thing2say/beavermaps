// What each switch in the back room actually does to the running app.
//
// SEPARATE FROM src/debug.js, which is the menu itself — the markup, the
// toggles, the persistence. This is the other half: given a set of flags, put
// the app into that state. The split matters because the menu is furniture and
// this is behaviour, and because every line here has to answer the same
// question — does switching it back leave the app exactly as it was?
//
// THE RULE THE BACK ROOM IS BUILT ON: with the menu shut the app is exactly the
// app. Nothing here may persist past a reload except through the menu's own
// storage, and nothing may leave a trace the visitor could mistake for a
// decision somebody made.

/**
 * @param {object} deps  the pieces each switch reaches for, named for what it does
 */
export function createDebugFlags({
  geolocation,
  centre,
  endpoints,
  locate,
  applyLighting,
  toggleRoutePanel,
  showNavbar,
  directionsBtn,
  setOpen,
  setShowFps,
  setRoutingEnabled,
  routingEnabled,
}) {
  function applyDebug({ open, routing, gps, fps, twopoint, navbar, dirbutton }) {
    // Read by the next card rather than applied to the open one: the readout is
    // built with the flyover, and there is no sensible thing to do to a viewport
    // that is already orbiting.
    setShowFps(open && fps);

    // The gate the lighting bench is read through. Set before anything else
    // here, so applyLighting sees the new state whichever path reaches it.
    setOpen(open);
    applyLighting();

    // "Off by default" means off once you are in the back room, not off for
    // everybody: with the panel closed this is the app, and the app gives
    // directions. `open &&` is the whole of that guarantee, twice.
    setRoutingEnabled(!open || routing);
    document.body.classList.toggle('no-routing', !routingEnabled());
    if (!routingEnabled()) toggleRoutePanel(false);

    // The three developer controls: "Start here" on a place card, and Simulate
    // and Clear on the route panel. Same `open &&` guarantee as the switch
    // above — with the menu shut these are simply not on the screen, which is
    // the point of moving them. The stylesheet does the hiding, so a card built
    // while the switch was on does not have to be rebuilt when it goes off.
    document.body.classList.toggle('no-twopoint', !(open && twopoint));

    // NOT gated on the menu being open, and it is the only flag here that is
    // not. The rule the back room is built on is that a LIE cannot follow you
    // out of it — a routing GUI switched off, a GPS fix that is not yours —
    // because those change what the app tells a visitor about the world. This
    // one changes where the search field is. It is a layout, like the skin and
    // the map type, and those persist too; a header that vanished the moment
    // you closed the menu you turned it on in would just look broken.
    showNavbar(navbar);

    // The blue circle beside the search field, and off unless asked for.
    //
    // NOT gated on the menu being open, for the same reason the header above is
    // not: it is a piece of layout rather than a lie, and it can be left on.
    // What it opened was an empty two-ended route form — the shape you want
    // when you are building a map and have two arbitrary points in mind, and
    // not the shape of the question a visitor has. Theirs is "where is X", and
    // the answer to that is a place card with Directions on it, which sets the
    // destination and reads the start off the GPS without ever showing an empty
    // form. So the form is the special case now, and the button that opens it
    // moved in here with the rest of the map-building furniture.
    document.body.classList.toggle('no-dirbutton', !dirbutton);
    if (!dirbutton) directionsBtn?.setAttribute('aria-expanded', 'false');

    const fixture = open && gps;

    // A start that came from the fixture is a start with no marker — the dot was
    // the marker. Switching the fixture off takes the dot away and would leave a
    // route running from a point nothing on the map is drawing, so the route
    // goes with it. `startPoint && !startMarker` is that state exactly, and it
    // is the state itself rather than a flag kept alongside it.
    if (!fixture && endpoints.startWithoutMarker()) endpoints.reset();

    // Where the position comes from, not whether the app is looking for one.
    // Switching the fixture off hands the watch already in flight back to the
    // real GPS rather than putting the dot away, which is the honest thing: it
    // shows you what the real one actually does from here.
    geolocation.useFixture(fixture ? centre : null);
    if (fixture) locate.start();
    else locate.relock();
  }
  return { apply: applyDebug };
}
