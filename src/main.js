import mapboxgl from 'mapbox-gl';
// Imported rather than linked from the CDN so the stylesheet can never drift
// out of step with the library version resolved in package.json.
import 'mapbox-gl/dist/mapbox-gl.css';
// Small enough to bundle, and it must be present on the very first frame: the
// mask exists to hide Mapbox's data, so fetching it would show a flash of the
// thing it is there to remove.
import campusBoundary from './campus-boundary.json';
import { point, featureCollection } from '@turf/helpers';
import { nearestPoint } from '@turf/nearest-point';
import { distance } from '@turf/distance';
import { FEET_PER_KM } from './maneuvers.js';
import { routeSummary } from './directions.js';
import {
  routePin, liftedOffset, ROUTE_PIN_W, pinInk,
} from './map-images.js';
import { pinCard } from './building-popup.js';
import { createThemeControl, preferredTheme, applyThemeAttribute } from './theme.js';
import { createBasemapToggle, preferredBasemap } from './basemap.js';
import { createProviderToggle, preferredProvider } from './provider.js';
import { createSkinControl, preferredSkin, applySkinAttribute } from './skin.js';
import { paintIcons } from './g-icons.js';
import {
} from './building-kinds.js';
import {
  withPoiIcons, withParkingMarks, withAmenityNames, 
} from './poi.js';
import { ringOf, centreOf, trimToCampus } from './campus-clip.js';
import { createGeolocation } from './geolocation.js';
import { createDebugMenu } from './debug.js';
import { createLitPalette } from './lit-palette.js';
import { createLightingControl } from './lighting.js';
import { FONTS, SATELLITE, styleKey } from './palette.js';

import { tokenRefusal, showSetupProblem } from './setup-problem.js';
import { CAMPUS_BOUNDS, ROUTABLE_BOUNDS } from './campus-bounds.js';
import { createRoute } from './route-state.js';
import { createNavigation, SIM_TICK_MS } from './navigation.js';
import { createLongPress } from './long-press.js';
import { FIT_MARGIN, paddingAround } from './viewport.js';
import { createStatusLine } from './status-line.js';
import { createApi } from './api.js';
import { createChoreography } from './pin-choreography.js';
import { createPinState, POI_LABEL_LAYERS } from './pin-state.js';
import { createBuildingsLighting, BUILDING_EMISSIVE } from './buildings-lighting.js';
import { createCampusSheet, CLOSED_TEXT } from './campus-sheet.js';
import { createMarkerLayers } from './marker-layers.js';
import { createLabelLayers, NOTHING_SELECTED } from './label-layers.js';
import { createRouteLayers } from './route-layers.js';
import { createCamera } from './camera.js';
import { createCards } from './cards.js';
import { createGround } from './ground.js';
import { createLegend } from './legend.js';
import { createEndpoints, GOOGLE_RED } from './endpoints.js';
import { createSearchBox } from './search-box.js';
import { createLocate } from './locate.js';
import { createShell } from './shell.js';
import { createDebugFlags } from './debug-apply.js';
import { createPanels } from './panels.js';
import { spin } from './spinner.js';
import {
} from './search-rank.js';

import {
} from './highlight.js';

// The chrome's button glyphs are named in the markup and drawn here, before
// anything else runs, so no button ever paints as an empty box.
paintIcons();

const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
// Optional. Absent, the provider toggle still renders but says so when pressed
// rather than silently doing nothing — see addGoogleGround.
const googleKey = import.meta.env.VITE_GOOGLE_MAPS_KEY;





const CAMPUS_RING = ringOf(campusBoundary);

// Where the debug menu's virtual GPS fix stands. The centroid of that ring, so
// it moves with the boundary rather than being a pair of numbers that quietly
// stops meaning "the middle of the campus" the next time the ring is redrawn.
const CAMPUS_CENTRE = centreOf(CAMPUS_RING);

const setupProblem = tokenRefusal(accessToken);
if (setupProblem) {
  // On the screen, not in the console. See src/setup-problem.js — this is the
  // one failure with no degraded mode to fall back to, so the sentence has to
  // go where the map would have been.
  console.warn(`[beavermaps] ${setupProblem}`);
  showSetupProblem(setupProblem);
} else {
  startApp();
}

/**
 * The whole app.
 *
 * A NAMED FUNCTION rather than the `else` branch it used to be. The body below
 * is seven thousand lines, and until this line it was an anonymous block
 * belonging to a token check — so the file's top-level shape was one `if`, and
 * every profiler stack, every error and every `this is inside what?` question
 * about any of it answered "(anonymous)". A name costs nothing and is the first
 * step of getting this file down to a size somebody can hold in their head.
 *
 * Hoisted, which is why it can be called above where it is declared.
 */
