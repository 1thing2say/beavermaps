// Which panel is open, and what opening one does to the others.
//
// Four cards share one map: the route panel, the legend, the place card and the
// category list. On a desktop they stack down the left; on a phone they are one
// sheet, and only one of them can be up at a time. Every open and close is also
// a camera move, because `campusPadding` reserves room for whatever is showing
// — so the rules about which card closes which are the same rules that decide
// where the campus ends up on screen, and they were spread across five
// functions in the middle of everything else.
//
// ONLY WHEN IT ACTUALLY MOVED. Every endpoint set calls `showRoute`, and an
// easeTo per click on an already-open panel is a camera that drifts while you
// are trying to use it.

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {object} deps.sidePanel      the route panel
 * @param {object} deps.legendPanel
 * @param {object} deps.layersBtn
 * @param {object} deps.layersMenu
 * @param {object} deps.legendOpen     the row inside the layers menu
 * @param {Function} deps.isPhone
 * @param {Function} deps.campusPadding
 * @param {Function} deps.routingEnabled
 * @param {object} deps.directionsBtn  the button that opens the route panel
 * @param {object} deps.debugLegend    the debug menu's own legend row
 * @param {object} deps.legendClose
 * @param {Function} deps.clearLegendHighlight()
 */
export function createPanels({
  map,
  sidePanel,
  legendPanel,
  layersBtn,
  layersMenu,
  legendOpen,
  isPhone,
  campusPadding,
  routingEnabled,
  directionsBtn,
  debugLegend,
  legendClose,
  clearLegendHighlight,
}) {
  /** Show or hide a floating card, keeping the button that owns it in step. */
  function toggleSheet(sheet, button, force) {
    const open = force ?? sheet.classList.contains('hidden');
    sheet.classList.toggle('hidden', !open);
    button?.setAttribute('aria-expanded', String(open));
    return open;
  }

  /**
   * Show or hide the route panel, and re-frame the campus behind it.
   *
   * The panel is what `campusPadding` reserves room for, so the map has to be
   * re-centred when it comes or goes or the campus ends up visibly off to one
   * side of the space left over. Only when it actually moved, though — every
   * endpoint set calls showRoutePanel, and an easeTo per click on an already
   * open panel is a camera that drifts while you are trying to use it.
   */
  function toggleRoutePanel(force) {
    // The one card on this map that can be switched off entirely. Nothing is
    // allowed to open it while the debug menu has the route GUI off, or the
    // stylesheet would be hiding a panel this function had just told the camera
    // to reserve room for — and the campus would sit off to one side of a gap
    // with nothing in it.
    const want = routingEnabled() ? force : false;
    const was = !sidePanel.classList.contains('hidden');
    const open = toggleSheet(sidePanel, directionsBtn, want);
    directionsBtn.setAttribute('aria-label', open ? 'Hide directions' : 'Directions');
    if (open !== was) map.easeTo({ padding: campusPadding(), duration: 300 });
    return open;
  }

  /**
   * Bring the route panel up because something needs to be read in it.
   *
   * The panel starts closed, which means every message this app writes about a
   * route — the distance, "Now press and hold to set an end point", a routing
   * server that is down — is being written into a hidden card. Anything that
   * sets an endpoint or reports an error opens it first, so the panel appears
   * at the moment it acquires something to say and not before.
   */
  function showRoutePanel() {
    toggleRoutePanel(true);
  }

  /**
   * Show or hide the legend, and re-frame the campus beside it.
   *
   * Same arrangement as the route panel and for the same reason, which this
   * did not have while it was a sheet in the left column behind a menu row: it
   * holds 320px of the right edge now, campusPadding reserves that width, and
   * a close that did not re-frame left the camera keeping the campus out of a
   * strip with nothing in it.
   */
  function toggleLegendPanel(force) {
    const was = !legendPanel.classList.contains('hidden');
    const open = toggleSheet(legendPanel, legendOpen, force);
    // The debug menu's row is a second surface on this one piece of state, like
    // its map-type and look buttons are on theirs. Only the attribute is
    // repeated here; the panel's own class is still the single source of truth,
    // and both buttons read it through this function.
    debugLegend.setAttribute('aria-expanded', String(open));
    if (open !== was) map.easeTo({ padding: campusPadding(), duration: 300 });
    return open;
  }

  // `phone` and the legend's opening state are set up with the panels — see
  // there for why. This is only the button catching up with what was decided.
  legendOpen.setAttribute('aria-expanded', String(!legendPanel.classList.contains('hidden')));

  legendClose.addEventListener('click', () => {
    // The outline first, so the category's pins are already gone by the time
    // the re-frame runs and the camera is not fitting a set of markers that is
    // about to be taken off the map.
    //
    // A highlight with its legend closed is a purple campus and nothing on
    // screen saying why, so the outline — and the category it belongs to — go
    // when the panel does.
    clearLegendHighlight();
    toggleLegendPanel(false);
  });

  /** What either legend button does. */
  function onLegendPressed() {
    toggleSheet(layersMenu, layersBtn, false);
    const open = toggleLegendPanel();
    if (!open) { clearLegendHighlight(); return; }
    // On the phone these two are alternatives, not a stack: both at once is a
    // sheet over two thirds of the screen with three legend rows showing, and a
    // campus squeezed into the strip above it.
    if (isPhone()) toggleRoutePanel(false);
  }
  return {
    toggleSheet,
    toggleRoute: toggleRoutePanel,
    showRoute: showRoutePanel,
    toggleLegend: toggleLegendPanel,
    onLegendPressed,
  };
}
