// The panel, and everything that goes in it.
//
// One panel, several kinds of card: a dropped pin's two lines, an amenity's,
// a whole building's, and the browse-by-kind list. They share a container, an
// exit animation and a rule about the camera — whatever a card is about gets
// brought into view when it opens — and they were spread over three hundred
// lines of startApp() with the flyover and the sheet wedged between them.
//
// THE EXIT TIMERS ARE THE REASON THIS IS AWKWARD and the reason it is worth
// having in one place. A card that is closing is still in the DOM for the
// length of its animation, so "empty it" cannot run immediately and cannot run
// twice; `afterExit` holds one timer per element in a WeakMap so a card
// reopened mid-exit does not get emptied out from under itself.

import { canFlyOver, framing, footprintExtent, roofOf, massOf } from './flyover.js';
import { createFlyover } from './flyover-view.js';
import { poiFor } from './poi.js';
import { buildingCard } from './building-popup.js';
import { pinColour } from './map-images.js';
import { paintIcons } from './g-icons.js';
import { CAMPUS_BOUNDS } from './campus-bounds.js';
import { REVEAL_ZOOM } from './camera.js';

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {object} deps.placePanel      the card container
 * @param {object} deps.buildingsList   the browse-by-kind list
 * @param {object} deps.buildingsCount
 * @param {object} deps.camera          createCamera(), for reveal and focus
 * @param {Function} deps.directory     the building directory overlay
 * @param {Function} deps.highlightBuilding  outline it, or clear the outline
 * @param {Function} deps.campusPadding  what the open cards are standing on
 * @param {string} deps.googleKey       the 3D tiles key, or undefined
 * @param {Function} deps.hasRoute      whether either route pin is planted
 * @param {Function} deps.resetMap      clear the route
 * @param {Function} deps.setStatus
 * @param {Function} deps.deselectPin
 * @param {Function} deps.removeDroppedMarker
 * @param {Function} deps.placeStart
 * @param {Function} deps.setDestination
 * @param {Function} deps.showFps()       debug: draw the flyover's frame rate
 * @param {Function} deps.setFlyover    hand the live flyover back to main
 * @param {Function} deps.activeFlyover
 */