function startApp() {
  mapboxgl.accessToken = accessToken;

  // Set the attribute before the map exists so the first paint is never the
  // wrong theme, and so the basemap starts on the matching style.
  let currentTheme = preferredTheme();
  applyThemeAttribute(currentTheme);
  // Same reasoning one line up, and it matters more here: the skin decides the
  // corner radius, the typeface and whether a card is opaque, so publishing it
  // late would open the app in one design language and switch to the other.
  let currentSkin = preferredSkin();
  applySkinAttribute(currentSkin);
  let currentBasemap = preferredBasemap();
  let currentProvider = preferredProvider();
  let appliedStyleKey = styleKey(currentProvider, currentBasemap, currentTheme, currentSkin);

  /** The label face for the look currently on screen. See FONTS. */
  const mapFont = () => FONTS[currentSkin] ?? FONTS.classic;

  // The palette moved to the time of day, and the timer that keeps it there:
  // src/lit-palette.js. Built here, above the map constructor, because
  // `litPalette` is what hands that constructor its style.
  const sky = createLitPalette({
    centre: CAMPUS_CENTRE,
    provider: () => currentProvider,
    basemap: () => currentBasemap,
    theme: () => currentTheme,
    skin: () => currentSkin,
    bench: () => lightingBench,
    relight: () => applyLighting(),
  });
  const litPalette = () => sky.litPalette();
  const clockPreset = () => sky.clockPreset();
  const watchDaylight = () => sky.watch();

  let lightingBench = null;

  const map = new mapboxgl.Map({
    container: 'map',
    // Not Mapbox's default "i", which is added here rather than by addControl
    // and so cannot be reconfigured afterwards. See the AttributionControl added
    // below for what replaces it and why there still has to be one.
    attributionControl: false,
    style: litPalette().style,
    // Fitting the network's own bounds rather than a fixed centre/zoom means the
    // campus fills the frame on a phone and a desktop alike.
    bounds: CAMPUS_BOUNDS,
    fitBoundsOptions: { padding: FIT_MARGIN },
    // The largest single thing this app holds in memory, and it was unbounded.
    //
    // Mapbox sizes its default cache as (ceil(w/tile)+1) * (ceil(h/tile)+1) * 5
    // — five screenfuls. On a 1512x893 window against Google's 256-unit raster
    // that is 175 tiles, and under the Google provider each one arrives as a
    // 512px image, which is a megabyte of decoded pixels. A hundred and seventy
    // megabytes of basemap, to look at one college.
    //
    // 60 is a bit under two screenfuls: the visible set here is about 35 tiles,
    // so the whole current view plus headroom stays resident and only a change
    // of zoom level evicts anything.
    //
    // THE TRADE IS REAL AND IS NOT FREE. Google's 2D tiles bill per tile
    // request — see the note on `scale` in src/google-tiles.js — so a smaller
    // cache is more requests. It is a good trade *here* specifically because
    // the camera cannot leave ROUTABLE_BOUNDS: there is no long pan across a
    // city to refetch, only one campus at two or three zooms. Raise this first
    // if the tile bill ever looks wrong.
    maxTileCacheSize: 60,
    // The fence that sentence depends on. See ROUTABLE_BOUNDS.
    maxBounds: ROUTABLE_BOUNDS,
  });

  // Dev-only handle, stripped from the production bundle by the constant fold.
  // Label placement is decided by Mapbox's collision solver and cannot be
  // reasoned about from the source — "how many building names actually survive
  // at the default view" is only answerable by asking the running map.
  if (import.meta.env.DEV) window.__map = map;

  // The path network now arrives from the server rather than the bundle, so
  // these start empty.
  let customNetwork = null;
  let networkPoints = null;
  let campusBuildings = null;
  // Ground cover, amenity symbols and the destination directory, all traced out
  // of my campus's own basemap. Every one is decoration: the map works without them.
  let campusBasemap = null;
  let campusAmenities = null;
  let campusPlaces = null;
  let campusLabels = null;
  let campusDirectory = null;

  // The walk that is currently on the screen, and the turn-by-turn that
  // reads it. Ten `let`s used to stand here describing one walk between
  // them; see src/route-state.js and src/navigation.js for why that was a
  // set pretending to be a scope.
  //
  // `nav` is null until the banner's elements have been looked up, which is
  // why nothing reads it directly — `navigating()` is the question every
  // other part of this file actually has, and it answers false before the
  // object exists, which is the truth.
  const route = createRoute();
  let nav = null;
  const navigating = () => nav?.isActive() === true;
  // The lighting bench, and whether anybody is standing at it. Both are read by
  // applyLighting and nothing else: `debugOpen` is the gate that keeps a bench
  // setting from following somebody out of the back room, and `benchLights` is
  // Standard's own light array, captured on every style load so the override
  // has something to be put back to. See src/lighting.js.
  let debugOpen = false;
  /** Whether a flyover draws its own frame-rate readout. Debug menu only. */
  let showFps = false;
  let benchLights = null;
  // Whether there is a style under us to configure at all.
  //
  // NOT `map.isStyleLoaded()`, which is the obvious guard and the wrong one:
  // inside the `style.load` handler it is still FALSE — it reports every source
  // and sprite settled, which happens later — so guarding on it meant the bench
  // was quietly dropped on every style swap and only came back when something
  // else happened to touch it. Measured, after the first version of this shipped
  // a satellite round-trip that lost the whole bench.
  //
  // This says the narrower thing the builders actually need: a style exists and
  // its layers are ours to write to.
  let styleBuilt = false;

  // GUI Elements
  // Three refs for one line of text: the paragraph carries the error class, the
  // span inside it carries the words, and the span beside that holds the
  // spinner. See setStatus and setBusy.
  const instructionText = document.getElementById('instruction-text');
  const instructionMessage = document.getElementById('instruction-message');
  const instructionBusy = document.getElementById('instruction-busy');
  const startCoordText = document.getElementById('start-coord');
  const endCoordText = document.getElementById('end-coord');
  const routeTimeText = document.getElementById('route-time');
  const routeDetailText = document.getElementById('route-detail');
  const clearBtn = document.getElementById('clear-btn');
  const startNavBtn = document.getElementById('start-nav-btn');
  const simulateBtn = document.getElementById('simulate-btn');
  const sidePanel = document.getElementById('side-panel');
  // Up here with the panel rather than down with the rest of the chrome,
  // because campusPadding measures all four and campusPadding runs before those
  // blocks are reached — see the fitBounds a few lines below. A `const` read
  // before its declaration is a TDZ throw, not an undefined.
  const legendPanel = document.getElementById('legend-panel');
  const placePanel = document.getElementById('place-panel');
  const categoryPanel = document.getElementById('category-panel');
  // Not one of those three any more — the directory lives in the debug card and
  // is not measured. Kept here with them because it is still a panel handle and
  // there is no better block for it to be in.
  const buildingsPanel = document.getElementById('buildings-panel');
  const buildingsList = document.getElementById('buildings-list');
  const buildingsCount = document.getElementById('buildings-count');
  // Same reason, one step further out: setStatus opens the route panel to say
  // anything that has gone wrong, and setStatus is reachable from the Google
  // basemap's failure path — which can resolve before the chrome block below is
  // ever reached.
  const directionsBtn = document.getElementById('directions-btn');

  // Below this width the left column becomes a bottom sheet and the legend
  // becomes one too. Must match the media query in src/input.css.
  const phone = window.matchMedia('(max-width: 640px)');
  // ...and where the legend holds the right edge it is furniture, where it is a
  // sheet over the map it is not, so on a phone it stays closed. Set here and
  // not with the rest of the chrome because campusPadding measures this panel
  // and the first fitBounds is a few lines below — opening it afterwards would
  // frame the campus around a card that is not there. The button that closes it
  // again is told about this where it is declared.
  //
  // OPENING, not closing, and the direction is the whole point. This read
  // `if (phone.matches) legendPanel.classList.add('hidden')` — the panel was
  // open in the markup and a phone shut it here, which is a line that cannot
  // run until the bundle has parsed. Everything before that moment painted an
  // empty Legend panel across the bottom sheet. The markup carries `hidden` now
  // and a desktop is what asks for it back.
  if (!phone.matches) legendPanel.classList.remove('hidden');
  const navBanner = document.getElementById('nav-banner');
  const navFooter = document.getElementById('nav-footer');
  const navStack = document.getElementById('nav-stack');

  /**
   * Reserve the canvas the open cards are standing on. See viewport.js for
   * what each rectangle costs and why a phone-width card costs height.
   */
  function campusPadding() {
    // buildingsPanel is not in this list and must not be: it is a section of
    // the debug card now, and the debug card is a thing you open, read and
    // close rather than a panel the map is framed around.
    const open = [placePanel, categoryPanel, sidePanel, legendPanel]
      .filter((card) => !card.classList.contains('hidden'))
      .map((card) => card.getBoundingClientRect());
    return paddingAround({ canvas: map.getCanvas().getBoundingClientRect(), boxes: open });
  }

  // The constructor framed the campus before these element refs existed, so it
  // could only use an even margin. Re-frame now that the panel can be measured;
  // instantly, since no tiles have been drawn yet.
  map.fitBounds(CAMPUS_BOUNDS, { padding: campusPadding(), duration: 0 });
  const signTemplate = document.getElementById('nav-sign-template');
  const navRemaining = document.getElementById('nav-remaining');
  const navEta = document.getElementById('nav-eta');
  const themeModes = document.getElementById('theme-modes');
  const basemapToggle = document.getElementById('basemap-toggle');
  const basemapIcon = document.getElementById('basemap-toggle-icon');
  const basemapLabel = document.getElementById('basemap-toggle-label');
  const providerToggle = document.getElementById('provider-toggle');
  const providerIcon = document.getElementById('provider-toggle-icon');
  const providerLabel = document.getElementById('provider-toggle-label');
  const skinToggle = document.getElementById('skin-toggle');
  const skinIcon = document.getElementById('skin-toggle-icon');
  const skinLabel = document.getElementById('skin-toggle-label');

  // The debug menu's copies of those same three controls. Registered as second
  // surfaces below rather than wired to anything of their own — see src/debug.js
  // for why that distinction is the point of the panel.
  const debugPanel = document.getElementById('debug-panel');
  const debugBasemap = document.getElementById('debug-basemap');
  const debugProvider = document.getElementById('debug-provider');
  const debugSkin = document.getElementById('debug-skin');

  /**
   * Whether the app is offering to route you anywhere.
   *
   * True in the app as shipped, and false only while the debug menu is up with
   * its switch off. Read by the three places that would otherwise put a start
   * or a destination on the map; the markup those offers live in is hidden by
   * the stylesheet at the same time — see body.no-routing in src/input.css.
   */
  let routingEnabled = true;

  // Real GPS until the debug menu says otherwise. Built here rather than inside
  // map.on('load') because the fixture can be switched on before the map has
  // finished loading — a reload with the flag already set does exactly that —
  // and this object is what carries the answer across.
  const geolocation = createGeolocation();
  let geolocateControl = null;

  // Everything the walk needs, handed over explicitly.
  //
  // The three callbacks are named for what navigation WANTS rather than for the
  // function that happens to satisfy it. `restCamera` is "put the camera back",
  // which today is a fitBounds over the campus; `releaseCameraLock` is "stop
  // following the locate control", which is a trigger() on a control this
  // module has never heard of. Naming them that way is what keeps navigation
  // from knowing about CAMPUS_BOUNDS, the padding rules or the geolocate
  // control — and what lets a test hand it three spies instead of a map.
  nav = createNavigation({
    map,
    route,
    geolocation,
    dom: {
      sidePanel,
      banner: navBanner,
      footer: navFooter,
      stack: navStack,
      signTemplate,
      remaining: navRemaining,
      eta: navEta,
    },
    // Wrapped, not passed: both are `const` arrows declared below this call.
    buildings: { add: () => addBuildingsLayer(), remove: () => removeBuildingsLayer() },
    onStart: () => { clearLegendHighlight(); deselectPin(); },
    restCamera: () => map.fitBounds(CAMPUS_BOUNDS, {
      padding: campusPadding(), pitch: 0, bearing: 0, duration: 800,
    }),
    releaseCameraLock: () => { if (locate.isLocating()) geolocateControl?.trigger(); },
    makeUserDot: () => {
      const dot = document.createElement('div');
      dot.className = 'user-dot';
      return new mapboxgl.Marker({ element: dot });
    },
  });

  /**
   * Write the three numbers, or clear them back to the panel's resting head.
   *
   * `null` is a real argument rather than an absence — it is what the panel says
   * when it has no route, and "0 ft / arriving now" is a worse answer to that
   * than a heading. All three values come from one call so they cannot end up
   * describing different routes; see src/directions.js.
   */
  function setRouteSummary(feet) {
    if (feet === null) {
      routeTimeText.textContent = 'Directions';
      routeDetailText.textContent = '';
      routeDetailText.classList.add('hidden');
      return;
    }
    const { time, arrival, distance: far } = routeSummary(feet);
    routeTimeText.textContent = time;
    routeDetailText.textContent = `${arrival} · ${far}`;
    routeDetailText.classList.remove('hidden');
  }

  function setNavButtonsEnabled(enabled) {
    startNavBtn.disabled = !enabled;
    simulateBtn.disabled = !enabled;
  }

  /**
   * Routing is a network call now, so "server is down" is a state the UI has to
   * show plainly — otherwise it looks like the buttons are simply broken.
   */
  // The strip the app speaks in, and the spinner beside it. Which sentence
  // outranks which is src/status-line.js; this is only where its three
  /**
   * Show or hide the top bar, moving the search field between the two homes.
   *
   * MOVED, not duplicated. There is one field, one set of handlers, one index
   * and one results list behind it; a second copy in the header would be a
   * second thing to keep in step with the first and it would drift the first
   * time either was touched. `append` and `prepend` move a node that is already
   * in the document, so this is a relocation rather than a rebuild — the value
   * being typed, the open suggestion list and the focus all survive it.
   *
   * The map is told afterwards. Its canvas is sized to a container that just
   * changed height, and Mapbox does not notice on its own.
   */
  const navbarEl = document.getElementById('navbar');
  const navbarSlot = document.getElementById('navbar-search');
  const navbarLegend = document.getElementById('navbar-legend');
  const searchHome = document.querySelector('.g-search');
  const topLeft = document.getElementById('top-left');
  let navbarShown = false;

  // The strip the app speaks in, and the spinner beside it. Which sentence
  // outranks which is src/status-line.js; this is only where its three
  // elements are.
  const status = createStatusLine({
    text: instructionText,
    message: instructionMessage,
    busy: instructionBusy,
    onError: () => showRoutePanel(),
    spinner: spin,
  });
  const setStatus = (sentence, isError = false) => status.set(sentence, isError);
  const setProgress = (sentence) => status.progress(sentence);
  const setIdleStatus = () => status.rest();
  const setBusy = (on) => status.setBusy(on);

  function showNavbar(on) {
    if (on === navbarShown) return;
    navbarShown = on;
    navbarEl.hidden = !on;
    document.body.classList.toggle('has-navbar', on);
    if (on) navbarSlot.append(searchHome);
    else topLeft.prepend(searchHome);
    // The column reserves room for itself against the camera, and the bar has
    // just changed how much room there is. Same call every panel toggle makes.
    map.resize();
    map.easeTo({ padding: campusPadding(), duration: 300 });
  }

  navbarLegend.addEventListener('click', () => {
    // The same handler the layers menu's row uses, so there is one piece of
    // state and three surfaces reading it rather than three opinions.
    onLegendPressed();
    navbarLegend.setAttribute('aria-expanded',
      String(!legendPanel.classList.contains('hidden')));
  });

  clearBtn.addEventListener('click', () => resetMap());
  // Clears AND closes, which is what makes it a replacement for Clear rather
  // than a second way to do what the directions button already does. A panel
  // that hid itself and left the ribbon lying across the campus would be the
  // half of Clear nobody was asking for.
  document.getElementById('route-close').addEventListener('click', () => {
    resetMap();
    toggleRoutePanel(false);
  });
  startNavBtn.addEventListener('click', () => nav.start());
  simulateBtn.addEventListener('click', () => nav.start({ simulate: true }));

  // The four questions this app asks its own server, and what each non-200
  // means. See src/api.js.
  const api = createApi();
  const fetchNetwork = () => api.network();
  const fetchVertices = () => api.vertices();
  const fetchOverlay = (name) => api.overlay(name);

  // -------------------------------------------------------------------------
  // 3D buildings, and what lights them
  //
  // src/buildings-lighting.js. The bench that questions all of it stays here,
  // because it belongs to the debug menu.
  // -------------------------------------------------------------------------

  const buildings = createBuildingsLighting({
    map,
    centre: CAMPUS_CENTRE,
    litPalette,
    navigating,
    clockPreset,
    theme: () => currentTheme,
    footprints: () => campusBuildings,
    isStyleBuilt: () => styleBuilt,
    bench: () => (debugOpen ? lightingBench : null),
    standardLights: () => benchLights,
    setConfig: (key, value) => setConfig(key, value),
    paintLamps: () => paintLamps(),
    repaintCampus: () => syncBasemapStyle(),
  });
  const addBuildingsLayer = () => buildings.add();
  const removeBuildingsLayer = () => buildings.remove();
  const applyLighting = () => buildings.applyLighting();

  // The printed campus sheet, drawn element for element: src/campus-sheet.js.
  const sheetLayers = createCampusSheet({
    map,
    litPalette,
    sheet: () => campusBasemap,
    belowNetwork: () => belowNetwork(),
    belowRoute: () => belowRoute(),
  });
  const addBasemapLayers = () => sheetLayers.add();
  const addClosedLayers = () => sheetLayers.addClosed();

  // -------------------------------------------------------------------------
  // Legend highlight
  //
  // The shapes one legend row is asking about: an outline over every building
  // and car park that holds the thing, and a ring on each one that stands in
  // the open. src/highlight.js does the join; this draws the answer.
  // The pins, the lamps and the category answer: src/marker-layers.js.
  const markers = createMarkerLayers({
    map,
    litPalette,
    mapFont: () => mapFont(),
    theme: () => currentTheme,
    basemap: () => currentBasemap,
    amenities: () => campusAmenities,
    bench: () => lightingBench,
    clockPreset,
    shownCategory: () => shownCategory(),
    shownHits: () => shownHits(),
    amenityFilter: () => pins.amenityFilter(),
    hiddenPin: (layer) => pins.hiddenPin(layer),
    paintLabels: () => pins.paintLabels(),
  });
  const inkFor = (property) => markers.inkFor(property);
  const addAmenityLayer = () => markers.addAmenity();
  const addLampLayers = () => markers.addLamps();
  const paintLamps = () => markers.paintLamps();
  const addCategoryLayer = () => markers.addCategory();
  const paintCategory = () => markers.paintCategory();

  // -------------------------------------------------------------------------
  // Categories
  //
  // Google's chip strip filters the map to one kind of place and lists what it
  // found. Ours does the same over my campus's printed legend — see src/categories.js
  // for why those are the categories and not Restaurants/Hotels/Museums.
  //
  // The strip itself is gone: pressing a category is a legend row now, over on
  // the right, and everything below is what that press *does*. See renderLegend
  // for why the two lists became one.
  //
  // Two data sources, because the legend's symbols and my campus's directory are
  // separate files — a `kinds` category reads amenities.json and a `match` one
  // reads places.json — but one mechanism on the map: selecting anything hides
  // the ambient pictogram layer and draws the category's own pins. See
  // paintCategory for why filtering the existing layer was not enough.
  // -------------------------------------------------------------------------
  // Clearing the map for an answer
  //
  // Pressing a chip is a question, and the map answers it by emptying itself
  // first. The whole sequence is src/pin-choreography.js, including the reason
  // the two halves are animated by different means.
  // -------------------------------------------------------------------------

  const choreo = createChoreography({
    map,
    /** Every layer that draws a pin, which is what a chip press has to clear. */
    pinLayers: () => ['campus-amenities', ...POI_LABEL_LAYERS]
      .filter((layer) => map.getLayer(layer)),
    paintCategory: () => paintCategory(),
    paintPinHover: (layer) => paintPinHover(layer),
  });
  const prefersStill = () => choreo.prefersStill();

  // -------------------------------------------------------------------------
  // Selecting and hovering a pin
  //
  // Which pin is up, which is under the pointer, and what each layer may
  // therefore draw: src/pin-state.js. What a lift MEANS is here, because a
  // building gets a building card and a defibrillator gets two lines.
  // -------------------------------------------------------------------------

  const pins = createPinState({
    map,
    Marker: mapboxgl.Marker,
    litPalette,
    inkFor,
    // Wrapped rather than passed: `labelPaint` is a `const` arrow declared
    // several hundred lines below this call, so handing over the binding itself
    // reads it before it exists. eslint's no-use-before-define caught it.
    labelPaint: (kind, colors) => labelPaint(kind, colors),
    shownCategory: () => shownCategory(),
    paintCategory: () => paintCategory(),
    isArriving: () => choreo.isArriving(),
    prefersStill,
    closedText: CLOSED_TEXT,
    markerInk: (kind) => (currentBasemap === 'satellite'
      ? SATELLITE.label : pinInk(kind, currentTheme)),
    onDeselect: () => closeBuildingCard(),
    onLift: (hit) => showPlaceCard(pinCard(hit, {
      onStart: (coords, name) => { clearSelection(); placeStart(coords, name); },
      onEnd: (coords, name) => { clearSelection(); setDestination(coords, name); },
      onClose: clearSelection,
    // The pin, kept in view. A tap in the bottom third of a phone screen is
    // the case: the card opens as a sheet reaching half the viewport and
    // settles over the thing that was tapped.
    }), null, { at: hit.coords }),
  });

  const pinAt = (pointer) => pins.pinAt(pointer);
  const paintPinHover = (layer) => pins.paintPinHover(layer);
  const hoverPin = (next) => pins.hoverPin(next);
  const selectPin = (hit, options) => pins.selectPin(hit, options);
  const deselectPin = () => pins.deselectPin();

  // Where the camera goes and what it is allowed to cover: src/camera.js.
  const camera = createCamera({
    map,
    LngLatBounds: mapboxgl.LngLatBounds,
    campusPadding: () => campusPadding(),
    sheetTop: () => sheet.top,
    navigating,
    isPhone: () => phone.matches,
    categoryHits: () => legend.hits(),
    // No pins does not mean nothing to show: a category whose source file
    // failed to load still outlines its buildings, and the two halves
    // degrade separately.
    categoryExtent: () => legend.extent(),
  });
  const revealPoint = (coords, options) => camera.reveal(coords, options);


  // The printed names, the directory hit-layer and the closed block's word:
  // src/label-layers.js.
  const labels = createLabelLayers({
    map,
    litPalette,
    mapFont: () => mapFont(),
    skin: () => currentSkin,
    printed: () => campusLabels,
    directory: () => campusDirectory,
    sheet: () => campusBasemap,
    pinRing: () => markers.pinRing(),
    labelFilter: (kind) => pins.labelFilter(kind),
    inkFor: (property) => markers.inkFor(property),
    theme: () => currentTheme,
  });
  const addDirectoryLayers = () => labels.addDirectory();
  const addLabelLayers = () => labels.addPrinted();
  const labelPaint = (kind, colors) => labels.labelPaint(kind, colors);

  function highlightBuilding(officialName) {
    // The name used to be kept in a `selectedBuilding` variable alongside a
    // second one holding the open card, back when the card was a Mapbox popup
    // that had to be kept and removed. The card is the contents of #place-panel
    // now, so the panel's own hidden state is the whole of it — and the name
    // was written here and read nowhere, which is what a linter is for.
    const filter = officialName ? ['==', ['get', 'officialName'], officialName] : NOTHING_SELECTED;
    for (const id of ['campus-directory-fill', 'campus-directory-line']) {
      if (map.getLayer(id)) map.setFilter(id, filter);
    }
  }

  /**
   * The aerial view currently on screen, if there is one.
   *
   * Exactly one can exist, and it is held here rather than inside the card
   * because the flyover borrows a single shared canvas — see the note at the
   * top of src/flyover-view.js. A card is replaced by the next card without
   * anything being told, so releasing that canvas has to hang off the panel
   * rather than off the card that is going away.
   */
  let activeFlyover = null;

  /**
   * Put a card in the left column, or take whatever is there away.
   *
   * One panel for both kinds — a building's card and a pin's — because from the
   * map they are one gesture: you tapped a thing, and this is the thing. The
   * two used to be separate Mapbox popups anchored to what they described,
   * which is why opening the LRC covered the campus with a list of what is
   * inside the LRC. The tie to the marker survives without the anchor: the pin
   * itself is lifted and stays lifted for as long as this is up.
   *
   * @param {HTMLElement} card
   * @param {object} [flyover] the `{ el, destroy }` this card's media came from
   */
  // The sheet, the stack it lives in, and the two observers that keep the
  // layout honest on a phone: src/shell.js.
  const shell = createShell({
    map,
    panels: { placePanel, categoryPanel, sidePanel, legendPanel },
    isPhone: () => phone.matches,
    onSettle: () => revealPoint(camera.focus()),
    dismiss: {
      place: () => closePlaceCard(),
      category: () => clearResults(),
      route: () => toggleRoutePanel(false),
      legend: () => toggleLegendPanel(false),
    },
  });
  const sheet = shell.sheet;
  const refitSheet = () => shell.refit();

  window.addEventListener('resize', refitSheet);
  shell.viewport?.addEventListener('resize', refitSheet);

  // The panel, and everything that goes in it: src/cards.js.
  const cards = createCards({
    map,
    placePanel,
    buildingsList,
    buildingsCount,
    camera,
    directory: () => campusDirectory,
    highlightBuilding: (name) => highlightBuilding(name),
    campusPadding: () => campusPadding(),
    googleKey,
    hasRoute: () => endpoints.hasRoute(),
    resetMap: () => resetMap(),
    setStatus: (sentence) => setStatus(sentence),
    deselectPin: () => pins.deselectPin(),
    removeDroppedMarker: () => { droppedMarker?.remove(); droppedMarker = null; },
    placeStart: (coords, name) => placeStart(coords, name),
    setDestination: (coords, name) => setDestination(coords, name),
    showFps: () => showFps,
    setFlyover: (view) => { activeFlyover = view; },
    activeFlyover: () => activeFlyover,
  });
  const showPlaceCard = (card, flyover, options) => cards.showPlace(card, flyover, options);
  const closePlaceCard = () => cards.closePlace();
  const closeBuildingCard = () => cards.closeBuilding();
  const showBuildingCard = (raw) => cards.showBuilding(raw);
  const renderBuildings = () => cards.renderBuildings();
  const afterExit = (el, empty) => cards.afterExit(el, empty);
  const clearSelection = () => cards.clearSelection();
  const buildingAt = (pointer) => cards.buildingAt(pointer);
  const directoryRow = (name) => cards.directoryRow(name);
  const buildingSub = (props) => cards.buildingSub(props);

  // ---------------------------------------------------------------------------
  // Map layers
  //
  // map.setStyle() discards every custom source and layer, so this has to be
  // idempotent and has to restore the current data — it runs on every theme
  // switch, not just at startup.
  // The ribbon, the network linework, the campus mask and the three little
  // helpers that decide what goes under what: src/route-layers.js.
  const routeLayers = createRouteLayers({
    map,
    litPalette,
    provider: () => currentProvider,
    boundary: campusBoundary,
    network: () => customNetwork,
    route,
    from: () => endpoints.start()?.geometry.coordinates,
    to: () => endpoints.end()?.geometry.coordinates,
  });
  const paintLegs = () => routeLayers.paintLegs();
  const addCampusMask = () => routeLayers.addMask();
  const setConfig = (key, value) => routeLayers.setConfig(key, value);
  const belowNetwork = () => routeLayers.belowNetwork();
  const belowRoute = () => routeLayers.belowRoute();

  function addNetworkLayers() {
    const colors = litPalette();

    // Mapbox Standard exposes configuration instead of addressable layers, and
    // this is where light and dark actually happen now.
    //
    // `basemapConfig` recolours Mapbox's own land, water, greenspace, roads and
    // labels to the same Google palette the campus uses, so the mask edge stops
    // being a seam between two maps. Only Standard carries these keys —
    // standard-satellite has a different schema and no basemapConfig, so it
    // falls through with nothing set.
    //
    // Each key is set individually rather than in one try: an unknown property
    // throws, and one Mapbox rename should cost that colour, not every colour
    // after it in the object.
    for (const [key, value] of Object.entries(colors.basemapConfig ?? {})) {
      setConfig(key, value);
    }

    // The same rule Google's session applies, on the provider that can express
    // it in one property: nobody else's business on a campus map. Mapbox names
    // the neighbours too — the mortgage broker, the dog trainer, the Islamic
    // centre — and on a map that is otherwise entirely my campus's they read as part
    // of it. Place names stay: a neighbourhood is context, an establishment is
    // an advertisement.
    setConfig('showPointOfInterestLabels', false);

    addCampusMask();
    addBasemapLayers();
    // Above the sheet it annotates, below the network added further down.
    addHighlightLayers();

    routeLayers.addNetworkAndRoute();

    // After the route layers rather than after the sheet it belongs to, and
    // only because of where its OUTLINE goes: belowRoute has to have a route
    // layer to name, and none of them exist until a few lines above this. The
    // wash still lands with the ground — the two halves carry their own
    // anchors, so building them late costs nothing.
    addClosedLayers();

    // Last, so the symbols and labels sit above the route rather than under it.
    addDirectoryLayers();
    addLampLayers();
    addAmenityLayer();
    addCategoryLayer();
    addLabelLayers();

    if (navigating()) addBuildingsLayer();

    // LAST, and it has to be. `lightPreset` used to be set at the top of this
    // function beside the other config keys, and moving it in here gave one
    // function ownership of the property — but applyLighting can also stand the
    // extrusions up, and addBuildingsLayer inserts below `route-casing`, which
    // does not exist until addNetworkLayers has finished building. Called any
    // earlier, a bench with the buildings switched on throws mid-rebuild and
    // takes the campus mask and the labels down with it, on every style load.
    applyLighting();
  }

  // -------------------------------------------------------------------------

  // Assigned once the DOM refs are in hand; the ground's failure path has to be
  // able to put this button back.
  let providerControl = null;

  // The two ends of a walk, and every way either of them can be chosen:
  // src/endpoints.js.
  /**
   * The pin a press-and-hold puts down, while its card is open.
   *
   * Held separately from the two route markers because it is not one of them
   * yet: it is a place you pointed at, and it becomes a start or a destination
   * only when a button on its card says so. At that moment it is removed and
   * the route marker takes its position, so the two never stand on the same
   * spot.
   */
  let droppedMarker = null;

  const endpoints = createEndpoints({
    map,
    route,
    nav: { end: () => nav?.end() },
    camera,
    api,
    geolocateControl: () => geolocateControl,
    networkPoints: () => networkPoints,
    routingEnabled: () => routingEnabled,
    status: { setStatus, setBusy, setRouteSummary, setNavButtonsEnabled, setIdleStatus },
    panel: { show: () => showRoutePanel(), padding: () => campusPadding() },
    ui: { startCoordText, endCoordText },
    paintLegs: () => paintLegs(),
    clearSelection: () => clearSelection(),
    clearSearchField: () => {
      // Leaving a destination showing next to "Not set" is the kind of stale
      // text people act on.
      if (!searchInput) return;
      searchInput.value = '';
      searchClear.classList.add('hidden');
      closeResults();
    },
    startLocating: () => startLocating(),
  });
  const resetMap = () => endpoints.reset();
  const locateStart = () => endpoints.locateStart();
  const placeStart = (coords, label) => endpoints.placeStart(coords, label);
  const placeEnd = (coords, label) => endpoints.placeEnd(coords, label);
  const setDestination = (coords, name) => endpoints.setDestination(coords, name);
  const coordLabel = (c) => endpoints.coordLabel(c);

  // Who draws the ground, and what to say when they refuse: src/ground.js.
  const ground = createGround({
    map,
    googleKey,
    provider: () => currentProvider,
    basemap: () => currentBasemap,
    theme: () => currentTheme,
    skin: () => currentSkin,
    appliedStyleKey: () => appliedStyleKey,
    setAppliedStyleKey: (key) => { appliedStyleKey = key; },
    setStyleBuilt: (on) => { styleBuilt = on; },
    litPalette,
    setStatus: (sentence, isError) => setStatus(sentence, isError),
    rebuild: () => addNetworkLayers(),
    clearHover: () => pins.clearHover(),
    standBuildings: () => addBuildingsLayer(),
    providerControl: () => providerControl,
    setProvider: (next) => { currentProvider = next; },
    captureStyleLights: (lights) => { benchLights = lights; },
  });
  const syncBasemapStyle = () => ground.sync();

  // Two surfaces, like the three controls below it: the layers menu's
  // radiogroup and the debug menu's. Both are handed over rather than copied,
  // because the control holds the only `mode` there is and repaints every button
  // in every group from it.
  //
  // (There used to be a third form — a one-glyph rail button that cycled through
  // the modes, guessing a next value because a rail button has room for one
  // word. A menu can ask the question outright, three buttons for three answers.)
  createThemeControl({
    groups: [themeModes, document.getElementById('debug-theme-modes')],
    onChange: (theme) => {
      currentTheme = theme;
      syncBasemapStyle();
    },
  });

  // Two surfaces each from here down: the layers menu's, and the debug menu's.
  // The second is a button, not a copy of the state — every surface is repainted
  // from the one value on every change, so pressing either moves both.
  createBasemapToggle({
    surfaces: [
      { button: basemapToggle, icon: basemapIcon, label: basemapLabel },
      {
        button: debugBasemap,
        icon: document.getElementById('debug-basemap-icon'),
        label: document.getElementById('debug-basemap-label'),
      },
    ],
    onChange: (basemap) => {
      currentBasemap = basemap;
      syncBasemapStyle();
    },
  });

  // Last of the three, so that its initial onChange — which can start a session
  // request — runs after the theme and basemap have published their own state.
  providerControl = createProviderToggle({
    // Two doors: the layers menu's, and the debug menu's. This was down to one
    // for a while, after the rail went — the list survived that because the
    // arrangement was right even when only one thing was using it.
    surfaces: [
      { button: providerToggle, icon: providerIcon, label: providerLabel },
      {
        button: debugProvider,
        icon: document.getElementById('debug-provider-icon'),
        label: document.getElementById('debug-provider-label'),
      },
    ],
    onChange: (provider) => {
      currentProvider = provider;
      syncBasemapStyle();
    },
  });

  // After the other three, for the reason the provider control is after the
  // first two: publishing a value calls syncBasemapStyle, and this is the axis
  // that can force a full reload, so it must not run while another control has
  // yet to say what it wants. `currentSkin` itself was read much earlier — the
  // stylesheet needs it before the first frame — so this initial pass only
  // re-publishes a value the style key already agrees with, and reloads nothing.
  createSkinControl({
    surfaces: [
      { button: skinToggle, icon: skinIcon, label: skinLabel },
      {
        button: debugSkin,
        icon: document.getElementById('debug-skin-icon'),
        label: document.getElementById('debug-skin-label'),
      },
    ],
    onChange: (skin) => {
      currentSkin = skin;
      syncBasemapStyle();
    },
  });

  // -------------------------------------------------------------------------
  // Chrome: the layers switcher, the legend and the route panel
  //
  // Small, and none of it touches the map — it opens and closes things. Kept
  // together so the "what does this button do" question has one place to look.
  //
  //   the LEGEND holds the right edge and is open on arrival at desktop widths,
  //   because it is the map's key and a key you have to go and find is not one.
  //   Its close button and the layers-menu row are the two halves of a toggle
  //   for the people who want the whole canvas, and on a phone — where a
  //   right-hand column would be most of the screen — closed is where it starts.
  //
  //   the ROUTE PANEL is closed on arrival, and opens from the top bar's
  //   directions button or from anything that actually sets an endpoint. See
  //   showRoutePanel.
  // -------------------------------------------------------------------------

  const layersBtn = document.getElementById('layers-btn');
  const layersMenu = document.getElementById('layers-menu');
  // legendPanel is declared up with the side panel — campusPadding measures it.
  const legendList = document.getElementById('legend-list');
  // Up here with the legend rather than down with the shelf it sits above,
  // because renderLegend renders both and runs at module level — declared with
  // the shortcuts it would still be in the temporal dead zone at first call.
  const browseGrid = document.getElementById('browse-grid');
  const kindsGrid = document.getElementById('kinds-grid');
  const legendClose = document.getElementById('legend-close');
  const legendOpen = document.getElementById('layers-legend');
  const debugLegend = document.getElementById('debug-legend');
  // directionsBtn is declared up with the panels — setStatus can reach it first.
  const searchGo = document.getElementById('search-go');

  // Which panel is open, and what opening one does to the others:
  // src/panels.js.
  const panels = createPanels({
    map,
    sidePanel,
    legendPanel,
    layersBtn,
    layersMenu,
    legendOpen,
    legendClose,
    debugLegend,
    directionsBtn,
    isPhone: () => phone.matches,
    campusPadding: () => campusPadding(),
    routingEnabled: () => routingEnabled,
    clearLegendHighlight: () => clearLegendHighlight(),
  });
  const toggleSheet = (panel, button, force) => panels.toggleSheet(panel, button, force);
  const toggleRoutePanel = (force) => panels.toggleRoute(force);
  const showRoutePanel = () => panels.showRoute();
  const toggleLegendPanel = (force) => panels.toggleLegend(force);
  const onLegendPressed = () => panels.onLegendPressed();

  legendOpen.addEventListener('click', onLegendPressed);
  debugLegend.addEventListener('click', onLegendPressed);

  layersBtn.addEventListener('click', () => toggleSheet(layersMenu, layersBtn));
  // Click-away, the way every menu of this shape behaves. Bound on the document
  // rather than the map so it also fires over the rest of the chrome.
  document.addEventListener('click', (event) => {
    if (layersMenu.classList.contains('hidden')) return;
    if (layersBtn.contains(event.target) || layersMenu.contains(event.target)) return;
    toggleSheet(layersMenu, layersBtn, false);
  });

  const focusSearch = () => { searchInput.focus(); searchInput.select(); };
  searchGo.addEventListener('click', focusSearch);
  // A toggle rather than an opener, which is what the rail's collapse button
  // used to be for. Only focus the search when the panel is being SHOWN — a
  // click that hides a card should not then put the caret in the field that
  // went with it.
  directionsBtn.addEventListener('click', () => {
    if (toggleRoutePanel()) focusSearch();
  });

  // -------------------------------------------------------------------------
  // The debug menu
  //
  // Its three map controls wired themselves up above, as second surfaces on the
  // controls that already hold that state. What is left is the pair of switches
  // that have no counterpart in the app, and one rule applying both: everything
  // in here is conditional on the panel being OPEN, so closing it is a complete
  // way out and there is no combination of flags a visitor can be stranded in.
  //
  // The panel is deliberately NOT in campusPadding's list. Every other card is,
  // because the campus should not sit under one — but the whole use of this one
  // is to look at the map as it will actually be framed, and a panel that moved
  // the camera to make room for itself would be changing the thing it was
  // opened to inspect.
  // -------------------------------------------------------------------------

  // Whether the locate control is watching. Tracked from its own events rather
  // than inferred, because `trigger()` is a toggle: called while it is already
  // watching it stops it, so switching the fixture off and on again would turn
  // The locate control, and the two-press unlock in front of it:
  // The locate control, and the two-press unlock in front of it: src/locate.js.
  const locate = createLocate({ control: () => geolocateControl });
  const startLocating = (attempt) => locate.start(attempt);

  // What each debug switch actually does to the running app: src/debug-apply.js.
  const debugFlags = createDebugFlags({
    geolocation,
    centre: CAMPUS_CENTRE,
    endpoints,
    locate,
    applyLighting: () => applyLighting(),
    toggleRoutePanel: (force) => toggleRoutePanel(force),
    showNavbar: (on) => showNavbar(on),
    directionsBtn,
    setOpen: (on) => { debugOpen = on; },
    setShowFps: (on) => { showFps = on; },
    setRoutingEnabled: (on) => { routingEnabled = on; },
    routingEnabled: () => routingEnabled,
  });
  const applyDebug = (flags) => debugFlags.apply(flags);

  // Before createDebugMenu, so that the menu's first onChange — which can open
  // the panel, and therefore open the gate — finds a bench to read rather than
  // a null. The bench's own first publish is a no-op either way: `debugOpen` is
  // still false at this point, so applyLighting puts the app's own values back
  // over the app's own values.
  createLightingControl({
    root: document.getElementById('debug-lighting'),
    emissive: BUILDING_EMISSIVE,
    onChange: (bench) => {
      lightingBench = bench;
      applyLighting();
    },
  });

  createDebugMenu({
    panel: debugPanel,
    close: document.getElementById('debug-close'),
    switches: {
      routing: document.getElementById('debug-routing'),
      gps: document.getElementById('debug-gps'),
      fps: document.getElementById('debug-fps'),
      twopoint: document.getElementById('debug-twopoint'),
      navbar: document.getElementById('debug-navbar'),
    },
    onChange: applyDebug,
  });

  // -------------------------------------------------------------------------
  // The legend, which is also the query
  //
  // Generated from src/categories.js, so the key and what it finds cannot
  // disagree about what this map's symbols mean.
  //
  // This list and the chip strip used to be two controls. They were built from
  // the same eleven rows in the same order with the same pictograms, and the
  // only thing that distinguished them was which half of the question they
  // answered — a chip answered "where are the defibrillators" with pins, a
  // legend row answered "which buildings have one" with an outline. That is a
  // distinction about the asking, not about the thing asked after, and paying
  // for it in two pieces of chrome was the wrong trade.
  //
  // One list, two interactions, both of which a row already had:
  //
  //   POINT at a row (hover, or focus, so it works from the keyboard) and the
  //   buildings and car parks holding that thing outline. Undoable — moving off
  //   puts back whatever was selected — so running an eye down eleven rows
  //   costs nothing.
  //
  //   PRESS a row and it becomes the category: its pins arrive with their names
  //   over a cleared map, the results list opens on the left, the camera frames
  //   them, and the outline stays up underneath. Press it again for the campus
  //   back.
  //
  // The two do not fight — one paints ground, the other draws markers — which
  // is what made merging them possible rather than merely tidy.
  // -------------------------------------------------------------------------

  // The legend, the chips, and what each one lights up: src/legend.js.
  const legend = createLegend({
    map,
    litPalette,
    elements: {
      legendList, browseGrid, kindsGrid, legendPanel, categoryPanel,
    },
    isPhone: () => phone.matches,
    data: {
      amenities: () => campusAmenities,
      places: () => campusPlaces,
      buildings: () => campusBuildings,
      directory: () => campusDirectory,
      sheet: () => campusBasemap,
    },
    camera,
    /** Straight-line feet from wherever the user is measuring from. */
    feetFrom: (coords) => {
      const origin = endpoints.start()?.geometry.coordinates ?? map.getCenter().toArray();
      return distance(point(origin), point(coords)) * FEET_PER_KM;
    },
    playSwap: () => choreo.swap(),
    playClear: () => choreo.clear(),
    toggleSheet: (panel, button, force) => toggleSheet(panel, button, force),
    legendOpen,
    addCategoryLayer: () => markers.addCategory(),
    setDestination: (coords, name) => setDestination(coords, name),
    buildingSub: (props) => buildingSub(props),
  });
  const shownCategory = () => legend.shownCategory();
  const shownHits = () => legend.shownHits();
  const addHighlightLayers = () => legend.addHighlightLayers();
  const clearResults = () => legend.clearResults();
  const clearLegendHighlight = () => legend.clearHighlight();
  const buildLegendIndex = () => legend.buildIndex();
  const renderLegend = () => legend.renderLegend();
  const enableCategories = () => legend.enableCategories();

  renderLegend();
  // Disabled and countless until directory.json lands, for the same reason the
  // legend's rows are: ten tiles that all read "0 buildings" is a grid that
  // looks broken rather than early.
  legend.renderKinds();

  map.on('load', async () => {
    // From here on the sky is followed rather than sampled once. See
    // watchDaylight.
    watchDaylight();
    // Real GPS. Requires a secure context (https or localhost) or the browser
    // silently refuses to report a position.
    //
    // `geolocation` is ours rather than the browser's, which is a seam the
    // control provides for exactly this. It passes every call straight through
    // to `navigator.geolocation` until the debug menu stands a fixture in the
    // middle of the campus, and the control never learns that anything changed
    // — so what appears on screen is the real interface, not a drawing of it.
    // See src/geolocation.js.
    const geolocate = new mapboxgl.GeolocateControl({
      geolocation,
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    });
    geolocateControl = geolocate;
    // Bottom-right, which is where Google keeps locate, zoom and the scale bar,
    // and in that order up the stack: scale on top, then locate, then the zoom
    // pair, with the credit line under all three.
    //
    // Which means adding them in the opposite order to the one they appear in.
    // `addControl` APPENDS for a top corner and PREPENDS for a bottom one —
    // `-1 !== position.indexOf('bottom') ? insertBefore(el, firstChild) : ...`
    // — so a bottom stack reads bottom-up in the order it was written. This
    // used to read geolocate, navigation, scale under a comment claiming that
    // put locate above the zoom pair "as it is on their map"; it put it below.
    // THE OTHER CORNER, beside the wordmark rather than under the zoom buttons.
    //
    // Not a tidying: it is what lets the sheet reach the bottom of the screen.
    // A phone's card is bottom-anchored and the credit has to stay visible over
    // it — attribution is a licence term — but the corner containers carry
    // Mapbox's own z-index and are therefore stacking contexts, so nothing
    // inside one can be raised past the sheet on its own. Raising the whole
    // bottom-RIGHT corner would float the zoom and locate buttons over the card
    // as well. Bottom-left holds nothing but credits, so it can go over the
    // sheet whole, and the two licence terms end up in one line instead of one
    // in each corner with a card between them.
    //
    // Spelled out rather than folded behind an "i". That button was never a
    // good citizen of this corner: Mapbox gives it a 24px container, and the
    // 44px touch area this app grew around it therefore reached 20px past its
    // own box to the right and 10px above its own bottom — a black disc sitting
    // over the corner of the zoom control, outside the right edge everything
    // else in the stack lines up on.
    //
    // NOT SIMPLY DELETED, THOUGH, and this is the part worth writing down:
    // attribution is a licence term for both providers — Mapbox's terms require
    // their notice, and Google's Map Tiles API requires the copyright string
    // that src/google-tiles.js already fetches per viewport and hands to the
    // source. An app that dropped the control would be quietly out of
    // compliance with both. `compact: false` keeps the notice on screen as text
    // and takes away only the toggle. The Map is built with
    // `attributionControl: false` so that this one is the only one.
    map.addControl(new mapboxgl.AttributionControl({ compact: false }), 'bottom-left');
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(geolocate, 'bottom-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'imperial' }), 'bottom-right');


    // And the layers switcher on top of all of it, in the same corner.
    //
    // It held the bottom-LEFT corner on its own until now. Handing it to
    // addControl rather than placing it with CSS is what keeps it in step: the
    // stack's spacing is one `gap` on a flex column, so a control that joins
    // the column is spaced by the same rule as the rest and cannot end up two
    // pixels out from the scale bar the way a hand-positioned `bottom` would
    // the first time a control changed height. Prepended, like every other
    // bottom-corner control, so being added last is what puts it at the top.
    //
    // A bare element is not enough: Mapbox's corner containers are
    // `pointer-events: none` and hand `auto` back to `.mapboxgl-ctrl` only, so
    // the stylesheet gives this one its clicks back — see .g-layers.
    const layersEl = document.querySelector('.g-layers');
    map.addControl({
      onAdd: () => layersEl,
      onRemove: () => layersEl.remove(),
      getDefaultPosition: () => 'bottom-right',
    }, 'bottom-right');
    geolocate.on('geolocate', (e) => {
      // Kept for the next Directions press, so it can answer from what the
      // control already knows instead of waking the radio again. See
      // currentPosition, which is the only reader.
      endpoints.noteFix({ at: [e.coords.longitude, e.coords.latitude], when: Date.now() });
      // A simulated walk pushes a new fix every SIM_TICK_MS, so the camera ease
      // has to finish inside one tick. At a second apiece every fix would
      // interrupt the last and the dot would slide along a route the camera
      // never catches up with.
      nav.moved([e.coords.longitude, e.coords.latitude],
        { duration: nav.isSimulating() ? SIM_TICK_MS : 1000 });
    });

    // What `locating` is kept in step with — see startLocating for why guessing
    // at it is not good enough. Both events are the control's own.
    geolocate.on('trackuserlocationstart', () => locate.setLocating(true));
    geolocate.on('trackuserlocationend', () => locate.setLocating(false));

    // A page reloaded with the debug fixture already set asked for the blue dot
    // before this control existed. It exists now.
    if (geolocation.fixture) startLocating();

    // All from the same server, so ask together — and DRAW EACH ONE AS IT
    // LANDS, rather than waiting for the slowest.
    //
    // This used to be one `await Promise.allSettled([...])` with the handling
    // below it, which meant nothing appeared until every request had finished.
    // Measured at 8 Mbps: seven of the eight were done at 13.8 s and the
    // basemap sheet at 15.3 s, so buildings — 37 KB, arrived at 13.5 s — sat in
    // hand for nearly two seconds waiting on a 1.6 MB file it has no
    // relationship to. The campus then appeared all at once, which is why a
    // fully drawn Google basemap with a campus-shaped hole in it was the normal
    // sight on a phone. Their tiles paint one at a time; ours had one gate.
    //
    // Each branch is independent and each one degrades alone: lose a file and
    // the layer it draws is missing, not the load. Only two orderings exist and
    // both are stated where they are needed — labels wait on the sheet, and the
    // routing tail waits on both of its own requests.
    //
    // Said out loud while it happens, because until the network settles the map
    // is a picture — and the hint under the distance is describing a gesture
    // that will not do anything yet. The failure mode without this is somebody
    // pressing and holding on a map that has not finished arriving and
    // concluding the app is broken.
    setBusy(true);
    setProgress('Loading the campus…');

    /** A source that failed is one missing layer, so it is logged and stepped over. */
    const orElse = (whenMissing) => (reason) => { console.error(reason); whenMissing?.(); };

    const buildingsReady = fetchOverlay('buildings').then((data) => {
      campusBuildings = data;
      if (navigating()) addBuildingsLayer();
      buildLegendIndex();
    }, orElse());

    const basemapReady = fetchOverlay('basemap').then((data) => {
      // Trimmed to the campus on the way in. my campus's sheet carries the streets
      // around it, both north arrows and the trees along the verge, and every
      // one of those lands on a ground that is already drawing them — see
      // src/campus-clip.js.
      campusBasemap = trimToCampus(data, CAMPUS_RING);
      addBasemapLayers();
      // The sheet arriving is what this was waiting for — the closed block is
      // one of its shapes, so on a cold load style.load has already been and
      // gone with nothing for addClosedLayers to draw.
      addClosedLayers();
      buildLegendIndex();
    }, orElse());

    const amenitiesReady = fetchOverlay('amenities').then((data) => {
      // Named on the way in, the same way the labels are classified: only the
      // four amenities whose label identifies them keep one to print. See
      // withAmenityNames — the other eighty said the icon's own meaning, in
      // type, four times over on a single building.
      campusAmenities = withAmenityNames(data);
      addLampLayers();
      addAmenityLayer();
      enableCategories();
      buildLegendIndex();
    }, orElse());

    const placesReady = fetchOverlay('places').then((data) => {
      // The directory keeps the rows my campus lists without a room so a search index
      // can still be built from the file, but a null geometry is not something
      // a vector source can tile — drop them on the way in.
      campusPlaces = {
        type: 'FeatureCollection',
        features: data.features.filter((feature) => feature.geometry),
      };
      buildSearchIndex();
      enableCategories();
      buildLegendIndex();
    }, orElse());

    const directoryReady = fetchOverlay('directory').then((data) => {
      campusDirectory = data;
      // The cold-start half of the suggestion order is read off this file, so
      // the ranking is only complete once it is here.
      refreshPopularity();
      addDirectoryLayers();
      // Built once, on arrival, rather than when the debug menu opens: it is
      // thirty rows off a file that is already in hand, and doing it now means
      // the menu is never briefly empty on the frame it is opened.
      //
      // No re-frame after it. The list used to be in the left column, where
      // thirty rows landing was a chunk of canvas that had not been reserved
      // when the campus was first fitted; a card that floats over the map on
      // request costs the framing nothing.
      renderBuildings();
      buildLegendIndex();
    }, orElse(() => {
      // Nothing to list, so the section goes rather than sitting empty under a
      // heading. Its own hidden state, not the debug menu's — the rest of the
      // card is unaffected by a directory that failed to load.
      buildingsPanel.classList.add('hidden');
    }));

    // THE ONE ORDERING AMONG THE OVERLAYS. Requested now, with the rest, so it
    // is on the wire in parallel; applied only once the sheet has been dealt
    // with, because withParkingMarks reads it. `basemapReady` has already
    // swallowed its own failure, so this runs either way — and if the sheet
    // never came, withParkingMarks adds nothing and the five named lots still
    // get their P.
    const labelsArrived = fetchOverlay('labels');
    const labelsReady = basemapReady.then(() => labelsArrived).then((data) => {
      // Classified on the way in rather than in the build script: which disc a
      // building name earns is presentation, and labels.json stays exactly what
      // my campus's cartographer set. See src/poi.js.
      // ...and the lots my campus never named get a marker before that runs, so the
      // generated ones and the printed ones are classified by the same pass and
      // cannot end up wearing different discs.
      campusLabels = withPoiIcons(withParkingMarks(data, campusBasemap));
      addLabelLayers();
    }, orElse());

    // The routing tail, which is the only branch that needs two of its own
    // requests and the only one whose failure is worth telling somebody about:
    // an overlay that does not arrive costs a layer, and this costs the app.
    const routingReady = Promise.allSettled([fetchNetwork(), fetchVertices()])
      .then(([networkResult, vertexResult]) => {
        if (networkResult.status === 'rejected') {
          console.error(networkResult.reason);
          setStatus('Routing server unreachable — is `npm run dev` still running?', true);
          return;
        }
        const routable = networkResult.value;

        // Snapping targets come from /api/vertices, which is the whole routing
        // graph. Falling back to the drawn network keeps clicks working on
        // campus if that one request fails — degraded, not broken: a start point
        // outside the fence would be dragged in to the nearest campus path.
        const vertices = vertexResult.status === 'fulfilled'
          ? vertexResult.value.vertices
          : [...new Map(routable.features
            .flatMap((f) => f.geometry.coordinates)
            .map((c) => [`${c[0]},${c[1]}`, c])).values()];
        if (vertexResult.status === 'rejected') console.error(vertexResult.reason);
        networkPoints = featureCollection(vertices.map(v => point(v)));

        // The moment a press-and-hold starts meaning something, and therefore
        // the moment it is honest to advertise one. Until here the strip has
        // been showing "Loading the campus…" over a map that could not be
        // routed on.
        setIdleStatus();

        // Drawn only as far as the fence. my campus's driveways are drawn running out
        // to the public road, and past the boundary that white ribbon lands on
        // top of a road the basemap is already drawing. Cut rather than dropped,
        // so a driveway still reaches the gate instead of stopping at the
        // junction inside it — the route still runs the whole way, over their
        // linework.
        customNetwork = trimToCampus(routable, CAMPUS_RING);

        map.getSource('custom-network').setData(customNetwork);
      });

    // The spinner belongs to the whole errand, so it stops when the last of
    // these does — not when the first layer appears.
    await Promise.allSettled([
      buildingsReady, basemapReady, amenitiesReady, placesReady,
      directoryReady, labelsReady, routingReady,
    ]).finally(() => setBusy(false));
  });

  // -------------------------------------------------------------------------
  // Setting the two ends
  //
  // Both the map click and the search box arrive here, so a searched
  // destination and a clicked one behave identically from this point on.
  // The cursor says what a click will do. Over a pin or a building that is
  // "open this", so it becomes a pointer; everywhere else it is Mapbox's own —
  // the grab hand, which is the truth about the rest of the map, since dragging
  // is what the empty parts of it are for.
  //
  // It used to be a crosshair off the pins, from when a click anywhere set a
  // route endpoint and the whole canvas really was a target. That is behind the
  // debug menu's routing switch now, so for a visitor the crosshair was
  // promising a precision the map no longer asks for. An empty string rather
  // than 'grab' or 'default' so the value comes from Mapbox's stylesheet and
  // stays right if dragging is ever disabled.
  //
  // One query across all three rather than pinAt() and buildingAt() in turn:
  // this runs on every mouse move, and three hit tests a frame to decide the
  // shape of a cursor is three times the work the answer is worth.
  // Every layer that draws a pin, plus the building footprints. One query, and
  // the TOPMOST feature wins rather than pinAt's fixed layer order: a hover is
  // about what the pointer is visibly on, and what it is visibly on is whatever
  // was drawn last.
  const POINTER_LAYERS = () =>
    ['category-pins', 'campus-amenities', ...POI_LABEL_LAYERS, 'campus-directory-hit']
      .filter((id) => map.getLayer(id));

  map.on('mousemove', (e) => {
    if (navigating()) return;
    const layers = POINTER_LAYERS();
    const [hit] = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
    // A building is pressable and gets the cursor, but it is not a pin and has
    // nothing to spring — its own hover is the outline highlight.
    //
    // `hit.id` is checked, not assumed. Every pin source is declared with
    // `generateId`, so one is always there; an expression built around an
    // undefined id would be rejected outright by the style validator, which is
    // too sharp an edge to leave resting on a property of the data.
    const pin = hit && hit.id != null && hit.layer.id !== 'campus-directory-hit';
    hoverPin(pin ? { layer: hit.layer.id, id: hit.id } : null);
  });

  // The pointer leaving the canvas fires no mousemove, so without this a pin
  // stays big and tinted while the pointer is over the sidebar.
  map.on('mouseout', () => hoverPin(null));

  // Esc puts a selection back, which is the one thing every card on every map
  // agrees on. Both halves of it: a tap on a footprint opens a card without
  // lifting anything, so an Esc that only put pins down would leave that one up.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSelection();
  });

  map.on('click', (e) => {
    if (navigating() || !networkPoints) return;
    // The release at the end of a press-and-hold. That gesture has already done
    // its work; without this the same finger would drop a route point and then
    // immediately clear the selection on the way back up.
    if (longPress.consumeClick()) return;

    // A tap on a pin lifts it rather than dropping a second one beside it.
    // Tested before buildings because pins sit on top of them and half of them
    // are inside one — a defibrillator tapped through the Library's footprint
    // would otherwise open the Library.
    // A tap on a pin lifts it. If that pin is a building's own name, the
    // building card is the better thing to put beside it, so the lift happens
    // without the small one and the existing card path runs underneath.
    const pin = pinAt(e.point);
    if (pin) {
      const named = pin.text ? (buildingAt(e.point) ?? directoryRow(pin.text)) : null;
      selectPin(pin, { card: !named });
      if (named) showBuildingCard(named);
      return;
    }
    clearSelection();

    // Anywhere else on the map puts the campus back.
    //
    // Pressing the lit legend row again already does this, but that row is over
    // on the right and the thing you want to dismiss is under your finger.
    // Tapping away is what people try first, and until it was handled here it
    // fell through to the router and dropped a start point on the map instead.
    //
    // CONSUMED, not passed on: this returns rather than carrying on to the
    // building card below. One tap should do one thing, and a tap that both
    // cleared the restrooms and opened whatever building was behind them would
    // leave the map in a state nobody asked for. The second tap gets the
    // building.
    if (legend.isActive()) { legend.clearCategory(); return; }

    // A tap on a building asks what it is rather than dropping a pin on it.
    // The card's own buttons then set a start or destination, and they do it at
    // the entrance node rather than wherever the finger landed.
    const building = buildingAt(e.point);
    if (building) {
      showBuildingCard(building);
      return;
    }
    closeBuildingCard();

    // ...and a tap on bare ground now does nothing else. Route points are the
    // press-and-hold below, and a double-click is Mapbox's own zoom. See the
    // note on LONG_PRESS_MS for why that trade is the right way round.
  });

  // -------------------------------------------------------------------------
  // Dropping a route point
  //
  // The gesture itself is src/long-press.js — how long a hold is, how far a
  // finger may travel first, the ring that shows it happening and the six
  // events that end one. What a completed hold MEANS is here, because it
  // reaches into the marker, the place card and both route endpoints, and
  // none of that is the recogniser's business.
  // -------------------------------------------------------------------------

  /**
   * What a completed hold does: it drops a pin, and a pin is a PLACE.
   *
   * It used to set a route endpoint directly — the first hold a start, the
   * second an end — and that made the gesture a commitment. You could not point
   * at a spot on this map without also declaring what you meant to do about it,
   * and the two holds had to be done in the right order to mean anything.
   *
   * A dropped pin is now the same kind of thing as a building or a defibrillator
   * — something you tapped, with a card saying what it is and what you can do
   * about it — which is what makes "Directions" mean one thing everywhere. The
   * two-point walk survives whole and is now explicit rather than positional:
   * "Start here" on one pin, "Directions" on the next.
   */
  function dropPin(lngLat) {
    const clicked = point([lngLat.lng, lngLat.lat]);
    // Snapping the click locally keeps the marker instant; the server snaps
    // again on its own side, and lands on the same vertex.
    const snapped = nearestPoint(clicked, networkPoints).geometry.coordinates;

    // Takes the previous dropped pin with it — see clearSelection.
    clearSelection();

    droppedMarker = new mapboxgl.Marker({
      element: routePin(GOOGLE_RED, { title: 'Dropped pin' }),
      anchor: 'bottom',
      offset: liftedOffset(ROUTE_PIN_W),
    })
      .setLngLat(snapped)
      .addTo(map);

    showPlaceCard(pinCard(
      // The coordinates are the subtitle because they are the only true thing
      // there is to say about a point somebody chose off the map. Apple prints
      // them on its dropped pin for the same reason.
      { coords: snapped, kind: 'dropped', name: 'Dropped pin', sub: coordLabel(snapped) },
      {
        onStart: (coords) => {
          clearSelection();
          placeStart(coords, 'Dropped pin');
          // A destination chosen before a start has been waiting for this.
          const parked = endpoints.takeParked();
          if (parked) {
            placeEnd(parked.coords, parked.name);
          } else {
            setStatus('Starting from the dropped pin. Now pick where you are going.');
          }
        },
        onEnd: (coords) => { clearSelection(); setDestination(coords, 'Dropped pin'); },
        onClose: clearSelection,
      },
    // Kept in view, but NOT zoomed. A long press is a deliberate gesture at a
    // particular spot on the ground, and zooming would pull that ground out
    // from under the finger that just chose it. The pin still gets lifted clear
    // of the sheet if the sheet lands on it.
    ), null, { at: snapped, zoom: 0 });
  }

  const longPress = createLongPress({
    map,
    // Not during a walk, and not before the network has landed — there is
    // nothing to snap a dropped pin to until it has.
    enabled: () => !navigating() && Boolean(networkPoints),
    onHold: dropPin,
  });


  // -------------------------------------------------------------------------
  // Destination search
  //
  // Over places.json, which is my campus's own directory rather than anything derived
  // — 120 rows, names and descriptions as they publish them. Their descriptions
  // enumerate what is inside each building ("This building consists of Board
  // Room, Cafeteria…"), so searching "cafeteria" has to find Student Center;
  // that is why descriptions are in the haystack and not just the names.
  //
  // Every row is bound to routing nodes, so a chosen destination is already a
  // graph vertex and needs no snapping.
  // The field, its list, the shelf under it and the two endpoint fields in the
  // route panel: src/search-box.js. What it RANKS is src/search-rank.js.
  const searchBox = createSearchBox({
    places: () => campusPlaces,
    directory: () => campusDirectory,
    afterExit: (el, empty) => afterExit(el, empty),
    setDestination: (coords, name) => setDestination(coords, name),
    directoryRow: (name) => directoryRow(name),
    buildingSub: (props) => buildingSub(props),
    setStatus: (sentence, isError) => setStatus(sentence, isError),
    measureFrom: () => endpoints.start()?.geometry.coordinates ?? map.getCenter().toArray(),
  });
  const searchInput = searchBox.input;
  const searchClear = searchBox.clear;
  const closeResults = () => searchBox.closeResults();
  const buildSearchIndex = () => searchBox.buildIndex();
  const refreshPopularity = () => searchBox.refreshPopularity();
  const wireEndpointField = (options) => searchBox.wireEndpointField(options);

  const rerouteFromStart = () => endpoints.rerouteFromStart();

  wireEndpointField({
    input: startCoordText,
    list: document.getElementById('start-results'),
    offerHere: true,
    onPick: async (coords, name, here) => {
      if (!routingEnabled) return;
      if (here) {
        if (await locateStart()) await rerouteFromStart();
        return;
      }
      placeStart(coords, name);
      await rerouteFromStart();
    },
  });

  wireEndpointField({
    input: endCoordText,
    list: document.getElementById('end-results'),
    offerHere: false,
    onPick: async (coords, name) => { await setDestination(coords, name); },
  });


}