export function createCards({
  map,
  placePanel,
  buildingsList,
  buildingsCount,
  camera,
  directory,
  highlightBuilding,
  deselectPin,
  campusPadding,
  googleKey,
  hasRoute,
  resetMap,
  setStatus,
  removeDroppedMarker,
  placeStart,
  setDestination,
  showFps,
  setFlyover,
  activeFlyover,
}) {
  /**
   * Empty a surface only once it has finished leaving.
   *
   * A panel now FADES OUT — `display` is carried by a transition, so `.hidden`
   * no longer takes the box away on the same frame it is set. Tearing the
   * content out synchronously, which is what every close path used to do, means
   * the 240ms that follows is spent watching an empty pane of glass shrink: the
   * card appears to be deleted and then dismissed, rather than dismissed.
   *
   * The duration is read off the element rather than off the token, so somebody
   * who has asked for reduced motion — where the same transitions run at 1ms —
   * gets their content back on the next tick instead of a quarter second later.
   *
   * Re-checked at the end because a close is cancellable: tapping the next
   * building inside the fade re-shows the panel with new content, and emptying
   * it then would clear the card that just arrived.
   */
  const exitTimers = new WeakMap();

  function afterExit(el, empty) {
    clearTimeout(exitTimers.get(el));
    const ms = Math.max(0, ...getComputedStyle(el).transitionDuration
      .split(',').map((d) => Number.parseFloat(d) * 1000)
      .filter(Number.isFinite));
    exitTimers.set(el, setTimeout(() => {
      if (el.classList.contains('hidden')) empty();
    }, ms + 20));
  }

  function showPlaceCard(card, flyover = null, { at = null, zoom = REVEAL_ZOOM } = {}) {
    // Swapped in one step, and in this order, because the incoming card may
    // already hold a live flyover of its own: tearing down after adopting would
    // destroy the one just built, and adopting before tearing down would leak
    // the one going away.
    activeFlyover()?.destroy();
    setFlyover(flyover);

    const was = !placePanel.classList.contains('hidden');
    placePanel.replaceChildren(card);
    placePanel.classList.remove('hidden');
    // Only when the column's width actually changed. Swapping one card for
    // another is a repaint, not a new obstruction, and a camera that eased on
    // every tap would drift across the campus a tap at a time.
    //
    // The sheet's own arrival is on the same test and for the same reason: a
    // card that re-slid every time you tapped the next building would read as a
    // flinch rather than as something opening. See #place-panel.is-entering.
    // Removed and re-added around a forced layout because the panel is one
    // long-lived element — a class that is already there starts nothing, and
    // relying on the close to have taken it off would make this depend on every
    // path that hides the panel remembering to.
    if (!was) {
      placePanel.classList.remove('is-entering');
      void placePanel.offsetHeight;
      placePanel.classList.add('is-entering');
    }

    // THE CAMERA, once, and after the sheet has decided how tall it is going to
    // be. Next frame rather than now: the stack notices this panel through a
    // MutationObserver, which does not run until the current task has finished,
    // and it is the stack that asks the sheet to open. Read the sheet on this
    // line and it is still the height it was before the card existed.
    //
    // A frame is enough — the detent is applied synchronously once the observer
    // runs, and `sheet.top` answers with where it is going rather than where it
    // is — so the map starts moving on the same frame the sheet starts growing
    // and the two arrive together.
    camera.setFocus(at ?? camera.focus());
    if (at) requestAnimationFrame(() => camera.reveal(at, { zoom }));
    else if (!was) map.easeTo({ padding: campusPadding(), duration: 300 });
  }

  function closePlaceCard() {
    if (placePanel.classList.contains('hidden')) return;
    activeFlyover()?.destroy();
    setFlyover(null);
    camera.setFocus(null);
    placePanel.classList.add('hidden');
    placePanel.classList.remove('is-entering');
    afterExit(placePanel, () => placePanel.replaceChildren());
    map.easeTo({ padding: campusPadding(), duration: 300 });
  }

  function closeBuildingCard() {
    closePlaceCard();
    highlightBuilding(null);
  }

  /**
   * Put everything the map is currently pointing at back down.
   *
   * Two states, and either can exist without the other: a lifted pin with no
   * card (the building name pins, which hand their card to the building), and a
   * card with no lifted pin (a tap on a footprint rather than on its label).
   * `deselectPin` cannot do both — it calls closeBuildingCard itself and would
   * recurse — so the pairing lives here, and every "never mind" goes through it.
   */
  function clearSelection() {
    deselectPin();
    closeBuildingCard();
    // The third thing the map can be pointing at. A tap on bare ground, a
    // reset, and both of the dropped pin's own buttons all come through here,
    // so none of them has to remember it separately.
    removeDroppedMarker();
  }

  /** The building under a click, or null. */
  function buildingAt(pointer) {
    if (!map.getLayer('campus-directory-hit')) return null;
    const [hit] = map.queryRenderedFeatures(pointer, { layers: ['campus-directory-hit'] });
    return hit?.properties ?? null;
  }

  /**
   * A building's traced outline, by the name on its card.
   *
   * Read from the loaded directory rather than from the rendered feature, and
   * the difference matters here: `queryRenderedFeatures` returns geometry
   * clipped to the tile it was drawn in, so a footprint straddling a tile seam
   * comes back cut — which is precisely the measurement this feeds. The source
   * data is whole.
   */
  function footprintOf(name) {
    if (!directory() || !name) return null;
    return directory().features.find((f) => f.properties?.name === name)?.geometry ?? null;
  }

  /**
   * A directory row by name, for a tap that landed on a NAME rather than on a
   * building.
   *
   * `buildingAt` asks what footprint is under the pointer, which is the right
   * question for a tap on a building and the wrong one for a tap on its label.
   * my campus's cartographer sets a `plate` where a name will not fit inside the shape
   * it belongs to — Portable Village's sits in the yard beside it, Environmental
   * Resources' out on the path — so the pixel under the word is frequently not
   * the building, and seven of the nine plates on this campus are directory rows
   * whose names tapped to nothing at all: a pin lifted, no card, no flyover.
   *
   * So the name is asked as well. It is a WEAKER question and is only ever the
   * fallback, because two things can be under one pointer and only one of them
   * can be the thing you touched. But a label carrying a building's exact name
   * is that building however far the word has drifted from it.
   */
  /**
   * Labels my campus's sheet spells differently from the directory's own row.
   *
   * Not a general fuzzy match, and deliberately not: "Science" and "Science
   * Success Center" are two buildings, and anything loose enough to join
   * "Health & Ed" to "Health Education Complex" is loose enough to join those.
   * Each entry is a decision about one name, made by reading both files.
   *
   * The sheet's own wording is kept on the map — it is what is printed on the
   * building and what somebody standing outside it will be looking for. This
   * only says which row it is.
   */
  const LABEL_ALIASES = new Map([
    ['Health & Ed (HeEd) 710-716', 'Health Education Complex'],
  ]);

  function directoryRow(name) {
    if (!directory() || !name) return null;
    const want = LABEL_ALIASES.get(name.trim()) ?? name;
    return directory().features.find((f) => f.properties?.name === want)?.properties ?? null;
  }

  function showBuildingCard(raw) {
    // Vector tiles hand nested properties back as JSON strings.
    const props = { ...raw };
    for (const key of ['contents', 'facilities', 'parts', 'entrance', 'anchor']) {
      if (typeof props[key] === 'string') {
        try { props[key] = JSON.parse(props[key]); } catch { delete props[key]; }
      }
    }

    // The helicopter shot, for the things that have something to fly around.
    // `poi` is derived here rather than stored, exactly as the card's own
    // subtitle derives it, so the disc on the map, the line under the name and
    // the decision to show an aerial view are all one classification and cannot
    // disagree.
    const flyover = googleKey && canFlyOver({ ...props, poi: poiFor(props.name) })
      ? (() => {
        // THE FOOTPRINT, not the properties, and this is what stops the
        // perimeter cutting through the building. A tapped feature arrives here
        // as properties alone — `buildingAt` returns `hit.properties` — so the
        // geometry has to be fetched back out of the source by name. Everything
        // that reaches this function is a directory row, by all three paths
        // into it, so the lookup finds one.
        const extent = footprintExtent(footprintOf(props.name));
        // The middle of the footprint if it is known, and only otherwise the
        // anchor. Both are points inside the building, but an anchor is the
        // point furthest INSIDE it rather than its middle, and centring a
        // square on one puts the far wall outside the square — see `footprintExtent`.
        const centre = extent?.centre ?? props.anchor ?? props.entrance;
        // Span, pitch and the coarse-tile limit all come from one call, so the
        // policy — how a place is worth framing — stays in one file.
        const frame = framing(props.area_m2, extent);
        return createFlyover({
          key: googleKey, centre, name: props.name, ...frame,
          // The ground the aerial view may draw, which is the same campus the
          // 2D map is fenced to. Passed rather than restated: this is the walk
          // network's own extent, and a flyover bounded by a second opinion
          // about where my campus is would disagree with the map beside it.
          bounds: CAMPUS_BOUNDS,
          // The ROOF, which is a different point from the one the camera aims
          // at: `centre` is the middle of the footprint, on the ground, and a
          // pin dropped on that goes through the building.
          roof: roofOf(props.name),
          // The building's own traced outline and the two planes it stands
          // between, for the cage. Google's tiles are one mesh with no building
          // in them to outline, so this is the only geometry that knows where
          // this building stops and the one touching it starts.
          footprint: footprintOf(props.name),
          mass: massOf(props.name),
          fps: showFps(),
        });
      })()
      : null;

    showPlaceCard(buildingCard(props, {
      media: flyover?.el,
      onStart: (coords, name) => {
        if (hasRoute()) resetMap();
        clearSelection();
        placeStart(coords, name);
        setStatus(`Start set at ${name}. Now pick a destination.`);
      },
      // Directions from a building's card is the same question the search box
      // and the category rows ask, so it goes through the same door — which is
      // where the GPS is asked. This used to carry its own copy of the logic,
      // and that copy only ever consulted the debug fixture: on a real phone
      // the one button this card exists for answered "now press and hold the
      // map to set a start point".
      onEnd: (coords, name) => { clearSelection(); setDestination(coords, name); },
      onClose: clearSelection,
    // `anchor` is the pole of inaccessibility — the point furthest INSIDE the
    // footprint, which is where the label is set — so it is a better middle
    // than the entrance node hanging off one edge. Same choice openBuilding
    // used to make on its own; it goes through here now.
    }), flyover, { at: props.anchor ?? props.entrance });
    highlightBuilding(props.officialName);
  }

  /**
   * What one directory row says under the name.
   *
   * In the order it is worth knowing. What is INSIDE a building is the thing
   * someone scanning a campus directory is actually after — nine destinations
   * in the Student Center is why you would open it — so that wins. Failing
   * that, the name my campus's own database uses, but only where it differs from the
   * one printed on the map, since "Gym · Gym" is a row that says one thing
   * twice. Failing both, the footprint, which every building has.
   */
  function buildingSub(props) {
    const inside = props.contents?.length ?? 0;
    if (inside) return `${inside} destination${inside === 1 ? '' : 's'} inside`;
    if (props.officialName && props.officialName !== props.name) return props.officialName;
    return `${Math.round(props.area_m2 * 10.7639).toLocaleString()} sq ft`;
  }

  /**
   * The directory, listed at the foot of the debug menu.
   *
   * Straight off src/directory.json, which is the same file the footprints on
   * the map are tapped through — so a row and the building it names hand the
   * SAME properties object to showBuildingCard, and the card cannot disagree
   * with itself depending on how it was opened. That is most of why this list
   * is worth keeping once it is out of the sidebar: a row that is missing, or
   * whose subtitle reads wrong, is directory.json saying so.
   *
   * Alphabetical. There is no better order available: distance would need a
   * start point that has not been set yet on the screen where this list is most
   * useful, and "importance" is a judgment this file has no column for.
   */
  function renderBuildings() {
    if (!directory()) return;
    const rows = directory().features
      .map((feature) => feature.properties)
      .filter((props) => props.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    buildingsCount.textContent = `${rows.length} on campus`;
    buildingsList.replaceChildren(...rows.map((props) => {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'g-row';

      // One glyph, coloured by what the building IS — the same hue
      // map-images.js paints its POI marker on the map, so the row and the disc
      // over the footprint are visibly the same answer. poiFor returns null for
      // the sheet's "Closed" areas, which never reach a directory row, but the
      // fallback keeps a missing classification a grey disc rather than a throw.
      const disc = document.createElement('span');
      disc.className = 'g-row-disc';
      disc.dataset.icon = 'building';
      const hue = pinColour(poiFor(props.name) ?? 'campus');
      disc.style.color = hue;
      disc.style.background = `color-mix(in srgb, ${hue} 18%, transparent)`;
      row.append(disc);

      const text = document.createElement('span');
      text.className = 'g-row-text';
      const name = document.createElement('span');
      name.className = 'g-row-name';
      name.textContent = props.name;
      const sub = document.createElement('span');
      sub.className = 'g-row-sub';
      sub.textContent = buildingSub(props);
      text.append(name, sub);
      row.append(text);

      row.addEventListener('click', () => openBuilding(props));
      li.append(row);
      return li;
    }));
    paintIcons(buildingsList);
  }

  /**
   * Open a building from the list rather than from the map.
   *
   * The card is the same one a tap on the footprint opens, and the camera is
   * the same camera: showBuildingCard reveals what it is about, whether that
   * turned out to be off screen entirely (which is the list's case) or behind
   * the sheet (which is the tap's).
   *
   * This used to fly here itself, reading the padding immediately after the
   * card went up — half a frame before the sheet had decided how tall it was
   * going to be. See viewPadding.
   */
  function openBuilding(props) {
    clearSelection();
    showBuildingCard(props);
  }
  return {
    showPlace: showPlaceCard,
    directoryRow,
    footprintOf,
    buildingSub,
    closePlace: closePlaceCard,
    closeBuilding: closeBuildingCard,
    showBuilding: showBuildingCard,
    renderBuildings,
    openBuilding,
    clearSelection,
    buildingAt,
    afterExit,
  };
}
