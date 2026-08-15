import mapboxgl from 'mapbox-gl';
// Imported rather than linked from the CDN so the stylesheet can never drift
// out of step with the library version resolved in package.json.
import 'mapbox-gl/dist/mapbox-gl.css';
// Small enough to bundle, and it must be present on the very first frame: the
// mask exists to hide Mapbox's data, so fetching it would show a flash of the
// thing it is there to remove.
import campusBoundary from './campus-boundary.json';
import { point, lineString, featureCollection } from '@turf/helpers';
import { nearestPoint } from '@turf/nearest-point';
import { distance } from '@turf/distance';
import { nearestPointOnLine } from '@turf/nearest-point-on-line';
import { along } from '@turf/along';
import { bearing } from '@turf/bearing';
import {
  cumulativeDistances,
  instructionFor,
  niceFeet,
  FEET_PER_KM,
} from './maneuvers.js';
import { maneuverIcon } from './nav-icons.js';
import {
  loadAmenityIcons, routePin, liftedOffset, ROUTE_PIN_W, PIN_BASE_W, AMENITY_KINDS, pinInk,
  pinColour,
} from './map-images.js';
import { buildingCard, pinCard } from './building-popup.js';
import {
  mountSelectedPin, sizeExpr, sizeAt, LABEL_MAX_EM,
  AMBIENT_SIZE, CATEGORY_SIZE, LABEL_SIZE,
  growEase, shrinkEase, swayAt, scaleStops, GROW_MS, SHRINK_MS, SWAY_MS,
} from './pin-select.js';
import { createThemeControl, preferredTheme, applyThemeAttribute } from './theme.js';
import { createBasemapToggle, preferredBasemap } from './basemap.js';
import { createProviderToggle, preferredProvider } from './provider.js';
import { createSkinControl, preferredSkin, applySkinAttribute } from './skin.js';
import { googleGround } from './google-tiles.js';
import { canFlyOver, framing, boxOf, footprintExtent, roofOf } from './flyover.js';
import { createFlyover } from './flyover-view.js';
import { spin } from './spinner.js';
import { paintIcons } from './g-icons.js';
import { CATEGORIES, CATEGORY_BY_ID, collect } from './categories.js';
import {
  withPoiIcons, withParkingMarks, withAmenityNames, poiFor, POI_LABEL_KINDS,
  AMENITY_ZOOM, AMENITY_ZOOM_DEFAULT,
} from './poi.js';
import { ringOf, centreOf, trimToCampus } from './campus-clip.js';
import { bayRake } from './bay-rake.js';
import { createGeolocation } from './geolocation.js';
import { createDebugMenu } from './debug.js';
import { createLightingControl } from './lighting.js';
import roomsData from './rooms.json';
import { buildRoomIndex, lookupRoom } from './rooms.js';
import { FONTS, SATELLITE, palette, styleKey } from './palette.js';

import {
  buildAreas,
  highlightFor,
  areaCollection,
  pointCollection,
  extentOf,
} from './highlight.js';

// The chrome's button glyphs are named in the markup and drawn here, before
// anything else runs, so no button ever paints as an empty box.
paintIcons();

const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
// Optional. Absent, the provider toggle still renders but says so when pressed
// rather than silently doing nothing — see addGoogleGround.
const googleKey = import.meta.env.VITE_GOOGLE_MAPS_KEY;


// Google's road ribbon, in pixels. Not the ground-width curve the printed sheet
// uses: paths.json carries only `from`/`to`, so there is no per-segment width to
// scale, and a road drawn at its true 3.3 m would vanish at campus zoom anyway.
// Google solves this the same way — road width is a function of zoom and class,
// never of the real carriageway.
const NETWORK_WIDTH = [
  'interpolate', ['exponential', 1.6], ['zoom'],
  14, 1.2,
  16, 3.5,
  18, 8,
  20, 18,
];

// Wider than the core by roughly a pixel and a half per side at every zoom,
// which is the proportion Google holds. Drawn underneath, so only the overhang
// shows.
const NETWORK_CASING_WIDTH = [
  'interpolate', ['exponential', 1.6], ['zoom'],
  14, 2.4,
  16, 5.6,
  18, 11,
  20, 23,
];

// Google's own pin colours, for the two markers the router plants. Origin green
// and destination red is their convention as well as the one this app already
// used; only the values move.
const GOOGLE_GREEN = '#1e8e3e';
const GOOGLE_RED = '#ea4335';

// Comfortable campus walking pace. Used for the ETA and for the simulator.
const WALK_FEET_PER_SEC = 4.6;
// How close you must get before a maneuver is considered done, in km.
const MANEUVER_REACHED_KM = 25 / FEET_PER_KM;
const ARRIVED_FEET = 25;
const SIM_TICK_MS = 200;
const SIM_SPEED = 4;
// How far up the route the camera aims. Clamped to the next maneuver, so this
// only controls heading stability on long straights, never turn timing.
const LOOK_AHEAD_KM = 60 / FEET_PER_KM;
const MIN_AIM_KM = 8 / FEET_PER_KM;
// Banner transition timing, in ms.
// Must match --banner-swap in input.css: it is how long both signs are on
// screen together before the outgoing one is removed from the DOM.
const BANNER_SWAP_MS = 320;

const EMPTY = { type: 'FeatureCollection', features: [] };

// Bounding box of the walkable network, [[west, south], [east, north]]. Printed
// by scripts/build-walk-network.mjs — regenerate paths.json and update this.
const CAMPUS_BOUNDS = [
  [-121.350452, 38.644706],
  [-121.342319, 38.653606],
];

// Breathing room around the campus when it is framed, in px.
const FIT_MARGIN = 40;

// The line everything of ours stops at. Same polygon the mask is cut from, so
// the ground cover and the linework end together rather than a metre apart.
const CAMPUS_RING = ringOf(campusBoundary);

// Where the debug menu's virtual GPS fix stands. The centroid of that ring, so
// it moves with the boundary rather than being a pair of numbers that quietly
// stops meaning "the middle of the campus" the next time the ring is redrawn.
const CAMPUS_CENTRE = centreOf(CAMPUS_RING);

if (!accessToken || accessToken === 'YOUR_MAPBOX_TOKEN_HERE') {
  console.warn("Please add your Mapbox Access Token to the .env file as VITE_MAPBOX_TOKEN.");
} else {
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

  const map = new mapboxgl.Map({
    container: 'map',
    style: palette(currentProvider, currentBasemap, currentTheme, currentSkin).style,
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
    // the camera cannot leave CAMPUS_BOUNDS: there is no long pan across a
    // city to refetch, only one campus at two or three zooms. Raise this first
    // if the tile bill ever looks wrong.
    maxTileCacheSize: 60,
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
  // Which building the outline in the directory layers belongs to. There was a
  // second variable beside it holding the open card, back when the card was a
  // Mapbox popup that had to be kept and removed; the card is the contents of
  // #place-panel now, so the panel's own hidden state is the whole of it.
  let selectedBuilding = null;

  // State variables
  let startMarker = null;
  let endMarker = null;
  let startPoint = null;
  let endPoint = null;
  let requestSeq = 0;

  // Navigation state
  let routeCoords = null;      // the raw LineString coordinates
  let routeLine = null;        // same, as a turf feature, for snapping
  let cumulative = null;       // along-route distance (km) at every vertex
  let maneuvers = null;        // supplied by the server
  let stepIndex = 0;
  let navActive = false;
  let lastBearing = 0;
  let userMarker = null;
  let simTimer = null;
  let simAlong = 0;

  // The lighting bench, and whether anybody is standing at it. Both are read by
  // applyLighting and nothing else: `debugOpen` is the gate that keeps a bench
  // setting from following somebody out of the back room, and `benchLights` is
  // Standard's own light array, captured on every style load so the override
  // has something to be put back to. See src/lighting.js.
  let lightingBench = null;
  let debugOpen = false;
  /** Whether a selected pin trails a ghost of itself. Debug menu only. */
  let pinBlur = false;
  let benchLights = null;
  let benchTilt = false;
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

  // Banner transition state
  let renderedStep = -1;
  let bannerBusy = false;
  let bannerTimers = [];
  let liveCard = null;      // the sign currently showing; owns the countdown

  // GUI Elements
  // Three refs for one line of text: the paragraph carries the error class, the
  // span inside it carries the words, and the span beside that holds the
  // spinner. See setStatus and setBusy.
  const instructionText = document.getElementById('instruction-text');
  const instructionMessage = document.getElementById('instruction-message');
  const instructionBusy = document.getElementById('instruction-busy');
  const startCoordText = document.getElementById('start-coord');
  const endCoordText = document.getElementById('end-coord');
  const distanceText = document.getElementById('distance-text');
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
  // sheet over the map it is not, so on a phone it starts closed. Set here and
  // not with the rest of the chrome because campusPadding measures this panel
  // and the first fitBounds is a few lines below — closing it afterwards would
  // frame the campus around a card that is not there. The button that re-opens
  // it is told about this where it is declared.
  if (phone.matches) legendPanel.classList.add('hidden');
  const navBanner = document.getElementById('nav-banner');
  const navFooter = document.getElementById('nav-footer');
  const navStack = document.getElementById('nav-stack');

  /**
   * Padding for framing the campus. The chrome floats over the west edge of the
   * map, so an even margin centres the campus in the *container* and leaves it
   * visibly pushed left in the part you can actually see. Reserving the real
   * width of whatever is open fixes that, and it has to be measured rather than
   * hard-coded because both cards come and go.
   *
   * Every card, not one. Three of them stack in the left column and the legend
   * holds the right edge, and each is a strip of canvas the campus can be hidden
   * under — framing a highlight beneath the legend row that asked for it is the
   * one place the camera can put something where it cannot be seen.
   *
   * Mapbox throws if padding exceeds the canvas, so on a screen too narrow to
   * hold both sides, fall back to an even margin and let the chrome overlap.
   */
  function campusPadding() {
    const even = { top: FIT_MARGIN, bottom: FIT_MARGIN, left: FIT_MARGIN, right: FIT_MARGIN };
    const canvas = map.getCanvas().getBoundingClientRect();
    if (!canvas.width) return even;

    // buildingsPanel is not in this list and must not be: it is a section of
    // the debug card now, and the debug card is a thing you open, read and
    // close rather than a panel the map is framed around.
    const boxes = [placePanel, categoryPanel, sidePanel, legendPanel]
      .filter((card) => !card.classList.contains('hidden'))
      .map((card) => card.getBoundingClientRect())
      .filter((box) => box.width);
    if (!boxes.length) return even;

    // Below 640px the stylesheet turns the column into a bottom sheet spanning
    // the full width, and there what a card costs is height, not width.
    // Reserving its width would exceed the canvas and fall back to an even
    // margin, which puts the campus underneath it. Either card can be the sheet
    // — on a phone the legend replaces the route panel rather than stacking
    // under it — so this asks the boxes, not one named element.
    const sheet = boxes.filter((box) => box.width >= canvas.width * 0.6);
    if (sheet.length) {
      const bottom = canvas.bottom - Math.min(...sheet.map((box) => box.top)) + FIT_MARGIN;
      return bottom + FIT_MARGIN < canvas.height ? { ...even, bottom } : even;
    }

    // Both edges now. A card in the right half used to be skipped outright,
    // because until the legend moved over there nothing was ever in it.
    let left = FIT_MARGIN;
    let right = FIT_MARGIN;
    for (const box of boxes) {
      if (box.left - canvas.left > canvas.width / 2) {
        right = Math.max(right, canvas.right - box.left + FIT_MARGIN);
      } else {
        left = Math.max(left, box.right - canvas.left + FIT_MARGIN);
      }
    }
    if (left + right >= canvas.width) return even;
    return { ...even, left, right };
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

  function setDistanceFeet(feet) {
    distanceText.innerHTML =
      `${Math.round(feet).toLocaleString()} <span class="g-route-unit">ft</span>`;
  }

  function setNavButtonsEnabled(enabled) {
    startNavBtn.disabled = !enabled;
    simulateBtn.disabled = !enabled;
  }

  /**
   * Routing is a network call now, so "server is down" is a state the UI has to
   * show plainly — otherwise it looks like the buttons are simply broken.
   */
  function setStatus(message, isError = false) {
    // The panel starts closed, so an error written into it is an error nobody
    // sees. "Routing server unreachable" and "Google basemap unavailable" are
    // both states where the app looks merely broken until the sentence
    // explaining it is on screen.
    if (isError) showRoutePanel();
    instructionMessage.textContent = message;
    // One class rather than the five Tailwind toggles this used to need. The
    // hint's normal and error colours are both stated in the stylesheet, so
    // there is no specificity race between a muted class and a red one.
    instructionText.classList.toggle('is-error', isError);
  }

  /**
   * The spinner beside the status line.
   *
   * Two things use it and both are network waits with no knowable length: the
   * campus data on the way in, and a route being computed by the server. The
   * text already says what is happening in both cases; what it cannot say is
   * that the app is still TRYING, which is the whole difference between a slow
   * connection and a dead one.
   *
   * Reference-counted rather than a boolean, because the two overlap on a cold
   * load: a route asked for before the overlays have landed would otherwise
   * have its spinner switched off by the overlays finishing. Every caller pairs
   * its `setBusy(true)` with a `setBusy(false)` in a `finally`, which is what
   * keeps the count honest across the error paths.
   */
  let busyDepth = 0;
  let stopBusy = null;

  function setBusy(on) {
    busyDepth = on ? busyDepth + 1 : Math.max(0, busyDepth - 1);
    const wanted = busyDepth > 0;
    if (wanted === Boolean(stopBusy)) return;
    if (wanted) {
      instructionBusy.classList.remove('hidden');
      stopBusy = spin(instructionBusy, { size: 'sm' });
    } else {
      stopBusy();
      stopBusy = null;
      instructionBusy.classList.add('hidden');
    }
  }

  /**
   * What the map is waiting for when it is waiting for nothing.
   *
   * A function rather than a constant because the virtual location changes the
   * answer: with a fix on the campus there is nowhere to set a start FROM, so
   * the press is a destination, and saying otherwise sends people looking for a
   * step that is not there.
   *
   * "Press and hold" rather than "click", and this line is now carrying the
   * whole discoverability of that gesture — see LONG_PRESS_MS. A hold is not a
   * thing anybody tries unprompted on a map they have not used before. Shared
   * with the end of the cold load, which is the other place this has to be
   * said: the hint is wrong until the network has landed, so it is written
   * again once it has.
   */
  const idleHint = () => (geolocation.fixture
    ? 'Press and hold on the map to set a destination.'
    : 'Press and hold on the map to set a start point.');

  function resetMap() {
    endNavigation();

    if (startMarker) startMarker.remove();
    if (endMarker) endMarker.remove();
    startPoint = null;
    endPoint = null;
    startMarker = null;
    endMarker = null;

    routeCoords = null;
    routeLine = null;
    cumulative = null;
    maneuvers = null;
    requestSeq++;

    if (map.getSource('calculated-route')) {
      map.getSource('calculated-route').setData(EMPTY);
    }
    map.getSource('route-legs')?.setData(EMPTY);

    clearSelection();

    // Reset UI. The search box is cleared too: leaving a destination showing
    // next to "Not set" is the kind of stale text people act on.
    pendingEnd = null;
    if (searchInput) {
      searchInput.value = '';
      searchClear.classList.add('hidden');
      closeResults();
    }
    setStatus(idleHint());
    startCoordText.textContent = "Not set";
    endCoordText.textContent = "Not set";
    setDistanceFeet(0);
    setNavButtonsEnabled(false);
  }

  clearBtn.addEventListener('click', resetMap);
  startNavBtn.addEventListener('click', () => startNavigation());
  simulateBtn.addEventListener('click', () => startNavigation({ simulate: true }));

  // -------------------------------------------------------------------------
  // Routing API
  // -------------------------------------------------------------------------

  /**
   * Ask the server for a route. The graph and the maneuver derivation both live
   * there now — this file never builds a PathFinder.
   */
  async function requestRoute(from, to) {
    const response = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (response.status === 404) return null;          // reachable, but no path
    if (!response.ok) throw new Error(`route request failed (${response.status})`);
    return response.json();
  }

  async function fetchNetwork() {
    const response = await fetch('/api/network');
    if (!response.ok) throw new Error(`network request failed (${response.status})`);
    return response.json();
  }

  /**
   * Every vertex the router will accept — my campus's and the surrounding streets'.
   *
   * A separate request from the network above because the two answer different
   * questions now. /api/network is what gets drawn, and that is my campus's linework
   * alone: the streets around the campus are already painted by whichever
   * provider is under us, and drawing ours over theirs is the doubled linework
   * at the campus edge. This is what gets *snapped to*, and it has to include
   * those streets or a click on the pavement outside lands on the far side of a
   * car park.
   */
  async function fetchVertices() {
    const response = await fetch('/api/vertices');
    if (!response.ok) throw new Error(`vertex request failed (${response.status})`);
    return response.json();
  }

  /** One of the draw-only overlays: buildings, basemap, amenities, places. */
  async function fetchOverlay(name) {
    const response = await fetch(`/api/${name}`);
    if (!response.ok) throw new Error(`${name} request failed (${response.status})`);
    return response.json();
  }

  // -------------------------------------------------------------------------
  // 3D buildings
  // -------------------------------------------------------------------------

  /**
   * Extrude the campus footprints traced out of my campus basemap SVG by
   * scripts/build-buildings.mjs. These replace the basemap's own `composite`
   * building tiles, which do not cover this campus in any useful detail.
   *
   * Heights are placeholders, not survey data — see the generator. `min_height`
   * is absent from every feature, so the base coalesces to 0.
   */
  function addBuildingsLayer() {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);

    // The theme toggle no longer rebuilds the style, so an existing layer has
    // to be recoloured in place rather than left on the old palette.
    if (map.getLayer('campus-buildings')) {
      map.setPaintProperty('campus-buildings', 'fill-extrusion-color', colors.building);
      return;
    }
    if (!campusBuildings) return; // still in flight; addNetworkLayers re-runs

    if (!map.getSource('campus-buildings')) {
      map.addSource('campus-buildings', { type: 'geojson', data: campusBuildings });
    }
    map.addLayer({
      id: 'campus-buildings',
      source: 'campus-buildings',
      type: 'fill-extrusion',
      slot: 'middle',
      // Extrusion is genuinely expensive to fill. Never draw it zoomed out.
      minzoom: 15,
      paint: {
        'fill-extrusion-color': colors.building,
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.85,
        // The same opt-out every other layer here carries, and this was the one
        // that missed it. Standard lights extrusions through its own model, and
        // under the night preset that drove an authored #2f3336 to roughly
        // #0c0d0d — the campus turned into pitch-black blocks the moment
        // navigation started, and stayed that way.
        //
        // Not the flat 1 the other layers use, though. They are ground planes
        // and want their colour rendered exactly as written; this one is the
        // only thing on the map that is genuinely three-dimensional, and at 1
        // every face renders identically and a building reads as a sticker.
        // 0.75 is where the night preset stops swallowing them while the roof
        // still sits visibly lighter than the walls.
        //
        // It is a compromise and it is named so the bench can question it: this
        // number is the app's answer to "can Standard light these", and the
        // lighting section of the debug menu exists to find out whether a
        // better answer is reachable from `setLights` instead. See
        // src/lighting.js.
        'fill-extrusion-emissive-strength': BUILDING_EMISSIVE,
      },
    }, 'route-casing');

    // A layer that did not exist a moment ago has the palette's emissive
    // strength on it, not the bench's. Nothing else re-runs after this.
    applyLighting();
  }

  /**
   * The layer's own emissive strength, and the bench's starting point.
   *
   * One number with one explanation, in the paint spec above where the
   * explanation belongs, read from two places rather than written in two.
   */
  const BUILDING_EMISSIVE = 0.75;

  /**
   * Push the lighting bench onto the map, or take it back off.
   *
   * Everything here is gated on the debug menu being OPEN. That is the rule the
   * back room is built on — with the menu shut the app is exactly the app — and
   * it matters more for this section than for the flags it sits above, because
   * these values are plausible. A route GUI switched off is obviously a debug
   * state; a campus at dusk just looks like a decision somebody made.
   *
   * Called from addNetworkLayers rather than only from the control, because
   * every path that rebuilds the basemap — a theme change, a provider swap, a
   * full setStyle — re-runs the builders and would otherwise put Standard's own
   * lighting back while the bench still showed the override.
   */
  function applyLighting() {
    if (!styleBuilt) return;

    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);
    const bench = debugOpen ? lightingBench : null;

    // The extrusions are navigation-only — see removeBuildingsLayer — and the
    // question this bench asks is entirely about the extrusions, so it is
    // allowed to stand them up outside a walk. `!navActive` on the way down is
    // what keeps that from reaching into a real one: during navigation they are
    // the app's, and switching the bench off must not take them.
    //
    // addBuildingsLayer ends by calling back here, which is how a layer created
    // during a walk gets the bench's emissive rather than the palette's. That
    // bounce terminates at one level: the `getLayer` guard below is false on
    // the way in and true on the way back, so the second pass paints and stops.
    if (bench?.buildings) {
      if (!map.getLayer('campus-buildings')) addBuildingsLayer();
    } else if (!navActive) {
      removeBuildingsLayer();
    }

    // The camera, and only when the bench actually moved it. applyLighting runs
    // on every builder pass, and an easeTo per pass is a map that drifts while
    // you are trying to look at it. Never during navigation, which is pitched
    // to 60 and following somebody — that camera is not the bench's to take.
    const tilt = Boolean(bench?.tilt);
    if (!navActive && tilt !== benchTilt) {
      benchTilt = tilt;
      map.easeTo({ pitch: tilt ? 60 : 0, duration: 500 });
    }

    // Ours, and present under every provider, so this half runs even when there
    // is no Standard style underneath to configure.
    if (map.getLayer('campus-buildings')) {
      map.setPaintProperty(
        'campus-buildings',
        'fill-extrusion-emissive-strength',
        bench ? bench.emissive : BUILDING_EMISSIVE,
      );
    }

    // Google's ground is a raster under a blank style: no `basemap` import to
    // name, no lights to override. `lightPreset: null` is how palette.js says
    // so. Skipped outright rather than left to setConfig's warning, because a
    // bench pointed at a style that has no lighting should be quiet, not noisy.
    if (colors.lightPreset === null) return;

    setConfig('lightPreset', bench && bench.preset !== 'auto' ? bench.preset : colors.lightPreset);
    // `default` is Standard's own default and the value the app runs at — the
    // app never sets this key, so `auto` means putting it back rather than
    // leaving it alone.
    setConfig('theme', bench && bench.theme !== 'auto' ? bench.theme : 'default');

    if (!benchLights) return;
    if (!bench?.lights) {
      // A clone every time, not the captured array: setLights takes ownership
      // of what it is handed, and giving away the only copy of Standard's own
      // lighting means the next revert has nothing to revert to.
      map.setLights(structuredClone(benchLights));
      return;
    }
    const lights = structuredClone(benchLights);
    for (const light of lights) {
      // Standard writes both intensities as expressions over `lightPreset` and
      // `theme` — that is the whole reason this override exists, since a preset
      // is not separable from the number it implies. Replacing one property
      // with a literal collapses that expression for the light being questioned
      // and leaves its colour and direction still following the preset, which
      // is the comparison worth seeing.
      if (light.id === 'ambient') {
        // Colour as well as intensity, and the colour is the one that matters:
        // Standard's night ambient is hsl(217,100%,11%), so scaling it by any
        // intensity leaves it black and the extrusions stay swallowed. Measured
        // — ambient 0.5 to 1.0 at night moves a roof by about 1 L*.
        light.properties = {
          ...light.properties,
          intensity: bench.ambient,
          color: bench.ambientColor,
        };
      }
      if (light.id === 'directional') {
        light.properties = { ...light.properties, intensity: bench.directional };
      }
    }
    map.setLights(lights);
  }

  /**
   * Extrusion is for navigation only.
   *
   * Everywhere else in this file the layer is guarded by `navActive`, but
   * nothing ever took it down again — so ending a walk left the footprints
   * standing, which on the dark theme is a campus full of black blocks over a
   * map that is supposed to be flat.
   */
  function removeBuildingsLayer() {
    if (map.getLayer('campus-buildings')) map.removeLayer('campus-buildings');
  }

  // -------------------------------------------------------------------------
  // Campus overlay
  //
  // Ground cover, amenity symbols and place labels, all traced out of the same
  // my campus basemap as the buildings. Each of these is written to be safe to call
  // repeatedly: they recolour an existing layer rather than rebuilding it, so a
  // theme switch — which no longer reloads the style — updates in place.
  // -------------------------------------------------------------------------

  // Metres of ground per pixel is 156543.03 * cos(latitude) / 2^zoom, and at
  // my campus's 38.65 degrees that constant is 122275. Dividing a width in metres by
  // it, against an exponential-base-2 zoom curve, holds a line at its true
  // ground width instead of a fixed pixel width — so the 26 m entry road stays
  // visibly wider than the 3.3 m footpaths at every zoom.
  const M_PER_PIXEL_AT_Z0 = 122275;

  /**
   * How wide a line off the printed sheet is drawn, in metres, before zoom.
   *
   * Everything takes the width my campus drew it at — except the bleachers, and that
   * exception is what turns a stadium into a stadium.
   *
   * my campus's sheet draws seating as 24 hairlines 0.78 m wide: the tier lines of a
   * technical drawing, not the mass of a stand. Apple draws the same thing as a
   * solid bowl wrapping the pitch, and there is no bowl in this data to colour
   * — the features are LineStrings, so they cannot even enter the fill layer.
   * Widening them to a stand's real depth is the honest way to get from one to
   * the other: it is the same geometry my campus published, drawn at the size the
   * thing actually is rather than at the size a draughtsman's line is.
   */
  const SHEET_WIDTH = [
    'case',
    ['==', ['get', 'kind'], 'bleachers'], 7,
    ['coalesce', ['get', 'width'], 1.65],
  ];

  const groundWidth = (floor) => [
    'interpolate', ['exponential', 2], ['zoom'],
    // The floor keeps the thinnest paths from disappearing when zoomed out,
    // where true width would put them below a pixel.
    14, ['max', floor, ['*', SHEET_WIDTH, 2 ** 14 / M_PER_PIXEL_AT_Z0]],
    20, ['max', floor, ['*', SHEET_WIDTH, 2 ** 20 / M_PER_PIXEL_AT_Z0]],
  ];

  /**
   * Colour for one of the printed sheet's classes, falling back to the colour
   * my campus drew it in. `land` covers ground; anything else — a court marking, a bus
   * sign, the HOME BASE badges — keeps its own paint, which is what makes the
   * overlay still read as their map rather than a recolour of it.
   */
  const sheetPaint = (land, property, overrides = {}) => [
    'match',
    ['get', 'kind'],
    ...Object.entries({ ...land, ...overrides }).flat(),
    ['coalesce', ['get', property], 'transparent'],
  ];

  /**
   * my campus's printed campus map, drawn element for element.
   *
   * Two layers over one source, because the sheet mixes areas with stroked line
   * work and Mapbox will not do both in one: the fill layer takes everything
   * with a fill, the line layer everything with a stroke, and a shape with both
   * appears in each.
   *
   * The sort keys are load-bearing. A flat vector map is a painter's algorithm —
   * bay striping over tarmac, trees over lawn — and `i` is the element's index
   * in the original document. Without them Mapbox is free to reorder within a
   * layer and the campus renders inside out.
   */
  function addBasemapLayers() {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);
    const { land } = colors;

    // Over imagery there is nothing to add — see SATELLITE.land.
    if (!land) {
      for (const id of ['campus-rake', 'campus-sheet-line', 'campus-sheet-fill']) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      return;
    }

    // One kind is painted as something other than what it is called, and it is
    // the sheet's own naming that is off rather than ours: `closed` takes the
    // BUILDING grey rather than the one the land table holds for it. The two
    // are near-neighbours in every look but not the same — in the classic light
    // table it is a neutral #e4e4e4 against the buildings' warm #e8e0cd — and a
    // closed building should sit in the row of buildings it belongs to,
    // differing by the red over it and by nothing else.
    //
    // `lawn` used to be a second such override, painted in the campus GROUND
    // colour, and that is now reversed. The argument for it was that layer 2 is
    // four shapes totalling 519,000 m2 which the build script itself calls
    // "open ground" — a base plate rather than planting, being whatever is left
    // once the buildings, lots, paths and canopies are subtracted — so filling
    // the residual with grass made the campus a park with some blocks in it.
    //
    // The argument was sound and the reference it was measured against was the
    // wrong one. Apple would not paint a college green; my campus did, and my campus's
    // sheet is what this map is a translation of. Counted over the campus body
    // of the printed map, 39.3% of it is green — 24.4% open lawn at L 79 C 45,
    // 9.5% tree canopy at L 47 C 37 — and the greenest thing about it is
    // exactly that base plate. Restoring it lands us at 41.9% by day and 40.4%
    // at night against their 39.3%, from each look's own measured values rather
    // than from the print's ink.
    //
    // What the earlier note was right about survives: `land.lawn` is also the
    // value the surrounding parkland is matched against, so the boundary
    // between our sheet and the provider's greenspace agrees. See the seam
    // test. The campus now runs into that parkland instead of sitting on it,
    // which is a fair description of this campus.
    const fillColour = sheetPaint(land, 'fill', { closed: land.building });
    // Strokes that are ground read as ground; the rest keep my campus's ink. Building
    // outlines follow the theme so they agree with the footprints drawn on top.
    const lineColour = sheetPaint(
      { walkway: land.walkway, driveway: land.driveway, offsite_road: land.offsite_road, crossing: land.crossing },
      'stroke',
      // The stands take the bleacher FILL rather than a building outline. They
      // are drawn seven metres wide now — see SHEET_WIDTH — so they are a mass
      // on the map rather than an edge, and an edge colour on a mass reads as a
      // block of outline. Everything else keeps the pairing it had.
      // A court's outline takes the court's own fill, which is to say it stops
      // being an outline. The reference draws no line between a court and its
      // surround at all — a cross-section through the twelve is 23 px of
      // surface, a gap of apron, 23 px of surface, with no edge anywhere — and
      // my campus's sheet carries these as stroke-only shapes in `#fff`, so left
      // alone they came out as twelve white rectangles on bare ground.
      {
        building: colors.buildingLine,
        bleachers: land.bleachers,
        sport: colors.sportLine,
        tennis: land.tennis,
        tennis_apron: land.tennis_apron,
      },
    );

    if (map.getLayer('campus-sheet-fill')) {
      map.setPaintProperty('campus-sheet-fill', 'fill-color', fillColour);
      map.setPaintProperty('campus-sheet-line', 'line-color', lineColour);
      map.setPaintProperty('campus-rake', 'line-color', land.parking_stripe);
      return;
    }
    if (!campusBasemap) return; // still in flight; addNetworkLayers re-runs

    if (!map.getSource('campus-sheet')) {
      map.addSource('campus-sheet', { type: 'geojson', data: campusBasemap });
    }
    // The bay dividers, as lines rather than as the 0.99 m bars they are drawn.
    // Its own source because it is its own geometry — see src/bay-rake.js.
    if (!map.getSource('campus-rake')) {
      map.addSource('campus-rake', { type: 'geojson', data: bayRake(campusBasemap) });
    }

    // `hidden` marks the parts the app supplies itself — the label plates and
    // the letterform-free label layer — so drawing them would double up on the
    // real text in src/labels.json.
    //
    // The kinds below are hidden for the same reason, one layer up: the sheet
    // draws its own pictogram for each of them and addAmenityLayer draws a
    // Google-style disc over the top, so 78% of those discs were landing within
    // 6 m of a printed icon — two icon languages stacked on one point.
    //
    // Safe because the coverage is exact. The sheet spends several paths per
    // symbol (84 elements for 14 phones), and collapsing them to positions gives
    // 14 phones, 6 defibrillators, 6 restrooms and 5 permit machines against
    // amenities.json's 14, 6, 6 and 10. Nothing is lost; the permit machines
    // gain five. `bus_stop` joined them when build-amenities.mjs learned to
    // collapse the sheet's 19 sign-plate elements into the 3 stops they draw.
    //
    // `parking_marker` and `bike_marker` joined last. They were the two layers
    // build-basemap.mjs could not name, and they were the black pictograms
    // still competing with our own discs: 15 bicycle-and-P signs and, in the
    // other, 8 P badges, 10 permit machines, a motorcycle bay and 2 drop-off
    // symbols. Every one of those is now an amenity point drawn as a disc, so
    // the printed artwork is redundant rather than complementary.
    //
    // One caveat, and it is the only thing lost here: my campus's two Student
    // Drop-Off symbols are painted on the kerb, while the disc that replaces
    // them sits on the routing node my campus binds that destination to, 21 m and
    // 30 m away. The symbol moves; it does not disappear.
    const REDRAWN = [
      'emergency_phone', 'defibrillator', 'restroom', 'permit_machine', 'bus_stop',
      'parking_marker', 'bike_marker',
    ];
    const visible = [
      'all',
      ['!', ['to-boolean', ['get', 'hidden']]],
      ['match', ['get', 'kind'], REDRAWN, false, true],
    ];
    // The closed block keeps its FILL here and loses its stroke: it is a
    // building, so it needs the same solid grey every other building has under
    // it, and addClosedLayers puts the red wash, the hatch and the outline on
    // top of that. Drawn on nothing but ground it read as a tinted patch of
    // lawn — which is exactly what it is not.
    const visibleLines = ['all', visible, ['!=', ['get', 'kind'], CLOSED_KIND]];
    // Under the legend's outlines when they exist, and this is not optional.
    // The sheet arrives from the server, so on a cold load the highlight layers
    // are already standing when it lands; anchoring both to the network alone
    // put the later arrival on top, and my campus's opaque building fills painted out
    // every outline the legend drew. The sheet is ground and the outline
    // annotates the ground, so the order is fixed rather than incidental.
    const anchor = map.getLayer('highlight-fill') ? 'highlight-fill' : belowNetwork();

    map.addLayer({
      id: 'campus-sheet-fill',
      type: 'fill',
      source: 'campus-sheet',
      slot: 'middle',
      // Everything my campus gave a fill, PLUS the pitches — and the pitches are the
      // exception because my campus did not give them one.
      //
      // Only 2 of the sheet's 22 `sport` shapes carry a fill: the stadium's
      // track and one other. The remaining 19 are polygons drawn as white
      // touchlines over the lawn, which is how a printed sheet says "pitch"
      // and how a vector map says nothing at all — they never entered this
      // layer, so the soccer, baseball, softball and tennis grounds were lawn
      // with an outline on top while the one filled shape sat there in pitch
      // green looking like the odd one out.
      //
      // The geometry is already the right shape. It only needed to be allowed
      // in, and `sheetPaint` has had a colour waiting for it the whole time.
      // ...and the twelve courts arrive the same way and need the same
      // exception: stroke-only shapes that have to be let in as surfaces.
      // ...minus the bay dividers, which are drawn by campus-rake below as
      // lines. Left in here as well they would be the same 1,004 bars twice
      // over, and the fill is the copy that cannot be seen at most zooms.
      filter: ['all', visible,
        ['!=', ['get', 'kind'], 'parking_stripe'],
        ['any', ['has', 'fill'], ['in', ['get', 'kind'], ['literal', ['sport', 'tennis', 'tennis_apron']]]]],
      layout: { 'fill-sort-key': ['get', 'i'] },
      paint: {
        'fill-color': fillColour,
        'fill-opacity': ['coalesce', ['get', 'opacity'], 1],
        // Same reasoning as the mask: Standard would otherwise light these
        // through its own model, and the night preset swallows them.
        'fill-emissive-strength': 1,
      },
    }, anchor);

    map.addLayer({
      id: 'campus-sheet-line',
      type: 'line',
      source: 'campus-sheet',
      slot: 'middle',
      filter: ['all', visibleLines, ['has', 'stroke']],
      layout: { 'line-sort-key': ['get', 'i'], 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': lineColour,
        'line-width': groundWidth(0.4),
        'line-opacity': ['coalesce', ['get', 'opacity'], 1],
        'line-emissive-strength': 1,
      },
    }, anchor);

    // The rake.
    //
    // Butt caps, not the round ones the sheet's other strokes take: a divider
    // is a painted bar with a square end, and a round cap would add half its
    // own width at each end — half a metre of overhang on a 7.9 m bar, which is
    // the difference between a bay and a bay with feet.
    //
    // The 1.2 px floor is the whole point of the layer. Below it a divider is
    // sub-pixel and Mapbox can only render it as a fraction of a pixel's worth
    // of coverage, which is what turned a rank of them into a moire; at 1.2 it
    // is a line. Above about z18.5 the true 0.99 m is wider than the floor and
    // the floor stops applying, so from there on this draws exactly the bar my campus
    // drew, in exactly the place they drew it.
    map.addLayer({
      id: 'campus-rake',
      type: 'line',
      source: 'campus-rake',
      slot: 'middle',
      layout: { 'line-sort-key': ['get', 'i'], 'line-cap': 'butt' },
      paint: {
        'line-color': land.parking_stripe,
        'line-width': groundWidth(1.2),
        'line-emissive-strength': 1,
      },
    }, anchor);
  }

  // -------------------------------------------------------------------------
  // The closed building
  //
  // One shape on the sheet carries `kind: "closed"` — the fenced-off block in
  // the middle of the campus — and one label reads "Closed" over the top of it.
  // my campus prints both in the same grey as everything else, which makes the one
  // place on this map you cannot go look exactly like the places you can.
  //
  // So it keeps the grey every other building has and gains a red wash and a
  // hard red outline over it, with the word itself in red once you are close
  // enough for the word to be worth reading.
  //
  // Three passes, and it was four: a diagonal hatch sat over the wash. It went
  // because a texture on a map whose every other shape is flat colour was the
  // loudest thing on the campus, and it was shouting on behalf of one small
  // block. It did not scale either — `fill-pattern` tiles in SCREEN space, so
  // zooming out packed the stripes tighter until they were a solid red smear
  // where a quiet tint belonged.
  // -------------------------------------------------------------------------

  const CLOSED_KIND = 'closed';
  const CLOSED_TEXT = 'Closed';

  /**
   * One red for the marks, two for the word.
   *
   * The wash, hatch and outline are the same hue at three opacities, so the
   * shape reads as one object rather than three annotations that happen to
   * agree. The text cannot join them: it is the only part that has to stay
   * legible as TYPE, so it takes the ramp's dark end on light ground and its
   * light end on dark, the way pinInk does for a marker's name.
   */
  const CLOSED_RED = '#ea4335';
  const CLOSED_INK = { light: '#c5221f', dark: '#f28b82' };

  /**
   * Which way the closed block actually lies, in degrees clockwise from east.
   *
   * my campus drew it on the diagonal and the word over it was setting horizontally,
   * so the label crossed two of its edges and sat half on the tarmac outside.
   * Measured off the geometry rather than typed in as a number: the shape comes
   * from a generated artifact, and a rebuild that nudged it would leave a
   * hard-coded angle quietly wrong.
   *
   * The longest edge is the one that decides it — the block is a quadrilateral,
   * so its long side IS its grain — and longitude is scaled by cos(latitude)
   * first, without which the angle is off by the map's own aspect.
   */
  function closedBearing(basemap) {
    const shape = basemap?.features?.find((f) => f.properties.kind === CLOSED_KIND);
    const ring = shape?.geometry?.coordinates?.[0];
    if (!ring || ring.length < 3) return 0;

    const scale = Math.cos((ring[0][1] * Math.PI) / 180);
    let best = { length: -1, angle: 0 };
    for (let i = 0; i < ring.length - 1; i += 1) {
      const dx = (ring[i + 1][0] - ring[i][0]) * scale;
      const dy = ring[i + 1][1] - ring[i][1];
      const length = Math.hypot(dx, dy);
      if (length <= best.length) continue;
      // Normalised to the half-turn that reads left-to-right, so the word is
      // never upside down whichever way round the ring was wound.
      const east = dx >= 0 ? [dx, dy] : [-dx, -dy];
      best = { length, angle: -(Math.atan2(east[1], east[0]) * 180) / Math.PI };
    }
    return best.angle;
  }

  /**
   * The wash, the hatch and the outline. The word is a label layer — it lives
   * with the other labels in buildLabelLayers, above the pins rather than under
   * them.
   *
   * Rebuilt on every style swap and recoloured in place on a theme change, the
   * same shape as every other builder here.
   */
  function addClosedLayers() {
    if (!palette(currentProvider, currentBasemap, currentTheme, currentSkin).land) {
      // Over imagery the sheet is not drawn at all, so neither is this.
      for (const id of ['campus-closed-line', 'campus-closed-fill']) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      return;
    }
    // Nothing here is theme-dependent — one red in both looks, because a
    // closure is not a mood — so an existing set needs no repaint.
    if (map.getLayer('campus-closed-fill')) return;
    if (!campusBasemap || !map.getSource('campus-sheet')) return;

    const only = ['==', ['get', 'kind'], CLOSED_KIND];
    // The wash is ground and sits with the ground: under the paths, and under
    // the legend's outlines when they are up. The outline does not — see
    // belowRoute, and note the two anchors are deliberately different.
    const anchor = map.getLayer('highlight-fill') ? 'highlight-fill' : belowNetwork();

    map.addLayer({
      id: 'campus-closed-fill',
      type: 'fill',
      source: 'campus-sheet',
      slot: 'middle',
      filter: only,
      paint: {
        'fill-color': CLOSED_RED,
        // A wash over the building grey, not a colour of its own. There was a
        // hatch on top of this and it is gone: on a map whose every other shape
        // is flat colour, a texture was the loudest thing on the campus, and it
        // was shouting on behalf of one small block. Wash and outline say the
        // same thing quietly, and they scale — a hatch is a fixed pixel grid, so
        // zooming out packed it into a solid red smear.
        'fill-opacity': 0.1,
        'fill-emissive-strength': 1,
      },
    }, anchor);

    map.addLayer({
      id: 'campus-closed-line',
      type: 'line',
      source: 'campus-sheet',
      slot: 'middle',
      filter: only,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': CLOSED_RED,
        // Barely over the sheet's own 0.4. It was 1.4 and reading as a warning
        // band: this shape is the only red on an otherwise grey-and-mint
        // campus, so it does not need weight to be found — being red is already
        // the whole of the emphasis, and the width was spending it twice.
        'line-width': groundWidth(0.6),
        // Washed rather than solid, for the same reason. Held above the paths
        // it crosses (see belowRoute) so the boundary still reads as continuous
        // — that is what the layer is FOR — but at an opacity where it sits in
        // the sheet rather than on top of it.
        'line-opacity': 0.45,
        'line-emissive-strength': 1,
      },
    }, belowRoute());
  }

  // -------------------------------------------------------------------------
  // Legend highlight
  //
  // The shapes one legend row is asking about: an outline over every building
  // and car park that holds the thing, and a ring on each one that stands in
  // the open. src/highlight.js does the join; this draws the answer.
  // -------------------------------------------------------------------------

  /** Everything the legend can outline. Empty until the overlays land. */
  let legendAreas = [];
  /** category id -> { indices, points, counts }, computed once per load. */
  const legendHighlights = new Map();
  /** The pressed category's outline, and the row the pointer is over. */
  let stickyRow = null;
  let hoverRow = null;
  /** False until a file a category can be collected from has landed. */
  let legendReady = false;

  /**
   * Which row the outline belongs to — and a hover is no longer one of them.
   *
   * Hovering used to outline whatever it pointed at. It does not any more: a
   * hover now previews the row's PINS, which arrive over a cleared campus (see
   * previewLegendRow). Tinting ground purple underneath them said two things
   * about one question, and the outline was the half nobody had asked for —
   * "where are the defibrillators" is answered by six discs, not by shading the
   * buildings they hang in.
   *
   * Parking is not the exception it looks like it should be. It is the one row
   * that names a class of the printed sheet, so it is the one row whose ground
   * IS an answer — but its pins say the same thing better, because a lot you
   * can read the name of beats a lot you can only see the shape of, and the
   * permit machines have no shape on the sheet at all. Its outline survives on
   * the PRESS, where there is room for context under a committed answer.
   *
   * So a hover takes the outline off rather than replacing it, which is what
   * keeps the two answers off the map at the same time. Still undoable, which
   * is why there were two variables to begin with: a hover never writes
   * stickyRow, so leaving the row hands the outline straight back to the
   * selection without the selection ever having been touched.
   *
   * Pointing at the row that is ALREADY selected is not a preview, though —
   * there is nothing for it to preview that is not on screen — so that case
   * keeps the outline rather than suppressing it. Without the second half of
   * this test, pressing a row would hide its own outline until the pointer
   * happened to leave, which reads as the press having half-failed.
   */
  const shownRow = () => (hoverRow && hoverRow !== stickyRow ? null : stickyRow);

  function paintHighlight() {
    const shown = shownRow();
    const highlight = shown ? legendHighlights.get(shown) : null;

    map.getSource('highlight-areas')?.setData(
      highlight ? areaCollection(legendAreas, highlight.indices) : EMPTY,
    );
    map.getSource('highlight-points')?.setData(
      highlight ? pointCollection(highlight.points) : EMPTY,
    );
  }

  /**
   * Three layers over two sources, added together and taken down never.
   *
   * They sit between the printed sheet and the road ribbon, which is where a
   * ground annotation belongs: over my campus's own tarmac and lawn, under the white
   * paths and under the route, so lighting up every car park on campus cannot
   * bury the directions someone is following. Insertion order does it — the
   * network layers are added after this in addNetworkLayers, and within a slot
   * Mapbox honours the order it was given.
   */
  function addHighlightLayers() {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);

    if (map.getLayer('highlight-fill')) {
      for (const [id, property] of [
        ['highlight-fill', 'fill-color'],
        ['highlight-line', 'line-color'],
        ['highlight-points', 'circle-color'],
        ['highlight-points', 'circle-stroke-color'],
      ]) {
        map.setPaintProperty(id, property, colors.highlight);
      }
      return;
    }

    if (!map.getSource('highlight-areas')) {
      map.addSource('highlight-areas', { type: 'geojson', data: EMPTY });
    }
    if (!map.getSource('highlight-points')) {
      map.addSource('highlight-points', { type: 'geojson', data: EMPTY });
    }

    map.addLayer({
      id: 'highlight-fill',
      type: 'fill',
      source: 'highlight-areas',
      slot: 'middle',
      paint: {
        'fill-color': colors.highlight,
        // A car park is fifty times the area of a building and the same wash
        // over both reads as two different strengths of answer. Weaker on the
        // large shape is what makes them look like one highlight.
        'fill-opacity': ['match', ['get', 'kind'], 'zone', 0.16, 0.26],
        'fill-emissive-strength': 1,
      },
    });
    map.addLayer({
      id: 'highlight-line',
      type: 'line',
      source: 'highlight-areas',
      slot: 'middle',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': colors.highlight,
        'line-width': 2.5,
        'line-emissive-strength': 1,
      },
    });
    // The ones with no shape to outline: the bike racks bolted to a path, the
    // three bus stops out on the perimeter. A ring on the ground under the pin
    // that is already there, rather than a second pin competing with it.
    map.addLayer({
      id: 'highlight-points',
      type: 'circle',
      source: 'highlight-points',
      slot: 'middle',
      paint: {
        'circle-color': colors.highlight,
        'circle-opacity': 0.3,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4, 19, 12],
        'circle-stroke-color': colors.highlight,
        'circle-stroke-width': 2,
        'circle-emissive-strength': 1,
      },
    });

    // A style swap drops the layers with a row still selected, so what the
    // legend thinks is showing has to be pushed back at the new ones.
    paintHighlight();
  }

  /**
   * A `match` from a feature's kind to the ink its name is set in.
   *
   * Apple tints a POI's label with the marker's own hue rather than the map's
   * text colour, which is what lets a field of markers be read by colour before
   * a single word of it has been. Built as an expression rather than one flat
   * paint value because a symbol layer has one `text-color` and this map draws
   * eight categories through it.
   */
  const amenityHalo = () => palette(currentProvider, currentBasemap, currentTheme, currentSkin).labelHalo;
  /** The ring the markers are drawn with, for the callers that have no `colors`. */
  const pinRing = () => palette(currentProvider, currentBasemap, currentTheme, currentSkin).pinRing;

  const inkFor = (property) => {
    // Over imagery a tint has nothing fixed to sit against — foliage, tarmac
    // and pale roofs are all in one frame — so the names go back to the single
    // high-contrast colour that reads over all of it. Apple's satellite mode
    // drops the category tint for exactly the same reason.
    if (currentBasemap === 'satellite') return SATELLITE.label;
    return [
      'match',
      ['get', property],
      ...AMENITY_KINDS.flatMap((kind) => [kind, pinInk(kind, currentTheme)]),
      pinInk('campus', currentTheme),
    ];
  };

  /**
   * Amenity pictograms and the names under them.
   *
   * The disc itself is not theme-dependent — it carries its own colour and a
   * white rim so it reads on lawn, paving and imagery alike — but the label is,
   * because a third-lightness hue on a near-black ground is a smudge.
   *
   * The layer is added inside the promise because setStyle drops registered
   * images along with the layers, so the icons have to be re-registered before
   * anything can reference them.
   */
  function addAmenityLayer() {
    if (map.getLayer('campus-amenities')) {
      map.setPaintProperty('campus-amenities', 'text-color', inkFor('kind'));
      map.setPaintProperty('campus-amenities', 'text-halo-color', amenityHalo());
      // The discs are rasterised images, so a theme change cannot repaint them
      // — they have to be drawn again. Under Standard a theme change is a
      // config change rather than a setStyle, so nothing else clears them; the
      // loader compares the ring it was last given and re-rasterises only when
      // it has actually moved.
      loadAmenityIcons(map, pinRing());
      return;
    }
    if (!campusAmenities) return;

    if (!map.getSource('campus-amenities')) {
      // `generateId` is what makes one pin addressable. amenities.json carries
      // no identifier of its own — six features all say `defibrillator` — so
      // without this there is no filter that can hide the one that was tapped
      // and leave the other five standing.
      map.addSource('campus-amenities', {
        type: 'geojson',
        data: campusAmenities,
        generateId: true,
      });
    }
    loadAmenityIcons(map, pinRing()).then(() => {
      // A style swap can land between the two, taking the source with it.
      if (map.getLayer('campus-amenities') || !map.getSource('campus-amenities')) return;
      map.addLayer({
        id: 'campus-amenities',
        type: 'symbol',
        source: 'campus-amenities',
        slot: 'middle',
        // Below this the campus is a few hundred pixels across and 72 markers
        // is noise rather than information.
        minzoom: 16,
        layout: {
          'icon-image': ['get', 'kind'],
          // 0.54 to 0.65 of a 26-unit disc puts it at 14 to 17 px across, which
          // is the range Apple's own resting markers occupy. The stops live in
          // pin-select.js because a selected pin has to start its animation at
          // whatever size this is drawing right now.
          'icon-size': sizeExpr(AMBIENT_SIZE),
          // Centred, not bottom-anchored. The resting marker has no tail — it
          // is a disc sitting ON the place rather than a balloon pointing down
          // at one, so its middle is what goes on the coordinate.
          'icon-anchor': 'center',
          'icon-padding': 2,
          // The name goes underneath, which is the Apple arrangement and the
          // reason `text-anchor` is top: the anchor point is the coordinate, so
          // the offset has to clear the disc's own lower half.
          //
          // `name`, not `label`: only an amenity whose name identifies it gets
          // one printed, which is four of the eighty-four. The rest are the
          // icon's own meaning set in type — see withAmenityNames in poi.js.
          // Held to 17 on top of that, because even a real name is not worth
          // reading when the whole campus is on screen.
          'text-field': ['step', ['zoom'], '', 17, ['coalesce', ['get', 'name'], '']],
          'text-font': mapFont().medium,
          'text-size': 13,
          // Below, then above, then right, then left — see the same four on
          // category-pins for what the anchor names mean, which is not what
          // they sound like.
          'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
          'text-radial-offset': 0.85,
          'text-justify': 'auto',
          // Shared with the lifted marker's DOM label, so a name wraps on the
          // same words in both states — see LABEL_MAX_EM in pin-select.js.
          'text-max-width': LABEL_MAX_EM,
          // Never at the cost of the marker. 84 of these sit on one campus and
          // a good half of the names would collide at any useful zoom; the disc
          // is the information and the word is the elaboration.
          'text-optional': true,
        },
        paint: {
          'icon-emissive-strength': 1,
          'text-color': inkFor('kind'),
          'text-halo-color': amenityHalo(),
          'text-halo-width': 1.4,
          'text-emissive-strength': 1,
        },
      });
      // A style swap rebuilds this layer unfiltered, and the HTML marker of a
      // pin that was lifted before the swap survives it — so without this the
      // selected pin comes back small underneath its own enlarged self.
      paintCategory();
    }).catch((error) => console.error('amenity icons unavailable:', error));
  }

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

  // categoryPanel is declared up with the route panel — campusPadding measures it.
  const categoryTitle = document.getElementById('category-title');
  const categoryCount = document.getElementById('category-count');
  const categoryList = document.getElementById('category-list');
  const categoryClose = document.getElementById('category-close');

  /** The selected category's id, or null when the map is showing everything. */
  let activeCategory = null;
  let categoryHits = [];

  /**
   * The hovered row's category, which the map draws in place of the selection
   * for exactly as long as the pointer is on the row.
   *
   * Separate from activeCategory for the same reason hoverRow is separate from
   * stickyRow: a preview has to be undoable. Hovering never writes the
   * selection, so leaving the row puts back the pressed category's pins — or
   * the whole campus, if nothing was pressed.
   */
  let hoverCategory = null;
  let hoverHits = [];

  /**
   * What the pin layer is actually drawing, which is the preview if there is
   * one and the selection otherwise.
   *
   * Every read that is about WHAT IS ON THE MAP goes through these; the reads
   * that are about what the user has committed to — the results list, the
   * camera, which row shows as pressed — keep reading activeCategory directly.
   * That split is the whole difference between a preview and a selection.
   */
  const shownCategory = () => hoverCategory ?? activeCategory;
  const shownHits = () => (hoverCategory ? hoverHits : categoryHits);

  /**
   * Pins for `match` categories.
   *
   * Its own source rather than appending to amenities.json, because these are
   * directory rows, not legend symbols: they carry a real name ("Myrtle Parking
   * Lot East") and only exist while their chip is pressed. Keeping them apart
   * means clearing a category is a setData(EMPTY), not a filter on a mixed set.
   */
  function addCategoryLayer() {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);

    if (map.getLayer('category-pins')) {
      // Same shape as the other builders: a theme change re-runs this to
      // recolour what is already there rather than rebuilding it.
      map.setPaintProperty('category-pins', 'text-color', inkFor('icon'));
      map.setPaintProperty('category-pins', 'text-halo-color', colors.labelHalo);
      return;
    }
    if (!map.getSource('category-pins')) {
      map.addSource('category-pins', { type: 'geojson', data: EMPTY, generateId: true });
    }

    // Shares the amenity loader: the four discs these need are registered in
    // map-images.js alongside the legend's own, so there is one icon family and
    // one place it is rasterised.
    loadAmenityIcons(map, colors.pinRing).then(() => {
      if (map.getLayer('category-pins') || !map.getSource('category-pins')) return;
      map.addLayer({
        id: 'category-pins',
        type: 'symbol',
        source: 'category-pins',
        slot: 'middle',
        layout: {
          'icon-image': ['get', 'icon'],
          // Larger than the ambient pictograms. These are what the user just
          // asked to see, and at the zoom the whole campus fits in, the ambient
          // size renders them as specks against my campus's own printed symbols.
          // Google does the same thing: a search result is a bigger pin than
          // the POIs it lands among.
          'icon-size': sizeExpr(CATEGORY_SIZE),
          // Centred like the ambient discs: no tail, so the middle is the mark.
          'icon-anchor': 'center',
          // A category is a deliberate request to see all of them, so the pins
          // never drop out to a collision the way the ambient pictograms do.
          // Their names still do: `text-optional` keeps the pin when its label
          // will not fit, which is the only sane answer for the eight HomeBases
          // — my campus puts all of them inside the LRC, so with overlap allowed the
          // eight names print on top of each other.
          'icon-allow-overlap': true,
          'text-optional': true,
          'text-field': ['get', 'name'],
          'text-font': mapFont().medium,
          'text-size': 14,
          // Under the disc if the name fits there, and if it does not, above,
          // then right, then left. It used to be under or nowhere, and "nowhere"
          // is what a caption does when it loses a collision — so a row of pins
          // in a car park drew six discs and one word between them.
          //
          // READ THESE BACKWARDS. An anchor names the edge of the LABEL that is
          // pinned to the point, not the side of the point the label lands on:
          // 'top' fastens the label's top edge to the coordinate and so hangs it
          // BELOW, 'left' fastens its left edge and so puts it to the RIGHT.
          // This list is the order asked for — below, above, right, left —
          // written in those terms.
          'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
          // Replaces text-offset, which a variable anchor would apply in one
          // fixed direction for all four positions: the same [0, 0.95] that
          // clears the disc downwards would push the label above it a further
          // 0.95 em up, and the side ones down past its corner.
          // text-radial-offset is that distance along whichever direction the
          // anchor chose, so all four clear the disc by the same gap.
          'text-radial-offset': 0.95,
          // Follows the anchor: a label to the left of a pin ends flush against
          // it rather than centred on a point it is no longer under.
          'text-justify': 'auto',
          'text-max-width': LABEL_MAX_EM,
        },
        paint: {
          // Tinted with the disc's own hue rather than set in the map's ink.
          'text-color': inkFor('icon'),
          'text-halo-color': colors.labelHalo,
          'text-halo-width': 1.6,
          'icon-emissive-strength': 1,
          'text-emissive-strength': 1,
          // The entrance drives this. Anchored to the VIEWPORT because the sway
          // is a screen-space settle measured in screen pixels — left the
          // default and it would be bearing-relative, so the same animation
          // would swing along some compass direction on a rotated map.
          'icon-translate': [0, 0],
          'icon-translate-anchor': 'viewport',
        },
      });
      // A style swap can land between selecting a category and this resolving.
      paintCategory();
    }).catch((error) => console.error('category icons unavailable:', error));
  }

  /**
   * Push the current selection at the map: the filter and the pins.
   *
   * Two things narrow these layers now and they have to be combined rather than
   * written in turn — a category that set its own filter would put back the pin
   * a selection had just taken out, and the selected one would be drawn twice,
   * once small underneath its own animation.
   */
  function paintCategory() {
    const active = Boolean(shownCategory());

    // The ambient pictograms go away entirely while a category is up, and the
    // category draws every one of its own pins instead. Two reasons that beats
    // narrowing the existing layer's filter: that layer is minzoom 16, so a
    // filtered selection was invisible at the zoom the campus actually fits at;
    // and the category's pins overlap-allow and carry names, which the ambient
    // ones deliberately do not.
    if (map.getLayer('campus-amenities')) {
      map.setFilter('campus-amenities', active ? ['boolean', false] : amenityFilter());
    }
    if (map.getLayer('category-pins')) {
      map.setFilter('category-pins', hiddenPin('category-pins'));
    }

    const source = map.getSource('category-pins');
    if (!source) return;
    source.setData(active ? {
      type: 'FeatureCollection',
      features: shownHits().map((hit) => ({
        type: 'Feature',
        properties: { icon: hit.icon, name: hit.name ?? '' },
        geometry: { type: 'Point', coordinates: hit.coords },
      })),
    } : EMPTY);

    // The printed label pins go with them — same rule, different layers. Here
    // rather than at the two call sites so a style swap, which rebuilds these
    // from scratch, restores the same state this did.
    paintLabels();
  }

  // -------------------------------------------------------------------------
  // Clearing the map for an answer
  //
  // Pressing a chip is a question, and the map answers it by emptying itself
  // first. Every pin on campus goes — the ambient pictograms and the 38 printed
  // labels that carry a disc, names included — and then the category's own pins
  // arrive on the lift's spring, so the thing you asked for is the only thing
  // moving. Swapping the two sets in one frame, which is what this used to do,
  // left the answer indistinguishable from the map it landed on: the restrooms
  // appeared among forty markers that had not changed.
  //
  // The two halves are animated by different means, and deliberately:
  //
  //   OUT is opacity alone, across eight or nine layers. Opacity is a paint
  //   property, so it costs a repaint and nothing else. Shrinking these would
  //   mean pushing `icon-size` — a LAYOUT property — at every one of them every
  //   frame, and re-laying out the whole printed label set to fade it is a bad
  //   trade for a 170 ms move nobody is looking at.
  //
  //   IN is the real thing: size, the sideways settle, and the names. It is one
  //   layer holding tens of features, which is what makes the per-frame layout
  //   affordable here and not there.
  // -------------------------------------------------------------------------

  /** How long the campus takes to clear. Short: it is the throat-clearing. */
  const PIN_FADE_MS = 170;

  /**
   * Where the arriving pins start, as a fraction of full size.
   *
   * The capture's own resting-to-settled ratio: Apple's marker is 23 px across
   * before it is picked up and 65.9 px after. Pins that come from nothing rather
   * than from a marker have no measured start of their own, so they borrow that
   * one and grow through the same proportional range the lift does.
   */
  const ENTRANCE_START = 0.349;

  /**
   * Bumped to cancel whatever is mid-flight.
   *
   * Legend rows are a column and people press down it. Without this the previous
   * run's next frame lands after the new one has set up — pins at the old
   * opacity, or an `icon-size` from a swap that is already over.
   *
   * A superseded run stops asking for frames and NEVER SETTLES its promise, so
   * the `playCategory*` that awaited it stays suspended for the life of the
   * page. That is deliberate and it is safe, but only for a reason worth
   * stating, because it is a reason a later edit can take away:
   *
   *   the suspended async frame holds the pending promise, the promise holds the
   *   frame's continuation, and — because BOTH call sites launch these
   *   fire-and-forget, awaiting nothing and storing nothing — no root holds
   *   either. An unreachable cycle is a thing a mark-and-sweep collector takes,
   *   so the pair goes at the next GC.
   *
   * `await playCategorySwap()` from anywhere reachable, or parking the returned
   * promise in a variable that outlives the run, roots the cycle and turns this
   * into one leaked frame per press. If a caller ever needs to know when the
   * pins have landed, give the cancelled path a settle — resolve it with a
   * `superseded` flag rather than dropping it on the floor — instead of rooting
   * the promise as it stands.
   */
  let choreography = 0;

  /**
   * True while the category pins are growing in.
   *
   * The entrance owns `icon-size` on that layer frame by frame, and the pin
   * hover writes the same property. Without this, a pointer resting where the
   * pins land would snap them to full size half way through their arrival. See
   * paintPinHover, which is the only reader.
   */
  let pinsArriving = false;

  /** Asked each time, so a preference changed mid-session takes effect at once. */
  const prefersStill = () =>
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  /** Every layer that draws a pin, which is what a chip press has to clear. */
  const pinLayers = () => ['campus-amenities', ...POI_LABEL_LAYERS]
    .filter((layer) => map.getLayer(layer));

  function setLayerFade(layers, value) {
    for (const layer of layers) {
      // A style swap can take these out from under a run in progress.
      if (!map.getLayer(layer)) continue;
      map.setPaintProperty(layer, 'icon-opacity', value);
      map.setPaintProperty(layer, 'text-opacity', value);
    }
  }

  /**
   * What a layer is drawn at right now, so a fade can start from there.
   *
   * Chips get pressed in quick succession and the run underway is cancelled
   * where it stands, which can be anywhere — pins at 0.4 through an entrance,
   * say. Fading from a hard 1 would snap them to full first and then take them
   * out, a flash in the one place this whole sequence exists to remove.
   */
  const fadeFrom = (layer) => {
    const value = map.getPaintProperty(layer, 'icon-opacity');
    return typeof value === 'number' ? value : 1;
  };

  /** Call `step(0..1)` once a frame for `ms`, unless something supersedes it. */
  function overFrames(ms, step) {
    const mine = choreography;
    return new Promise((resolve) => {
      const started = performance.now();
      const tick = (now) => {
        if (mine !== choreography) return;
        const p = Math.min((now - started) / ms, 1);
        step(p);
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  /**
   * The category's pins arriving, on the same curve a tapped pin is lifted on.
   *
   * `icon-size` stays a zoom expression the whole way rather than becoming a
   * plain number, because `frameCategory` is flying the camera over exactly
   * these frames — a fixed size would be drawn at the wrong scale the moment the
   * zoom moved under it. The growth is multiplied into the table's stops instead
   * of wrapped around the finished expression; see `scaleStops` for why that is
   * the only form Mapbox will accept.
   *
   * The sway rides `icon-translate`, which is paint and therefore does not enter
   * collision: the settle moves drawn pixels only, and the labels stay where
   * they were placed.
   *
   * A PIN AND ITS NAME COME UP TOGETHER, on one opacity ramp. They did not at
   * first — the names were held back until the growth was nearly over, on the
   * theory that fading them in over a still-changing `icon-size` would make them
   * flicker as the collision boxes resized. That theory was wrong twice. The
   * icons are `icon-allow-overlap`, so they are not in the collision index at
   * all and their size cannot dislodge a label; and the delay was not the 335 ms
   * it looked like on paper. Stacked on the 170 ms clear-out before it and
   * Mapbox's own 300 ms fade for a newly placed symbol after it, the names
   * landed nearly a second behind the discs — long enough to read as a second
   * event rather than as the same one, which is exactly the disorientation the
   * whole sequence is meant to prevent.
   *
   * Every pin swings together. There is no stagger here and it would be a lie if
   * there were: the capture is one marker, so a per-pin delay would be invented
   * rather than measured, and Mapbox cannot vary a layout property per feature
   * without pushing new data on every frame anyway.
   */
  async function playCategoryEntrance() {
    const layer = 'category-pins';
    if (!map.getLayer(layer)) return;

    const base = sizeExpr(CATEGORY_SIZE);
    /** How long the pins and their names take to become visible at all. */
    const APPEAR_MS = GROW_MS * 0.3;

    const settle = () => {
      pinsArriving = false;
      if (!map.getLayer(layer)) return;
      map.setLayoutProperty(layer, 'icon-size', base);
      map.setPaintProperty(layer, 'icon-translate', [0, 0]);
      map.setPaintProperty(layer, 'icon-opacity', 1);
      map.setPaintProperty(layer, 'text-opacity', 1);
      // ...and hand the layer back to the hover, in case the pointer has been
      // sitting where a pin has just landed. A no-op when nothing is hovered.
      paintPinHover(layer);
    };
    if (prefersStill()) { settle(); return; }
    pinsArriving = true;

    // Frame zero, set now rather than on the first callback. `paintCategory`
    // has already pushed the data, so a rAF's worth of delay is a rAF of pins
    // drawn full size — the pop the animation exists to replace.
    map.setLayoutProperty(layer, 'icon-size', sizeExpr(scaleStops(CATEGORY_SIZE, ENTRANCE_START)));
    map.setPaintProperty(layer, 'icon-opacity', 0);
    map.setPaintProperty(layer, 'text-opacity', 0);

    // The sway outlasts the growth by 780 ms, and for all of it the size is a
    // settled 1.0. Pushing that unchanged value at a LAYOUT property anyway is
    // ~47 pointless symbol re-layouts, so the growth stops writing when it stops
    // changing and the rest of the run is paint alone.
    let growing = true;

    await overFrames(SWAY_MS, (p) => {
      if (!map.getLayer(layer)) return;
      const ms = p * SWAY_MS;

      if (growing) {
        const done = ms >= GROW_MS;
        const grown = ENTRANCE_START + (1 - ENTRANCE_START) * growEase(Math.min(ms / GROW_MS, 1));
        map.setLayoutProperty(layer, 'icon-size', done ? base
          : sizeExpr(scaleStops(CATEGORY_SIZE, grown)));
        growing = !done;
      }

      // Read per frame rather than captured: `frameCategory` is flying the
      // camera through this, and the swing is a fraction of the pin's width at
      // whatever zoom it is actually being drawn at.
      const width = PIN_BASE_W * sizeAt(CATEGORY_SIZE, map.getZoom());
      map.setPaintProperty(layer, 'icon-translate', [swayAt(ms, width), 0]);
      // One ramp for both, so the pin and its name are one object arriving.
      const appearing = Math.min(ms / APPEAR_MS, 1);
      map.setPaintProperty(layer, 'icon-opacity', appearing);
      map.setPaintProperty(layer, 'text-opacity', appearing);
    });

    // Back to the declarative values, so a later zoom is the expression's job
    // again and nothing is left holding a frame's worth of state.
    settle();
  }

  /**
   * Clear the campus, apply the new selection, then play it in.
   *
   * `paintCategory` is the whole of the state change and stays that way; this
   * only decides what is on screen either side of it. So a run that is cut off
   * part way still leaves the map correct — the filters and the data are set in
   * one go between the two halves, never spread across the animation.
   */
  async function playCategorySwap() {
    choreography += 1;
    const clearing = pinLayers();
    const hadPins = Boolean(map.getLayer('category-pins'));
    const wasAt = hadPins ? fadeFrom('category-pins') : 0;

    if (!prefersStill()) {
      await overFrames(PIN_FADE_MS, (p) => {
        setLayerFade(clearing, 1 - p);
        if (hadPins && map.getLayer('category-pins')) {
          // A chip pressed while another is up: its pins are the ones on screen.
          map.setPaintProperty('category-pins', 'icon-opacity', wasAt * (1 - p));
          map.setPaintProperty('category-pins', 'text-opacity', wasAt * (1 - p));
        }
      });
    }

    paintCategory();
    // Filtered out entirely now, so their opacity is only being made ready for
    // whenever the chip is let go of.
    setLayerFade(clearing, 1);
    await playCategoryEntrance();
  }

  /** The way back: the answer goes, and the campus comes up behind it. */
  async function playCategoryClear() {
    choreography += 1;
    const still = prefersStill();

    if (!still && map.getLayer('category-pins')) {
      const wasAt = fadeFrom('category-pins');
      await overFrames(PIN_FADE_MS, (p) => {
        if (!map.getLayer('category-pins')) return;
        map.setPaintProperty('category-pins', 'icon-opacity', wasAt * (1 - p));
        map.setPaintProperty('category-pins', 'text-opacity', wasAt * (1 - p));
      });
    }

    paintCategory();

    const returning = pinLayers();
    if (!still) {
      // Longer coming back than going, because this one has to re-place forty
      // labels rather than take them away, and a campus that snaps back on is
      // the jolt the fade out was avoiding.
      setLayerFade(returning, 0);
      await overFrames(PIN_FADE_MS * 1.6, (p) => setLayerFade(returning, p));
    }
    setLayerFade(returning, 1);
  }

  // -------------------------------------------------------------------------
  // Selecting a pin
  //
  // Tapping one lifts it: the symbol is taken out of its layer and an HTML
  // marker takes its place at exactly the size the symbol was being drawn at,
  // then springs up to the selected size. See src/pin-select.js for where that
  // curve comes from — it is Apple Maps', measured off a 60 fps capture.
  //
  // An HTML marker rather than a bigger symbol because a symbol layer can only
  // be resized by pushing a new `icon-size` every frame, which restyles the
  // whole layer to move one icon and scales a 2x raster past its own resolution
  // while it does it.
  // -------------------------------------------------------------------------

  /** `{ layer, id, coords, kind, name }` for the pin that is up, or null. */
  let selectedPin = null;
  let selectedMarker = null;

  /**
   * The queued restore of the symbol under a marker that is shrinking away.
   *
   * Held so it can be cancelled. Both painters read the CURRENT selection rather
   * than one captured when the timer was set, so a stale one was never wrong —
   * it just re-painted every pin layer to the state they were already in. But
   * people tap along a row of pins faster than the 190 ms this waits, and each
   * tap was leaving another one behind: a filter rebuild and a repaint per pin
   * layer, for an answer that had been on screen since the tap before.
   */
  let restorePins = null;

  /** The filter that hides the lifted pin from its own layer, or null. */
  const hiddenPin = (layer) =>
    (selectedPin?.layer === layer ? ['!=', ['id'], selectedPin.id] : null);

  /**
   * What the ambient amenity layer is allowed to draw.
   *
   * Two rules combined, because setting them in turn would mean each one put
   * back what the other had just taken out. The zoom rank thins 84 markers down
   * to the 31 worth seeing across a whole campus (see AMENITY_ZOOM in poi.js);
   * the second hides whichever one has been lifted into a selection.
   *
   * A zoom expression in a `filter` is only re-evaluated at integer zooms, which
   * is exactly why the thresholds in that table are integers.
   */
  function amenityFilter() {
    const ranked = ['>=', ['zoom'], [
      'match',
      ['get', 'kind'],
      ...Object.entries(AMENITY_ZOOM).flatMap(([kind, zoom]) => [kind, zoom]),
      AMENITY_ZOOM_DEFAULT,
    ]];
    const hidden = hiddenPin('campus-amenities');
    return hidden ? ['all', ranked, hidden] : ranked;
  }

  /** Which size table a layer draws its discs from. */
  const SIZE_TABLE = { 'category-pins': CATEGORY_SIZE, 'campus-amenities': AMBIENT_SIZE };

  /** How wide that layer is drawing its icons at this zoom, in CSS pixels. */
  const ambientWidth = (layer) => PIN_BASE_W * sizeAt(
    SIZE_TABLE[layer] ?? LABEL_SIZE,
    map.getZoom(),
  );

  /**
   * The label layers that draw a pictogram, and are therefore pins.
   *
   * POI_LABEL_KINDS is the set poi.js gives a disc to; 38 of the 49 printed
   * labels get one. They looked like every other marker on this map and behaved
   * like nothing at all — `pinAt` did not know about them, so a tap fell through
   * to the building underneath and the lift never played. At the zoom the campus
   * fits the screen at they are most of the markers on it.
   */
  const POI_LABEL_LAYERS = [...POI_LABEL_KINDS].map((kind) => `campus-labels-${kind}`);

  /**
   * A label layer draws its own kind, minus whichever one has been lifted.
   *
   * ...and minus all of them while a chip is up, for the kinds that carry a
   * pictogram. Those 38 are pins — `pinAt` treats them as such and they lift
   * like any other — so leaving them on screen while a category is showing puts
   * the answer among forty markers that did not change. The kinds with no disc
   * stay: they are place names, not markers, and a campus that loses its own
   * names is harder to read, not clearer.
   */
  const labelFilter = (kind) => {
    if (shownCategory() && POI_LABEL_KINDS.has(kind)) return ['boolean', false];
    // "Closed" is a building-kind label and it is drawn by campus-labels-closed
    // instead, which is the only layer here that can be rotated onto the shape
    // it annotates. Excluded rather than left to draw twice.
    const mine = kind === 'building'
      ? ['all', ['==', ['get', 'kind'], kind], ['!=', ['get', 'text'], CLOSED_TEXT]]
      : ['==', ['get', 'kind'], kind];
    const hidden = hiddenPin(`campus-labels-${kind}`);
    return hidden ? ['all', mine, hidden] : mine;
  };

  /** Re-apply those filters, which is what hides and restores a lifted label. */
  function paintLabels() {
    for (const kind of POI_LABEL_KINDS) {
      const id = `campus-labels-${kind}`;
      if (map.getLayer(id)) map.setFilter(id, labelFilter(kind));
    }
  }

  /**
   * The pin under a click, or null.
   *
   * Category pins first: while a chip is up they are the layer that is meant to
   * be answering, and the two can sit on the same coordinate.
   */
  function pinAt(pointer) {
    for (const layer of ['category-pins', 'campus-amenities', ...POI_LABEL_LAYERS]) {
      if (!map.getLayer(layer)) continue;
      const [hit] = map.queryRenderedFeatures(pointer, { layers: [layer] });
      if (!hit) continue;
      return {
        layer,
        id: hit.id,
        coords: hit.geometry.coordinates,
        // A label's pictogram is in `poi`; an amenity's is its own `kind`.
        kind: hit.properties.poi ?? hit.properties.kind ?? hit.properties.icon,
        // A building's name is the label itself, which is what a lifted marker
        // should be captioned with.
        text: hit.properties.text ?? null,
        // Amenities carry the legend's wording; a category pin carries the
        // directory's, and drops it when the name would not identify anything.
        name: hit.properties.name || hit.properties.label || hit.properties.text || null,
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Hovering a pin
  //
  // A marker under the pointer springs up a little, its name changes colour,
  // and the cursor becomes a pointer. Three signals for one fact — this is a
  // thing you can press — because each of them is doing something the other two
  // cannot: the cursor says it before you have looked away from what you were
  // reading, the size says WHICH one of forty markers, and the colour survives
  // the pin being under your own hand.
  //
  // The spring is the lift's own, off the same capture. A hover is not a
  // selection, so it goes a fraction of the distance — but it is the same
  // gesture in miniature, and a different easing here would read as a different
  // map. That overshoot is the twitch.
  //
  // HOW IT IS DRAWN, because this is the part with a trap in it: `icon-size` is
  // a LAYOUT property, and layout properties cannot read `feature-state`. So
  // there is no per-feature hover the way there is for a fill. What there IS is
  // `['id']`, which is legal in a layout expression — so the layer is given a
  // size expression that names one id and scales only that one, and the
  // expression is rewritten each frame. The `case` sits INSIDE the interpolate's
  // outputs rather than around it, for the same reason scaleStops exists: Mapbox
  // only accepts `['zoom']` as the direct input to a top-level interpolate.
  //
  // One layer at a time, always. Pushing a layout property re-lays out that
  // layer's symbols, and the printed-label set is the expensive one — the
  // category swap declines to animate it for exactly this reason. Hovering
  // touches only the layer the pointer is actually over.
  // -------------------------------------------------------------------------

  /** How much bigger a hovered pin is drawn. Small: it is a hint, not a lift. */
  const HOVER_SCALE = 1.16;
  const HOVER_MS = 260;

  /** The pin under the pointer, shaped like selectedPin so the two read alike. */
  let hoveredPin = null;
  /** The multiplier the hovered pin is currently drawn at. */
  let hoverScale = 1;
  /** Bumped to cancel a run in flight, exactly as `choreography` does. */
  let hoverRun = 0;

  /**
   * `icon-size` for a layer, with the hovered feature — and only it — scaled.
   *
   * Falls back to the plain expression whenever this layer is not the hovered
   * one, so a layer that is left goes back to being declarative rather than
   * holding a frame's worth of state.
   */
  function pinSizeExpr(layer) {
    const stops = SIZE_TABLE[layer] ?? LABEL_SIZE;
    if (hoveredPin?.layer !== layer || hoverScale === 1) return sizeExpr(stops);
    const mine = ['==', ['id'], hoveredPin.id];
    return ['interpolate', ['linear'], ['zoom'], ...Object.entries(stops).flatMap(
      ([zoom, size]) => [Number(zoom), ['case', mine, size * hoverScale, size]],
    )];
  }

  /** ...and its `text-color`, with the hovered pin's name in the accent. */
  function pinTextExpr(layer) {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);
    const base = layer === 'campus-amenities' ? inkFor('kind')
      : layer === 'category-pins' ? inkFor('icon')
        : labelPaint(layer.replace('campus-labels-', ''), colors);
    if (hoveredPin?.layer !== layer) return base;
    return ['case', ['==', ['id'], hoveredPin.id], colors.highlight, base];
  }

  /**
   * Push both onto one layer.
   *
   * `category-pins` is skipped while its entrance is playing. That animation
   * owns the same layout property frame by frame, and a hover repaint landing in
   * the middle of it would drop the pins to full size mid-arrival. It gets one
   * repaint when the swap settles instead, so a pointer resting where the pins
   * land still finds its hover.
   */
  function paintPinHover(layer) {
    if (!map.getLayer(layer)) return;
    if (layer === 'category-pins' && pinsArriving) return;
    map.setLayoutProperty(layer, 'icon-size', pinSizeExpr(layer));
    map.setPaintProperty(layer, 'text-color', pinTextExpr(layer));
  }

  /** Ease one layer's hover scale from where it is to `to`, then settle. */
  function runHover(layer, to, ms, ease, run, done) {
    if (prefersStill()) {
      // The colour still changes — it is the signal, not the decoration — but
      // nothing moves.
      hoverScale = 1;
      done?.();
      paintPinHover(layer);
      return;
    }
    const from = hoverScale;
    const started = performance.now();
    const step = (now) => {
      if (run !== hoverRun) return;
      const p = Math.min(1, (now - started) / ms);
      hoverScale = from + (to - from) * ease(p);
      paintPinHover(layer);
      if (p < 1) { requestAnimationFrame(step); return; }
      if (done) { done(); paintPinHover(layer); }
    };
    requestAnimationFrame(step);
  }

  /**
   * Point at a pin, or at nothing.
   *
   * Three cases, and the third is the compromise. Arriving at a pin springs it
   * up; leaving one for empty map settles it back down where it is. Moving
   * straight from a pin in one layer to a pin in another SNAPS the first back,
   * because one scale cannot animate two layers and the expression that grew the
   * old feature names an id its layer is no longer about. Nobody watches the pin
   * they just left when a new one is growing under the pointer.
   */
  function hoverPin(next) {
    const prev = hoveredPin;
    if (next?.layer === prev?.layer && next?.id === prev?.id) return;
    hoverRun += 1;
    const run = hoverRun;

    if (prev && (!next || prev.layer !== next.layer)) {
      if (next) {
        hoveredPin = null;
        hoverScale = 1;
        paintPinHover(prev.layer);
      } else {
        // hoveredPin stays `prev` for the length of this, because the
        // expression settling it back down is still the one that names it.
        runHover(prev.layer, 1, SHRINK_MS, shrinkEase, run, () => {
          if (run === hoverRun) hoveredPin = null;
        });
      }
    }

    if (!next) return;
    hoveredPin = next;
    hoverScale = 1;
    runHover(next.layer, HOVER_SCALE, HOVER_MS, growEase, run);
  }

  /** Let go of whatever is hovered without animating — for a style swap. */
  function clearHover() {
    hoverRun += 1;
    const was = hoveredPin;
    hoveredPin = null;
    hoverScale = 1;
    if (was) paintPinHover(was.layer);
  }

  function deselectPin() {
    if (!selectedPin) return;
    closeBuildingCard();
    const width = ambientWidth(selectedPin.layer);
    selectedPin = null;
    // The marker shrinks back before it goes, and the symbol underneath only
    // comes back once it has: unfilter first and there are two pins for a fifth
    // of a second, the small one sitting inside the shrinking large one.
    const marker = selectedMarker;
    selectedMarker = null;
    marker?.remove(width);
    clearTimeout(restorePins);
    restorePins = setTimeout(() => { paintCategory(); paintLabels(); }, 190);
  }

  /**
   * Lift a pin out of its layer.
   *
   * `card` is false when the caller has a better one to show. A building's
   * pictogram is a pin like any other and lifts like one, but what belongs in
   * the panel is the building card — the floor area, what is inside it, the
   * entrance its Start and Destination buttons actually route from — not the
   * two-line card a defibrillator gets. Same panel either way; the caller
   * fills it instead, immediately after this returns.
   */
  function selectPin(hit, { card = true } = {}) {
    // Tapping the pin that is already up puts it back, the way pressing a lit
    // legend row clears the category.
    if (selectedPin?.layer === hit.layer && selectedPin?.id === hit.id) {
      deselectPin();
      return;
    }
    deselectPin();
    closeBuildingCard();

    const from = ambientWidth(hit.layer);
    selectedPin = hit;
    // Filter first, so the symbol is gone by the time its replacement appears.
    // This pair IS the restore the deselect above queued, arriving 190 ms early
    // and with the new selection already filtered out — so drop the timer rather
    // than let it repeat the work once the marker has finished shrinking.
    clearTimeout(restorePins);
    paintCategory();
    paintLabels();

    selectedMarker = mountSelectedPin({
      map,
      marker: mapboxgl.Marker,
      kind: hit.kind,
      coords: hit.coords,
      label: hit.name,
      // The hue the resting label was set in, so the caption crosses from it to
      // the map's ink rather than appearing already black.
      ink: currentBasemap === 'satellite' ? SATELLITE.label : pinInk(hit.kind, currentTheme),
      ring: palette(currentProvider, currentBasemap, currentTheme, currentSkin).pinRing,
      from,
      blur: pinBlur,
    });

    if (!card) return;

    showPlaceCard(pinCard(hit, {
      onStart: (coords, name) => { clearSelection(); placeStart(coords, name); },
      onEnd: (coords, name) => { clearSelection(); setDestination(coords, name); },
      onClose: clearSelection,
    }));
  }

  /** Straight-line feet from wherever the user is measuring from. */
  function feetFrom(coords) {
    const from = startPoint?.geometry.coordinates ?? map.getCenter().toArray();
    return distance(point(from), point(coords)) * FEET_PER_KM;
  }

  function renderCategoryList(category) {
    categoryTitle.textContent = category.label;
    categoryCount.textContent = categoryHits.length
      ? `${categoryHits.length} on campus · ${category.legend}`
      : `Nothing found · ${category.legend}`;

    categoryList.replaceChildren(...categoryHits.map((hit) => {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'g-row';

      const disc = document.createElement('span');
      disc.className = 'g-row-disc';
      disc.dataset.icon = category.glyph;
      row.append(disc);

      const text = document.createElement('span');
      text.className = 'g-row-text';
      const name = document.createElement('span');
      name.className = 'g-row-name';
      name.textContent = hit.name;
      text.append(name);
      if (hit.sub) {
        const sub = document.createElement('span');
        sub.className = 'g-row-sub';
        sub.textContent = hit.sub;
        text.append(sub);
      }
      row.append(text);

      const dist = document.createElement('span');
      dist.className = 'g-row-dist';
      dist.textContent = niceFeet(hit.feet);
      row.append(dist);

      row.addEventListener('click', () => setDestination(hit.coords, hit.name));
      li.append(row);
      return li;
    }));
    paintIcons(categoryList);
    categoryPanel.classList.remove('hidden');
  }

  /**
   * Frame the hits, unless they are already in front of you — Google does not
   * move the map when what you asked for is already on screen, and a gratuitous
   * flyTo throws away wherever the user had panned to.
   *
   * "On screen" is tested in screen pixels against the padded rectangle, not
   * with map.getBounds().contains(). getBounds() is the whole canvas including
   * the strip the panel is floating over, so the three bus stops — which sit at
   * the far west edge, behind the panel — counted as visible and the map never
   * moved to show them.
   */
  function frameCategory() {
    if (categoryHits.length) { frame(categoryHits.map((hit) => hit.coords)); return; }
    // No pins does not mean nothing to show. A category whose source file
    // failed to load still outlines its buildings — the two halves degrade
    // separately — and a press that lit up ground somewhere off screen while
    // the camera sat still would read as a press that did nothing.
    const highlight = legendHighlights.get(activeCategory);
    if (highlight) frame(extentOf(legendAreas, highlight), { maxZoom: 17 });
  }

  /**
   * Bring a set of points into view, leaving the camera alone if they already
   * are. Shared by the chips and by the route, which want the same behaviour for
   * the same reason.
   */
  function frame(points, { maxZoom = 18 } = {}) {
    if (points.length < 1) return;

    const pad = campusPadding();
    const canvas = map.getCanvas();
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    const onScreen = (coords) => {
      const p = map.project(coords);
      return p.x >= pad.left && p.x <= w - pad.right && p.y >= pad.top && p.y <= h - pad.bottom;
    };
    if (points.every(onScreen)) return;

    const bounds = points.reduce(
      (acc, coords) => acc.extend(coords),
      new mapboxgl.LngLatBounds(points[0], points[0]),
    );
    map.fitBounds(bounds, { padding: pad, maxZoom, duration: 700 });
  }

  /**
   * A category's pins, nearest first.
   *
   * Shared by the press and the hover preview, so the two cannot disagree about
   * what a row means. The preview IS the answer, arriving early.
   */
  function hitsFor(category) {
    return collect(category, { amenities: campusAmenities, places: campusPlaces })
      .map((hit) => ({ ...hit, feet: feetFrom(hit.coords) }))
      .sort((a, b) => a.feet - b.feet);
  }

  function selectCategory(id) {
    const category = CATEGORY_BY_ID.get(id);
    if (!category) return;

    // Pressing the pressed chip is how you get back to the whole map.
    if (activeCategory === id) { clearCategory(); return; }

    activeCategory = id;

    // The hover that led here is being promoted to a selection, so the preview
    // state goes now. Nothing changes on screen — these are the same pins, and
    // shownCategory falls straight through to activeCategory — but leaving it
    // set would arm the mouseleave that is about to happen to tear down the
    // selection it had just become.
    hoverCategory = null;
    hoverHits = [];

    // EVERY pin gets its name, including the six that all read "All-gender
    // restroom". This used to print a name only where it identified one pin
    // among the others — "Myrtle Parking Lot East" yes, six copies of one phrase
    // no — on the grounds that repeating the icon's own meaning in type is
    // noise.
    //
    // It is noise on a map you are reading and it is the answer on a map you
    // have just questioned. Having pressed Defibrillators, the six discs are the
    // result and the word under each is what says so; leaving them bare made the
    // category read as a pictogram you still had to know. The names are also the
    // point of the entrance — they arrive with the pins — and an entrance where
    // most of the pins bring nothing looks half-finished.
    //
    // Collision still has the last word, because `text-optional` is set on the
    // layer: names that cannot fit are dropped and their discs stay. That is the
    // right place for the decision, since it depends on the zoom rather than on
    // the wording.
    categoryHits = hitsFor(category);

    // On a phone the legend is a full-width sheet over the map, so leaving it
    // up would mean answering "where are the restrooms" with a card covering
    // the restrooms. The pins and the results list are the answer; the list you
    // asked from has done its job.
    // Plain toggleSheet, not toggleLegendPanel: frameCategory a few lines below
    // is about to move the camera anyway, and it reads campusPadding after this
    // has run, so the sheet is already out of the reckoning.
    if (phone.matches) toggleSheet(legendPanel, legendOpen, false);

    // The pressed row, and the outline that goes with it. A category press now
    // answers both halves of the question it was split across: the pins say
    // where the things are, the outline says which buildings hold them.
    stickyRow = id;
    paintHighlight();
    syncLegendRows();

    renderCategoryList(category);
    // The camera and the pins move together. Framing first and animating after
    // would read as two separate events, and the fly is 700 ms of the 1324 the
    // pins take anyway.
    //
    // The pins own the camera, not the outline: the pins ARE the answer and the
    // outlined ground is context for it, and two fitBounds in one gesture is a
    // flight that lands somewhere neither of them asked for.
    frameCategory();
    playCategorySwap();
  }

  function clearCategory() {
    activeCategory = null;
    categoryHits = [];
    stickyRow = null;
    paintHighlight();
    syncLegendRows();
    categoryPanel.classList.add('hidden');
    categoryList.replaceChildren();
    playCategoryClear();
  }

  categoryClose.addEventListener('click', clearCategory);

  /**
   * The printed map's own labels.
   *
   * These used to come from places.json, which is my campus's destination database —
   * names written to be unambiguous in a search box, not on a map, so the
   * Portable Village arrived as "Manufacturing, Construction, and Transportation
   * Division - Portable Village, Room 603B". scripts/build-labels.mjs takes what
   * their cartographer actually set instead: "Library", "Main Gym", "STADIUM".
   * places.json is still what search reads; it was only ever wrong for labels.
   *
   * One layer per kind rather than one for all four, because they differ in
   * weight, tracking and colour — and `text-font` is a layout property that
   * takes no data expression, so a single layer could not set Medium for area
   * names and Regular for the rest whatever the paint said.
   *
   * `plate` is my campus's name for their larger building labels, kept because it is
   * the source data's vocabulary. The dark box it refers to is not drawn any
   * more; see addLabelLayers.
   */
  const LABEL_KINDS = ['area', 'plate', 'building', 'parking'];

  /**
   * my campus's hierarchy, at Google's sizes.
   *
   * Keeping the point size the cartographer set is right — Library is 13.1 pt
   * against Oak Cafe's 6.6, and that ordering is real information. Using those
   * numbers AS pixels is not: they were set for a sheet 34 inches wide, and
   * multiplied straight through they gave a spread of 6.6 to 16 px against the
   * 11 to 15 Google sets its own labels in. Ours were visibly the smaller map's
   * type sitting on the bigger map's ground, which is most of what made the two
   * halves look like two maps.
   *
   * So the print range is mapped onto theirs and the ordering survives the
   * remap. Measured off the raster rather than taken from a spec: a Google road
   * label is 11-12 px, an ordinary POI 12, a prominent one 14-15.
   */
  const GOOGLE_BAND = ['interpolate', ['linear'], ['get', 'pt'], 6, 11, 14.5, 16];

  /**
   * ...and a much flatter zoom ramp than print scaling implies.
   *
   * This is the other half of the mismatch, and the more visible one while
   * moving: a Google label is very nearly the same size at z15 and at z19,
   * because their type is chrome for reading the map rather than something
   * drawn on the ground. Ours scaled 1.1x to 1.9x across that range, so the two
   * agreed at one zoom and diverged either side of it. 0.86 to 1.1 keeps a
   * little of the growth — labels are allowed to breathe as you zoom in — with
   * nothing like the drift.
   */
  const labelSize = (scale) => [
    'interpolate', ['linear'], ['zoom'],
    15, ['*', GOOGLE_BAND, 0.86 * scale],
    17, ['*', GOOGLE_BAND, 1.0 * scale],
    19, ['*', GOOGLE_BAND, 1.1 * scale],
  ];

  /**
   * Ink for one label kind, so the layer builder and the theme-switch path
   * cannot drift apart — they used to set these from two separate expressions
   * and a fourth kind would silently keep the old colour on a theme change.
   *
   * Google colours a label by what it names, not by its size: greenspace is
   * green, everything built is the same cool slate, and parking is that slate
   * lightened rather than a hue of its own.
   */
  /**
   * A building name takes its POI disc's hue, the way an amenity name does.
   *
   * Same rule Apple applies and the same reason: a label tinted with its
   * marker's colour is readable as a category before it is readable as a word.
   * Only the ones that HAVE a disc, though — an area name has no marker to
   * agree with, so those keep the map's own ink.
   *
   * A car park now has a disc and still keeps its own ink, which is the one
   * place these two sets come apart. The tint is not free: it is worth paying
   * where it separates ten categories from each other, and a car park is in a
   * category of one. What it would cost is measured — the lot names sit on the
   * lot, and against `land.parking` the parking blue reads 3.09:1 at night
   * where `parkingLabel` reads 3.78:1, and by day it lands at 10.93:1, a navy
   * so much heavier than the surrounding type that the lots would read as the
   * loudest names on the campus. `parkingLabel` was itself placed by measuring
   * against that surface; see the note on it in src/palette.js.
   */
  const POI_TINTED_KINDS = new Set(['building', 'plate']);

  const labelPaint = (kind, colors) => (POI_TINTED_KINDS.has(kind)
    ? ['case', ['has', 'poi'], inkFor('poi'), labelInk(kind, colors)]
    : labelInk(kind, colors));

  const labelInk = (kind, colors) => (
    kind === 'area' ? colors.areaLabel
      : kind === 'parking' ? colors.parkingLabel
        : colors.label
  );

  /**
   * Buildings you can tap.
   *
   * src/directory.json is one feature per building — footprints folded together,
   * so tapping one of the Health Education Complex's nine shapes shows the whole
   * complex — carrying what the sheet calls it and which of my campus's destinations
   * are inside it.
   *
   * The hit layer is drawn at zero opacity rather than left out, because
   * queryRenderedFeatures only sees layers that are actually in the style. The
   * highlight is a second layer filtered to the selected building; a filter
   * needs no feature ids and no promoteId, which a feature-state approach would.
   */
  const NOTHING_SELECTED = ['==', ['get', 'officialName'], '\u0000'];
  // Two constants used to live here — the widths a floating card had to clear
  // before it stopped opening underneath the route panel. The card is IN the
  // column with the route panel now rather than over the map, so there is
  // nothing left for it to collide with and no arithmetic to get wrong.

  function addDirectoryLayers() {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);

    if (map.getLayer('campus-directory-fill')) {
      map.setPaintProperty('campus-directory-fill', 'fill-color', colors.route);
      map.setPaintProperty('campus-directory-line', 'line-color', colors.route);
      return;
    }
    if (!campusDirectory) return; // still in flight; addNetworkLayers re-runs

    if (!map.getSource('campus-directory')) {
      map.addSource('campus-directory', { type: 'geojson', data: campusDirectory });
    }

    map.addLayer({
      id: 'campus-directory-hit',
      type: 'fill',
      source: 'campus-directory',
      slot: 'middle',
      paint: { 'fill-opacity': 0 },
    });
    map.addLayer({
      id: 'campus-directory-fill',
      type: 'fill',
      source: 'campus-directory',
      slot: 'middle',
      filter: NOTHING_SELECTED,
      paint: { 'fill-color': colors.route, 'fill-opacity': 0.22, 'fill-emissive-strength': 1 },
    });
    map.addLayer({
      id: 'campus-directory-line',
      type: 'line',
      source: 'campus-directory',
      slot: 'middle',
      filter: NOTHING_SELECTED,
      paint: { 'line-color': colors.route, 'line-width': 2, 'line-emissive-strength': 1 },
    });
  }

  function highlightBuilding(officialName) {
    selectedBuilding = officialName;
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
  function showPlaceCard(card, flyover = null) {
    // Swapped in one step, and in this order, because the incoming card may
    // already hold a live flyover of its own: tearing down after adopting would
    // destroy the one just built, and adopting before tearing down would leak
    // the one going away.
    activeFlyover?.destroy();
    activeFlyover = flyover;

    const was = !placePanel.classList.contains('hidden');
    placePanel.replaceChildren(card);
    placePanel.classList.remove('hidden');
    // Only when the column's width actually changed. Swapping one card for
    // another is a repaint, not a new obstruction, and a camera that eased on
    // every tap would drift across the campus a tap at a time.
    if (!was) map.easeTo({ padding: campusPadding(), duration: 300 });
  }

  function closePlaceCard() {
    if (placePanel.classList.contains('hidden')) return;
    activeFlyover?.destroy();
    activeFlyover = null;
    placePanel.classList.add('hidden');
    placePanel.replaceChildren();
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
    if (!campusDirectory || !name) return null;
    return campusDirectory.features.find((f) => f.properties?.name === name)?.geometry ?? null;
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
        const frame = framing(props.area_m2, extent);
        // The box the renderer is told to stop at, built here rather than
        // inside the view so the policy — how much ground a place is worth
        // loading — stays in one file with the rest of it.
        return createFlyover({
          key: googleKey, centre, name: props.name, ...frame, box: boxOf(centre, frame.reach),
          // The ROOF, which is a different point from the one the camera aims
          // at: `centre` is the middle of the footprint, on the ground, and a
          // pin dropped on that goes through the building.
          roof: roofOf(props.name),
        });
      })()
      : null;

    showPlaceCard(buildingCard(props, {
      media: flyover?.el,
      onStart: (coords, name) => {
        if (startPoint && endPoint) resetMap();
        clearSelection();
        placeStart(coords, name);
        setStatus(`Start set at ${name}. Now pick a destination.`);
      },
      onEnd: async (coords, name) => {
        clearSelection();
        // Same as the search box: with the virtual location on, "Directions"
        // from a building's card is a whole question and gets a whole answer.
        if (!startPoint) haveStart();
        if (!startPoint) {
          pendingEnd = { coords, name };
          showRoutePanel();
          setStatus(`${name} set as the destination. Press and hold the map to set a start point.`);
          return;
        }
        if (endPoint) resetMap0(coords, name);
        else await placeEnd(coords, name);
      },
      onClose: clearSelection,
    }), flyover);
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
    if (!campusDirectory) return;
    const rows = campusDirectory.features
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
   * The card is the same one a tap on the footprint opens; the difference is
   * that the thing you just chose may be off screen entirely, so this also
   * takes the camera there. `anchor` is the pole of inaccessibility the label
   * is set at — the point furthest inside the footprint — which is a better
   * centre than the entrance node hanging off one edge of it.
   */
  function openBuilding(props) {
    clearSelection();
    showBuildingCard(props);
    const centre = props.anchor ?? props.entrance;
    if (!centre) return;
    map.easeTo({
      center: centre,
      zoom: Math.max(map.getZoom(), 17),
      // Read AFTER the card is up, so the campus is framed around the column
      // the card has just made taller rather than the one it replaced.
      padding: campusPadding(),
      duration: 700,
    });
  }

  /** Re-route from the existing start to a newly chosen destination. */
  async function resetMap0(coords, name) {
    if (endMarker) endMarker.remove();
    endMarker = null;
    endPoint = null;
    await placeEnd(coords, name);
  }

  function addLabelLayers() {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);

    if (map.getLayer('campus-labels-building')) {
      for (const kind of LABEL_KINDS) {
        map.setPaintProperty(`campus-labels-${kind}`, 'text-color', labelPaint(kind, colors));
        map.setPaintProperty(`campus-labels-${kind}`, 'text-halo-color', colors.labelHalo);
      }
      // Not in the loop above: the closed label is not one of LABEL_KINDS and
      // its red comes from its own two-value ramp rather than from the palette.
      if (map.getLayer('campus-labels-closed')) {
        map.setPaintProperty('campus-labels-closed', 'text-color',
          CLOSED_INK[currentTheme === 'dark' ? 'dark' : 'light']);
        map.setPaintProperty('campus-labels-closed', 'text-halo-color', colors.labelHalo);
      }
      return;
    }
    if (!campusLabels) return;

    if (!map.getSource('campus-labels')) {
      // `generateId` for the same reason the amenity source has it: a lifted pin
      // has to hide the symbol it came out of, and `['!=', ['id'], n]` is the
      // only way to name one feature of a layer. labels.json carries no ids.
      map.addSource('campus-labels', { type: 'geojson', data: campusLabels, generateId: true });
    }

    // The building names carry a POI disc now, so their images have to be
    // registered before a layer can reference one — same reason addAmenityLayer
    // waits, and the same loader, because they are one icon family.
    loadAmenityIcons(map, pinRing())
      .then(() => buildLabelLayers())
      .catch((error) => console.error('label icons unavailable:', error));
  }

  function buildLabelLayers() {
    // A style swap can land between the loader resolving and this running, and
    // the palette can have changed under it — so both are re-read here.
    if (map.getLayer('campus-labels-building') || !map.getSource('campus-labels')) return;
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);

    const common = {
      type: 'symbol',
      source: 'campus-labels',
      slot: 'middle',
      // Below this the campus is a few hundred pixels wide and the labels are
      // stacked on top of each other.
      minzoom: 15,
    };
    // Bigger type wins a collision, which is my campus's own hierarchy again.
    const sortKey = ['-', 0, ['get', 'pt']];

    /**
     * A disc at the point with the name set to its right, which is how Google
     * draws a POI and the reason their map is scannable — colour carries the
     * category, so you find the gym without reading 39 building names.
     *
     * `['get', 'poi']` evaluates to null for a feature that has none, and a
     * null icon-image simply draws no icon; the `case`s around the text put
     * that label back to plain centred type rather than leaving it offset into
     * empty space. Only "Closed" takes that path today — it names a fenced-off
     * area, not a place.
     */
    const poiLayout = {
      'icon-image': ['get', 'poi'],
      'icon-size': sizeExpr(LABEL_SIZE),
      // Centred on the coordinate: the resting marker is a disc, not a balloon,
      // so nothing about it points downward at a spot below itself.
      'icon-anchor': 'center',
      'text-anchor': ['case', ['has', 'poi'], 'top', 'center'],
      'text-justify': 'center',
      // BENEATH the disc, which is Apple's arrangement and a straightforwardly
      // easier one to hit than Google's. Their name sits beside the head, and
      // the lift that wants is a fixed ~12.5 px while `text-offset` has no unit
      // but ems — whatever size my campus happened to set that particular name at, so
      // one value could not be right for both the 11 px labels and the 16 px
      // ones. Underneath, the offset only has to clear the disc's lower half,
      // and a bigger name genuinely should stand further off a bigger disc, so
      // the em is the unit this actually wants.
      'text-offset': ['case', ['has', 'poi'], ['literal', [0, 0.9]], ['literal', [0, 0]]],
      // A disc makes each symbol wider, and width is what the collision solver
      // charges for: at the default view, adding them dropped 5 of the 21
      // building names that used to place. Trimming the default 2 px of padding
      // off both halves is what buys those back — measured, not guessed.
      'icon-padding': 0,
      'text-padding': 1,
    };

    for (const kind of LABEL_KINDS) {
      const area = kind === 'area';
      // `plate` is my campus's kind for their larger building names. The dark box it
      // is named after is gone — Google sets every label as plain haloed text —
      // so what survives is the weight and size those names already carried.
      const major = kind === 'plate';
      map.addLayer({
        ...common,
        id: `campus-labels-${kind}`,
        filter: labelFilter(kind),
        layout: {
          // Sentence case under Apple, my campus's own capitals everywhere else. The
          // string is derived at load rather than edited into labels.json —
          // see titleCase in src/poi.js for why, and for why the naive rule is
          // safe on these five names.
          'text-field': area && currentSkin === 'apple'
            ? ['coalesce', ['get', 'title'], ['get', 'text']]
            : ['get', 'text'],
          // Google's own hierarchy is set in weight, not colour: area names in
          // Medium, major buildings in Medium, everything else Regular. Bold
          // appears nowhere on their map at these sizes.
          'text-font': area || major ? mapFont().medium : mapFont().regular,
          'text-size': labelSize(area ? 0.95 : 1),
          // 8 ems is where the sheet breaks its own labels, so the printed ones
          // keep their original line breaks. The names added from my campus's database
          // have no printed breaks to reproduce and carry a width fitted to the
          // footprint instead — see build-labels.mjs.
          'text-max-width': ['coalesce', ['get', 'maxWidth'], 8],
          // 1.2 rather than 1.05: Google's lines sit further apart than my campus's
          // print setting, which is most of why their multi-line names read as
          // labels rather than as blocks of text.
          'text-line-height': 1.2,
          // my campus letterspaces its area capitals hard. Google tracks theirs only
          // slightly, so this is halved rather than dropped — losing it entirely
          // would make BASEBALL FIELD read as a building name.
          //
          // Apple tracks nothing. The reason the halving is safe to drop there
          // is that the case change above already does the separating: "Tennis
          // Courts" cannot be mistaken for a building name the way an untracked
          // TENNIS COURTS could.
          'text-letter-spacing': area && currentSkin !== 'apple' ? 0.07 : 0,
          'symbol-sort-key': sortKey,
          ...(POI_LABEL_KINDS.has(kind) ? poiLayout : {}),
        },
        paint: {
          'text-color': labelPaint(kind, colors),
          'text-halo-color': colors.labelHalo,
          // Standard's night preset would otherwise light the discs through its
          // own model and swallow them, the way it does the sheet.
          'icon-emissive-strength': 1,
          // Google's halo is a thin, slightly blurred casing rather than the
          // hard 1.4px outline a print sheet uses — enough to lift type off
          // mint lawn without the letters growing a visible white shell.
          'text-halo-width': 1.1,
          'text-halo-blur': 0.5,
          'text-emissive-strength': 1,
        },
      });
    }

    /**
     * "Closed", set on the block's own diagonal and in the red the shape is
     * drawn in.
     *
     * Its own layer rather than a `case` inside the building names, and for one
     * reason that could not be expressed there: `text-rotation-alignment` is a
     * LAYOUT property of the whole layer, not a per-feature one. This word has
     * to stay glued to the shape when the map is turned, and the other 39 names
     * have to stay upright — so they cannot share a layer, whatever else they
     * have in common.
     *
     * Deliberately the quietest label on the map. The wash and the outline are
     * what say the block is shut, and they say it at every zoom; the word only
     * names what the colour already meant, so it is fine print rather than a
     * headline. At the zoom the whole campus fits, a red shape reads instantly
     * and a 12px word across it is just clutter over one small building.
     *
     * `symbol-placement: point` with map-aligned rotation, not `line` placement
     * along the edge: the word belongs in the middle of the block saying what
     * the block is, not run along its boundary like a street name.
     */
    map.addLayer({
      ...common,
      id: 'campus-labels-closed',
      // Well past the 15 the other labels start at, and past the 16 the ambient
      // pictograms wait for. By here the block is a large shape on screen with
      // room inside it for a word, which is the only condition under which this
      // one is worth drawing.
      minzoom: 17.5,
      filter: ['==', ['get', 'text'], CLOSED_TEXT],
      layout: {
        'text-field': ['get', 'text'],
        // Regular, not the medium the building names use, and smaller than all
        // of them: this is an annotation on a shape, not the name of a place.
        'text-font': mapFont().regular,
        'text-size': labelSize(0.8),
        'text-letter-spacing': 0.06,
        'text-rotation-alignment': 'map',
        'text-rotate': closedBearing(campusBasemap),
        // Collidable like everything else. It was overlap-allowed on the
        // grounds that a warning must never be dropped, which was the wrong
        // reading: the red is the warning and it cannot be dropped, so the word
        // is free to give way to a name that has nowhere else to go.
      },
      paint: {
        'text-color': CLOSED_INK[currentTheme === 'dark' ? 'dark' : 'light'],
        'text-halo-color': colors.labelHalo,
        'text-halo-width': 1.1,
        'text-halo-blur': 0.5,
        'text-emissive-strength': 1,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Map layers
  //
  // map.setStyle() discards every custom source and layer, so this has to be
  // idempotent and has to restore the current data — it runs on every theme
  // switch, not just at startup.
  // ---------------------------------------------------------------------------

  function routeFeature() {
    if (!routeCoords) return EMPTY;
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: routeCoords } };
  }

  /** Below this a leg is a nub, not a walk, and is better left undrawn. */
  const LEG_MIN_FEET = 12;

  /**
   * The last few metres at each end, which are not on the network.
   *
   * A route runs between GRAPH VERTICES, and neither end of a journey is one.
   * my campus binds its destinations to their own node ids, which sit a metre or two
   * off ours because this network is traced from the printed sheet rather than
   * taken from their graph; an amenity is wherever its pictogram is, which for
   * half of them is inside a building. So the blue line stopped short of the
   * pin, by up to a few dozen feet, and looked like a routing failure.
   *
   * Drawn as a separate dotted layer rather than by extending routeCoords, and
   * that distinction is the honest one: this is not path, it is the walk from
   * the path to the door. Every mapping app draws it the same way and for the
   * same reason. It also keeps the maneuver list and the simulator working off
   * the network geometry alone, which is the only thing they can follow.
   */
  function legsFeature() {
    if (!routeCoords || routeCoords.length < 2) return EMPTY;
    const ends = [
      [startPoint?.geometry.coordinates, routeCoords[0]],
      [routeCoords[routeCoords.length - 1], endPoint?.geometry.coordinates],
    ];
    return {
      type: 'FeatureCollection',
      features: ends
        .filter(([a, b]) => a && b && distance(point(a), point(b)) * FEET_PER_KM >= LEG_MIN_FEET)
        .map(([a, b]) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [a, b] },
        })),
    };
  }

  function paintLegs() {
    map.getSource('route-legs')?.setData(legsFeature());
  }

  /**
   * Take Mapbox's own data out of the campus, so inside the boundary the map is
   * ours and outside it is theirs.
   *
   * This needs two mechanisms, because neither one covers everything:
   *
   *   - `clip` removes basemap features inside the polygon, but only of the
   *     types it is told about, and the type list it understands is model,
   *     symbol and fill-extrusion. That is Mapbox's 3D buildings, their
   *     landmark models and every label — but not roads.
   *   - Roads, footpaths and parking aisles are plain `line` layers, which clip
   *     cannot touch at all. Those have to be painted over.
   *
   * The boundary is OSM's own `amenity=college` way, which is the polygon
   * Mapbox draws the campus from, so the cut lands exactly on their edge.
   */
  function addCampusMask() {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);

    if (!map.getSource('campus-boundary')) {
      map.addSource('campus-boundary', { type: 'geojson', data: campusBoundary });
    }

    // Nothing to clip when Google draws the ground: the style under us is
    // blank, so there is no `basemap` import for `clip-layer-scope` to name and
    // no Mapbox symbols or models to remove. Skipped rather than left to no-op,
    // because a clip layer sitting above the Google raster is one scope-matching
    // change away from punching a hole in the ground it is meant to leave alone.
    if (currentProvider !== 'google' && !map.getLayer('campus-clip')) {
      try {
        map.addLayer({
          id: 'campus-clip',
          type: 'clip',
          source: 'campus-boundary',
          layout: {
            // `model` and `symbol` are the only values this accepts — passing
            // `fill-extrusion` is rejected outright. That is enough: Standard
            // draws its buildings and landmarks as batched models, and every
            // label is a symbol, so both are covered.
            'clip-layer-types': ['model', 'symbol'],
            // Scoping this to the basemap is not optional. Our markers are
            // symbols too, so an unscoped clip would delete exactly the data
            // this is meant to reveal.
            'clip-layer-scope': ['basemap'],
          },
        });
      } catch (error) {
        // Isolated on purpose. A clip failure must not take the fill mask down
        // with it, or a version bump that changes this property silently leaves
        // Mapbox's roads showing through the campus.
        console.error('campus clip unavailable:', error.message);
      }
    }

    if (colors.mask === null) {
      if (map.getLayer('campus-mask')) map.removeLayer('campus-mask');
      return;
    }

    if (map.getLayer('campus-mask')) {
      map.setPaintProperty('campus-mask', 'fill-color', colors.mask);
      return;
    }
    map.addLayer({
      id: 'campus-mask',
      type: 'fill',
      source: 'campus-boundary',
      // `middle` sits above the basemap's polygons and lines and below its 3D
      // and labels — the only slot that covers roads without burying our own
      // work or Mapbox's place names outside the campus.
      slot: 'middle',
      paint: {
        'fill-color': colors.mask,
        // Standard lights every fill through its own lighting model, and under
        // the night preset that drove the mask almost black: raising the
        // authored colour threefold moved the rendered pixel by a tenth. This
        // opts the mask out of the lighting entirely so it renders as written,
        // which is what a flat ground plane wants anyway.
        'fill-emissive-strength': 1,
      },
      // Re-added after a basemap swap, this would otherwise land on top of the
      // network it is supposed to sit under.
    }, belowNetwork());
  }

  /**
   * One Standard configuration property, best-effort.
   *
   * Standard's schema is Mapbox's to change, and a key it no longer recognises
   * throws rather than being ignored. A missing colour is a cosmetic loss; an
   * exception here would take down every layer added after it, so this swallows
   * and reports instead.
   */
  function setConfig(key, value) {
    try {
      map.setConfigProperty('basemap', key, value);
    } catch (error) {
      console.warn(`basemap config "${key}" unavailable:`, error.message ?? error);
    }
  }

  /**
   * The layer a campus overlay must be inserted below to stay under the road
   * ribbon. The casing is the lower of the two network layers, so anchoring to
   * `network-lines` would slip the ground cover between casing and core and
   * paint out the casing entirely.
   */
  function belowNetwork() {
    for (const id of ['network-casing', 'network-lines']) {
      if (map.getLayer(id)) return id;
    }
    return undefined;
  }

  /**
   * The layer to insert below to sit OVER the paths but still under the route.
   *
   * The closed block's outline is the one campus edge that wants this. my campus's
   * walkways run straight across the shape and, drawn under them, the boundary
   * came apart into four red segments with white paths laid over the gaps —
   * which reads as a shape you can walk through, the opposite of what the red
   * is there to say.
   *
   * Under the route regardless, for the reason the highlight is: nothing on
   * this map gets to bury the directions somebody is following.
   */
  function belowRoute() {
    for (const id of ['route-legs', 'route-casing', 'route-line']) {
      if (map.getLayer(id)) return id;
    }
    return undefined;
  }

  function addNetworkLayers() {
    const colors = palette(currentProvider, currentBasemap, currentTheme, currentSkin);

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

    if (!map.getSource('custom-network')) {
      map.addSource('custom-network', { type: 'geojson', data: customNetwork ?? EMPTY });
    }
    if (!map.getSource('calculated-route')) {
      map.addSource('calculated-route', { type: 'geojson', data: routeFeature() });
    }
    if (!map.getSource('route-legs')) {
      map.addSource('route-legs', { type: 'geojson', data: legsFeature() });
    }

    // The network is drawn the way Google draws a road: one source, two line
    // layers, the wider casing underneath. Added casing-first so insertion
    // order alone puts it below — both live in `middle`, and within a slot
    // Mapbox honours the order layers were added in.
    //
    // Round joins and caps on both. A square cap on the casing leaves a grey
    // nub sticking past the end of the white core at every dead end, which is
    // the tell that a network was drawn as two lines rather than as roads.
    if (!map.getLayer('network-casing')) {
      map.addLayer({
        id: 'network-casing',
        type: 'line',
        source: 'custom-network',
        slot: 'middle',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': colors.networkCasing,
          'line-width': NETWORK_CASING_WIDTH,
          // Gone at overview zooms, because the reference has no casing there
          // at all. A cut across a campus path on Apple at z16 is two pixels of
          // one flat tone with nothing but antialiasing at its edges; the
          // casing only appears once a path is wide enough to have edges worth
          // drawing, which is the same threshold the network itself inverts at.
          //
          // This is what made our campus read as a fractured surface where
          // theirs reads as blocks on a field. The casing is L 20.5 against
          // ground at L 31.7 — eleven points under it — so at the opening view
          // every footpath was a black seam, and there are a lot of footpaths.
          // The core stays: at L 28.4 on L 31.7 it is a three-point mark, which
          // is about the weight Apple's light path carries the other way up.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 16.2, 0, 16.8, 1],
          // Same reasoning as the mask and the sheet: without this the night
          // preset drags both halves of the ribbon toward the ground colour and
          // the casing stops separating anything.
          'line-emissive-strength': 1,
        },
      });
    } else {
      map.setPaintProperty('network-casing', 'line-color', colors.networkCasing);
    }

    if (!map.getLayer('network-lines')) {
      map.addLayer({
        id: 'network-lines',
        type: 'line',
        source: 'custom-network',
        // Every custom layer goes in `middle`, above the mask that hides
        // Mapbox's linework and below their labels, so place names outside the
        // campus stay readable over the top of nothing of ours.
        slot: 'middle',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': colors.network,
          'line-width': NETWORK_WIDTH,
          'line-emissive-strength': 1,
        },
      });
    } else {
      map.setPaintProperty('network-lines', 'line-color', colors.network);
    }

    // Dark casing under the route so it stays readable against pale buildings.
    // Dotted, in the route's own blue: a round cap on a zero-length dash draws
    // a circle, so `[0, 2]` is a row of dots rather than a dashed line. That is
    // the convention for "walk this bit yourself" on every map that has one.
    if (!map.getLayer('route-legs')) {
      map.addLayer({
        id: 'route-legs',
        type: 'line',
        source: 'route-legs',
        slot: 'middle',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': colors.route,
          'line-width': 5,
          'line-dasharray': [0, 2],
          'line-emissive-strength': 1,
        },
      });
    } else {
      map.setPaintProperty('route-legs', 'line-color', colors.route);
    }

    if (!map.getLayer('route-casing')) {
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'calculated-route',
        slot: 'middle',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': colors.casing, 'line-width': 12, 'line-opacity': 0.9 }
      });
    } else {
      map.setPaintProperty('route-casing', 'line-color', colors.casing);
    }

    if (!map.getLayer('route-line')) {
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'calculated-route',
        slot: 'middle',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': colors.route, 'line-width': 6 }
      });
    } else {
      map.setPaintProperty('route-line', 'line-color', colors.route);
    }

    // After the route layers rather than after the sheet it belongs to, and
    // only because of where its OUTLINE goes: belowRoute has to have a route
    // layer to name, and none of them exist until a few lines above this. The
    // wash still lands with the ground — the two halves carry their own
    // anchors, so building them late costs nothing.
    addClosedLayers();

    // Last, so the symbols and labels sit above the route rather than under it.
    addDirectoryLayers();
    addAmenityLayer();
    addCategoryLayer();
    addLabelLayers();

    if (navActive) addBuildingsLayer();

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
  // Navigation
  // -------------------------------------------------------------------------

  function startNavigation({ simulate = false } = {}) {
    if (!routeCoords || routeCoords.length < 2) return;

    navActive = true;
    stepIndex = 0;
    resetBannerAnimation();
    addBuildingsLayer();
    // The legend goes with the rest of the chrome here, and an outline with
    // nothing left on screen explaining it is just a purple campus. Same for a
    // lifted pin, whose card would float over the turn banner.
    clearLegendHighlight();
    deselectPin();

    document.body.classList.add('navigating');
    // Published so the sign can tell a simulated walk from a real one: the grid
    // behind it runs at double speed and gains a second, stationary layer to
    // drift against. See body.simulating in src/input.css.
    document.body.classList.toggle('simulating', simulate);
    sidePanel.classList.add('hidden');
    navBanner.classList.remove('hidden');
    navFooter.classList.remove('hidden');
    map.resize();

    // With the virtual location on, the control's blue dot IS the position —
    // same argument as the start pin, and the same answer: ours would be a
    // second dot sitting on the first. Removed rather than skipped, so a walk
    // begun with the fixture off and resumed with it on does not leave one
    // behind.
    if (geolocation.fixture) {
      userMarker?.remove();
    } else {
      if (!userMarker) {
        const dot = document.createElement('div');
        dot.className = 'user-dot';
        userMarker = new mapboxgl.Marker({ element: dot });
      }
      userMarker.setLngLat(routeCoords[0]).addTo(map);
    }

    // The locate control recentres on every fix while it holds the camera, and
    // navigation has a camera of its own — pitched to 60, zoomed in and turned
    // to face the walk. Dropping the control to background is the one gesture
    // that keeps the dot live and gives the camera up; it is what pressing its
    // button while locked on does. `locating` is the control's own state, kept
    // by its two track events rather than guessed at.
    if (locating) geolocateControl?.trigger();

    onUserMoved(routeCoords[0], { duration: 900 });

    if (simulate) startSimulation();
  }

  function endNavigation() {
    stopSimulation();
    if (!navActive) return;
    navActive = false;
    resetBannerAnimation();

    document.body.classList.remove('navigating');
    document.body.classList.remove('simulating');
    sidePanel.classList.remove('hidden');
    navBanner.classList.add('hidden');
    navFooter.classList.add('hidden');
    if (userMarker) userMarker.remove();
    removeBuildingsLayer();
    map.resize();

    // Flatten the pitched navigation camera and frame the whole campus again.
    map.fitBounds(CAMPUS_BOUNDS, {
      padding: campusPadding(), pitch: 0, bearing: 0, duration: 800,
    });
  }

  /**
   * Fold a new position into the navigation state. Position is snapped onto the
   * route line rather than to a network vertex — snapping to vertices would
   * make the dot jump between path endpoints instead of sliding along.
   */
  function onUserMoved(coords, { duration = SIM_TICK_MS } = {}) {
    if (!navActive || !routeLine) return;

    const snapped = nearestPointOnLine(routeLine, point(coords));
    const distanceAlong = snapped.properties.location;  // km travelled so far
    const here = snapped.geometry.coordinates;

    advanceSteps(distanceAlong);
    renderBanner(distanceAlong);
    moveCamera(here, distanceAlong, duration);
  }

  /** Retire every maneuver we have already walked past. */
  function advanceSteps(distanceAlong) {
    while (
      stepIndex < maneuvers.length - 1 &&
      cumulative[maneuvers[stepIndex].index] - distanceAlong < MANEUVER_REACHED_KM
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
    navStack.replaceChildren();
    liveCard = null;
    bannerBusy = false;
    renderedStep = -1;
  }

  /** One complete sign, cloned from the template. Each carries its own End. */
  function createSignCard() {
    const el = signTemplate.content.firstElementChild.cloneNode(true);
    el.querySelector('.nav-exit').addEventListener('click', endNavigation);
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
    navStack.querySelectorAll('.nav-sign--out').forEach((stale) => stale.remove());

    const incoming = createSignCard();
    paintStep(incoming, step, feetToStep, arrived);

    const outgoing = isFirst ? null : liveCard;
    if (outgoing) {
      // Taking it out of flow lets the incoming card land in the same box.
      outgoing.el.classList.remove('nav-sign--in', 'nav-sign--first');
      outgoing.el.classList.add('nav-sign--out');
    }

    incoming.el.classList.add(outgoing ? 'nav-sign--in' : 'nav-sign--first');
    navStack.appendChild(incoming.el);
    liveCard = incoming;
    bannerBusy = true;

    bannerTimers.push(setTimeout(() => {
      if (outgoing) outgoing.el.remove();
      incoming.el.classList.remove('nav-sign--in', 'nav-sign--first');
      bannerBusy = false;
    }, BANNER_SWAP_MS));
  }

  function renderBanner(distanceAlong) {
    const totalKm = cumulative[cumulative.length - 1];
    const step = maneuvers[stepIndex];

    const feetToStep = Math.max(0, (cumulative[step.index] - distanceAlong) * FEET_PER_KM);
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

    navRemaining.textContent = niceFeet(feetRemaining);
    const minutes = feetRemaining / WALK_FEET_PER_SEC / 60;
    navEta.textContent = minutes < 1 ? '< 1 min' : `${Math.round(minutes)} min`;
  }

  function moveCamera(here, distanceAlong, duration) {
    const totalKm = cumulative[cumulative.length - 1];

    // Aim a short way up the route so the heading is stable, but never past the
    // maneuver we are walking toward — looking beyond the corner would start
    // swinging the camera while you are still travelling straight at it.
    const nextManeuverKm = cumulative[maneuvers[stepIndex].index];
    const lookAheadKm = Math.min(distanceAlong + LOOK_AHEAD_KM, nextManeuverKm, totalKm);

    // Within a stride of the corner the aim point collapses onto us and the
    // bearing goes unstable, so hold the last good one until the step flips.
    if (lookAheadKm - distanceAlong > MIN_AIM_KM) {
      const ahead = along(routeLine, lookAheadKm);
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
    const totalKm = cumulative[cumulative.length - 1];
    const perTickKm =
      (WALK_FEET_PER_SEC * SIM_SPEED * (SIM_TICK_MS / 1000)) / FEET_PER_KM;
    const viaFixture = Boolean(geolocation.fixture);

    simTimer = setInterval(() => {
      simAlong = Math.min(simAlong + perTickKm, totalKm);
      const position = along(routeLine, simAlong).geometry.coordinates;
      if (viaFixture) {
        // The wedge points where the camera is already facing, which is the
        // direction of travel — onUserMoved works it out a stride ahead.
        geolocation.useFixture(position, { heading: lastBearing });
      } else {
        if (userMarker) userMarker.setLngLat(position);
        onUserMoved(position);
      }
      if (simAlong >= totalKm) stopSimulation();
    }, SIM_TICK_MS);
  }

  function stopSimulation() {
    if (simTimer) clearInterval(simTimer);
    simTimer = null;
  }

  // -------------------------------------------------------------------------

  // Mapbox Standard hides its layers behind a style package, so when something
  // looks wrong the only way to ask what the map actually built is from the
  // console. Dev builds only — Vite strips this branch from production.
  if (import.meta.env.DEV) {
    window.map = map;
    // Mapbox reports bad layer specs through this event rather than by throwing,
    // and the message is the only thing that says *which* property it rejected.
    map.on('error', (e) => console.error('map error:', e.error?.message ?? e));
  }

  // Which provider the layers currently on the map were built for. Compared
  // against the live value when a session resolves, so a toggle back to Mapbox
  // during the round trip cannot land Google's tiles on the Mapbox style.
  let groundGeneration = 0;
  // Assigned below, once the DOM refs are in hand. Declared here because the
  // failure path in addGoogleGround has to be able to put the button back.
  let providerControl = null;

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
    if (currentProvider !== 'google') return;
    const generation = ++groundGeneration;

    // Only while THIS request is the current one. A toggle away and back mints
    // a second session, and the first one resolving must not take the spinner
    // off a request that is still in flight — hence the generation check in the
    // finally rather than an unconditional clear.
    providerControl?.busy(true);
    try {
      const source = await googleGround({
        key: googleKey,
        basemap: currentBasemap,
        theme: currentTheme,
        // The raster has to wear the same look as the campus drawn on top of
        // it, or the mask edge becomes a seam between two design languages —
        // the same reason the theme is passed, one axis further out.
        skin: currentSkin,
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
      if (generation !== groundGeneration || currentProvider !== 'google') return;
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
      // A refused key is not a bug the user can see the shape of — the map just
      // stays empty. Google's own message names the cause (API not enabled,
      // referrer not allowed, key invalid), so it goes straight to the panel,
      // and the toggle drops back to a provider that works.
      console.error('Google basemap unavailable:', error);
      setStatus(`Google basemap unavailable: ${error.message}`, true);
      if (generation !== groundGeneration) return;
      currentProvider = 'mapbox';
      providerControl?.revert();
      syncBasemapStyle();
    } finally {
      // `revert()` above already repainted the buttons, and `busy(false)` calls
      // the same `paint()`, so the failure path is idempotent rather than
      // fighting itself.
      if (generation === groundGeneration) providerControl?.busy(false);
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
    benchLights = structuredClone(map.getLights() ?? null);
    styleBuilt = true;
    addNetworkLayers();
    addGoogleGround();
  });

  /**
   * Swap the basemap if the current provider/basemap/theme triple calls for a
   * different one. All three toggles route through here: on satellite the theme
   * no longer changes the Mapbox map, so this becomes a no-op and only the page
   * chrome restyles.
   */
  function syncBasemapStyle() {
    const nextKey = styleKey(currentProvider, currentBasemap, currentTheme, currentSkin);

    if (nextKey !== appliedStyleKey) {
      appliedStyleKey = nextKey;
      // Invalidate any session request still in flight for the outgoing style.
      groundGeneration++;
      // Nothing to configure between here and the next style.load: the layers
      // the bench writes to are about to stop existing. style.load sets it back.
      styleBuilt = false;
      // diff:false forces a full style reload. The default diffing path can
      // drop custom layers without firing style.load, leaving a bare basemap.
      // style.load re-adds our layers and re-requests the ground.
      map.setStyle(palette(currentProvider, currentBasemap, currentTheme, currentSkin).style, { diff: false });
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
    addNetworkLayers();
    if (map.getLayer('campus-buildings')) addBuildingsLayer();
  }

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
  const legendClose = document.getElementById('legend-close');
  const legendOpen = document.getElementById('layers-legend');
  const debugLegend = document.getElementById('debug-legend');
  // directionsBtn is declared up with the panels — setStatus can reach it first.
  const searchGo = document.getElementById('search-go');

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
    const want = routingEnabled ? force : false;
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
    if (phone.matches) toggleRoutePanel(false);
  }

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
  // the blue dot off at the exact moment it was asked for.
  let locating = false;

  const locateButton = () => document.querySelector('.mapboxgl-ctrl-geolocate');

  // Set only when WE were the ones who re-enabled that button, so switching the
  // fixture off puts it back the way the browser left it rather than leaving a
  // live-looking control that cannot work.
  let locateUnlocked = false;

  /**
   * Let the locate button be pressed even though the browser said no.
   *
   * The control asks for the geolocation permission while it sets itself up and
   * disables its own button when the answer is "denied". That is right, and it
   * stops being the question the moment the position is coming from a fixture
   * instead — somebody who once blocked location for this origin is exactly the
   * person who needs a way to see what the blue dot does. Without this the dot
   * can still be turned on from here, but the button beside it is dead, and the
   * button's own five states are half of the interface being looked at.
   */
  function unlockLocate(button) {
    if (!button.disabled) return;
    button.disabled = false;
    locateUnlocked = true;
  }

  function relockLocate() {
    if (!locateUnlocked) return;
    const button = locateButton();
    if (button) button.disabled = true;
    locateUnlocked = false;
  }

  /**
   * Start the locate control, once it is able to start.
   *
   * Waits for the BUTTON rather than calling `trigger()` and reading its
   * refusal. The control builds that button at the end of setting itself up,
   * and setting up waits on a permissions query which has not settled when a
   * page opened with the fixture already on reaches this point — so trigger()
   * would refuse, and warn, on every single reload with the switch on. Two
   * seconds of retries and then it gives up, rather than spinning forever.
   */
  function startLocating(attempt = 0) {
    // Before the map has loaded there is no control yet. The load handler calls
    // this again once there is, so nothing is lost by returning here.
    if (!geolocateControl || locating) return;
    const button = locateButton();
    if (!button) {
      if (attempt < 20) setTimeout(() => startLocating(attempt + 1), 100);
      return;
    }
    unlockLocate(button);
    geolocateControl.trigger();
  }

  function applyDebug({ open, routing, gps, blur }) {
    // Read by the next selection rather than applied to the current one: the
    // trail is made of animations that start when the pin is mounted, and there
    // is nothing sensible to do to a pin that is already standing still.
    pinBlur = open && blur;

    // The gate the lighting bench is read through. Set before anything else
    // here, so applyLighting sees the new state whichever path reaches it.
    debugOpen = open;
    applyLighting();

    // "Off by default" means off once you are in the back room, not off for
    // everybody: with the panel closed this is the app, and the app gives
    // directions. `open &&` is the whole of that guarantee, twice.
    routingEnabled = !open || routing;
    document.body.classList.toggle('no-routing', !routingEnabled);
    if (!routingEnabled) toggleRoutePanel(false);

    const fixture = open && gps;

    // A start that came from the fixture is a start with no marker — the dot was
    // the marker. Switching the fixture off takes the dot away and would leave a
    // route running from a point nothing on the map is drawing, so the route
    // goes with it. `startPoint && !startMarker` is that state exactly, and it
    // is the state itself rather than a flag kept alongside it.
    if (!fixture && startPoint && !startMarker) resetMap();

    // Where the position comes from, not whether the app is looking for one.
    // Switching the fixture off hands the watch already in flight back to the
    // real GPS rather than putting the dot away, which is the honest thing: it
    // shows you what the real one actually does from here.
    geolocation.useFixture(fixture ? CAMPUS_CENTRE : null);
    if (fixture) startLocating();
    else relockLocate();
  }

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
      blur: document.getElementById('debug-blur'),
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

  /** "6 buildings", "1 building · 22 zones · 5 outdoors", or nothing at all. */
  function countText(counts) {
    const parts = [];
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (counts.buildings) parts.push(plural(counts.buildings, 'building'));
    if (counts.zones) parts.push(plural(counts.zones, 'zone'));
    // Named rather than counted with the rest: these are the ones the outline
    // cannot speak for, and rolling them into "15 things" would hide that.
    if (counts.outside) parts.push(`${counts.outside} outdoors`);
    return parts.join(' · ');
  }

  function renderLegend() {
    legendList.replaceChildren(...CATEGORIES.map((category) => {
      const highlight = legendHighlights.get(category.id);
      const li = document.createElement('li');

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'g-legend-row';
      row.dataset.id = category.id;
      // A toggle, not a radio: the pressed row is a thing you turn off again,
      // and there is no fourth state for "none of them" to occupy.
      row.setAttribute('aria-pressed', String(activeCategory === category.id));
      // Both data files are still in flight at this point, and a row that
      // silently reports "Nothing found" reads as broken rather than as early.
      row.disabled = !legendReady;

      const glyph = document.createElement('span');
      glyph.className = 'g-icon g-legend-glyph';
      glyph.dataset.icon = category.glyph;

      const text = document.createElement('span');
      text.className = 'g-legend-text';
      const name = document.createElement('span');
      name.className = 'g-legend-name';
      // The category's own short label rather than the printed wording. This
      // row is a control now — the thing you press to find restrooms — and
      // "Restrooms" is what a control is called; the sheet's full phrasing
      // ("All-gender restroom") is the title, where it reads as a gloss.
      name.textContent = category.label;
      text.append(name);
      row.title = category.legend;

      // What the outline will do, printed before you ask for it. Absent until
      // the join has run, which is the only thing `highlight` being missing
      // ever means.
      if (highlight) {
        const count = document.createElement('span');
        count.className = 'g-legend-count';
        count.textContent = countText(highlight.counts);
        text.append(count);
      }

      row.append(glyph, text);
      row.addEventListener('click', () => selectCategory(category.id));
      // Focus counts as hover, so the whole thing works from the keyboard.
      row.addEventListener('mouseenter', () => previewLegendRow(category.id));
      row.addEventListener('focus', () => previewLegendRow(category.id));
      row.addEventListener('mouseleave', () => previewLegendRow(null));
      row.addEventListener('blur', () => previewLegendRow(null));

      li.append(row);
      return li;
    }));
    paintIcons(legendList);
  }

  /** The pressed state alone, for the paths that already redrew everything else. */
  function syncLegendRows() {
    for (const li of legendList.children) {
      const row = li.firstElementChild;
      row?.setAttribute('aria-pressed', String(row.dataset.id === activeCategory));
    }
  }

  /** Called once the overlays a category reads from have actually arrived. */
  function enableLegend() {
    legendReady = true;
    renderLegend();
  }

  /**
   * Point at a row and its answer arrives on the map.
   *
   * This used to outline ground in purple. It now does what pressing does, less
   * the parts that commit: the campus empties, the row's pins arrive on the
   * lift's spring with their names, and the whole thing is undone the moment the
   * pointer leaves. No results list, no camera move — a preview that flew the
   * map somewhere would make running an eye down eleven rows unusable, and the
   * pins land wherever they are, in view or not.
   *
   * Every row behaves this way, parking included. Its 22 outlined car parks were
   * a real answer, but its pins are a better one — a lot you can read the name
   * of beats a lot you can only see the shape of — and the permit machines that
   * belong to the same question have no shape on the sheet to outline at all.
   *
   * The reversal is the reason this is cheap enough to fire on mouseenter:
   * `choreography` cancels whatever is mid-flight and `fadeFrom` picks up the
   * opacity where the cancelled run left it, so dragging the pointer down the
   * column dissolves one set into the next instead of restarting eleven times.
   */
  function previewLegendRow(id) {
    if (hoverRow === id) return;
    hoverRow = id;
    // The outline goes with the pointer arriving, not with the pins landing:
    // shownRow drops it for the whole time a hover is up. See shownRow.
    paintHighlight();

    const category = id ? CATEGORY_BY_ID.get(id) : null;
    if (hoverCategory === (category?.id ?? null)) return;

    hoverCategory = category?.id ?? null;
    hoverHits = category ? hitsFor(category) : [];

    // Whichever direction this is: onto a row, off a row, or straight from one
    // row to the next. `shownCategory` has already been updated, so the only
    // question left is whether anything should be on the map when this settles.
    if (shownCategory()) playCategorySwap();
    else playCategoryClear();
  }

  /** Every half of the state, for the places the legend itself goes away. */
  function clearLegendHighlight() {
    // Through previewLegendRow rather than by nulling hoverRow, because a hover
    // now owns pins as well as the outline and the panel can close with the
    // pointer still on a row — a closing legend that left a preview behind would
    // strand a category on the map with nothing on screen naming it. Returns
    // immediately when there was no hover, so this costs nothing in the common
    // case and never plays a spurious animation.
    previewLegendRow(null);
    if (activeCategory) clearCategory();
    else { stickyRow = null; paintHighlight(); }
  }

  /**
   * Do the join, once, when the overlays that feed it have arrived.
   *
   * Every row is resolved up front rather than on first hover: the answer is
   * what the row prints under its caption, so it has to exist before anything
   * is pointed at, and eleven categories over 90 areas is a few milliseconds.
   */
  function buildLegendIndex() {
    legendAreas = buildAreas({
      directory: campusDirectory,
      buildings: campusBuildings,
      basemap: campusBasemap,
      zoneKinds: CATEGORIES.map((category) => category.zones).filter(Boolean),
    });
    legendHighlights.clear();
    for (const category of CATEGORIES) {
      legendHighlights.set(category.id, highlightFor(category, {
        areas: legendAreas,
        amenities: campusAmenities,
        places: campusPlaces,
      }));
    }
    renderLegend();
  }

  renderLegend();

  map.on('load', async () => {
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
      // A simulated walk pushes a new fix every SIM_TICK_MS, so the camera ease
      // has to finish inside one tick. At a second apiece every fix would
      // interrupt the last and the dot would slide along a route the camera
      // never catches up with.
      onUserMoved([e.coords.longitude, e.coords.latitude],
        { duration: simTimer ? SIM_TICK_MS : 1000 });
    });

    // What `locating` is kept in step with — see startLocating for why guessing
    // at it is not good enough. Both events are the control's own.
    geolocate.on('trackuserlocationstart', () => { locating = true; });
    geolocate.on('trackuserlocationend', () => { locating = false; });

    // A page reloaded with the debug fixture already set asked for the blue dot
    // before this control existed. It exists now.
    if (geolocation.fixture) startLocating();

    // All from the same server, so ask together. They are settled separately
    // because only the network is load-bearing: without it nothing can be
    // routed, whereas every overlay is decoration and its loss costs one layer.
    //
    // Said out loud while it happens, because until it settles the map is a
    // picture — and the hint under the distance is describing a gesture that
    // will not do anything yet. Eight requests over a phone connection is a
    // real wait, and the failure mode without this is somebody pressing and
    // holding on a map that has not finished arriving and concluding the app
    // is broken.
    setBusy(true);
    setStatus('Loading the campus…');
    const [networkResult, vertexResult, buildings, basemap, amenities, places, labels, directory] =
      await Promise.allSettled([
        fetchNetwork(),
        fetchVertices(),
        fetchOverlay('buildings'),
        fetchOverlay('basemap'),
        fetchOverlay('amenities'),
        fetchOverlay('places'),
        fetchOverlay('labels'),
        fetchOverlay('directory'),
      ]).finally(() => setBusy(false));

    if (buildings.status === 'fulfilled') {
      campusBuildings = buildings.value;
      if (navActive) addBuildingsLayer();
    } else {
      console.error(buildings.reason);
    }

    if (basemap.status === 'fulfilled') {
      // Trimmed to the campus on the way in. my campus's sheet carries the streets
      // around it, both north arrows and the trees along the verge, and every
      // one of those lands on a ground that is already drawing them — see
      // src/campus-clip.js.
      campusBasemap = trimToCampus(basemap.value, CAMPUS_RING);
      addBasemapLayers();
      // The sheet arriving is what this was waiting for — the closed block is
      // one of its shapes, so on a cold load style.load has already been and
      // gone with nothing for addClosedLayers to draw.
      addClosedLayers();
    } else {
      console.error(basemap.reason);
    }

    if (amenities.status === 'fulfilled') {
      // Named on the way in, the same way the labels are classified: only the
      // four amenities whose label identifies them keep one to print. See
      // withAmenityNames — the other eighty said the icon's own meaning, in
      // type, four times over on a single building.
      campusAmenities = withAmenityNames(amenities.value);
      addAmenityLayer();
    } else {
      console.error(amenities.reason);
    }

    if (places.status === 'fulfilled') {
      // The directory keeps the rows my campus lists without a room so a search index
      // can still be built from the file, but a null geometry is not something
      // a vector source can tile — drop them on the way in.
      campusPlaces = {
        type: 'FeatureCollection',
        features: places.value.features.filter((feature) => feature.geometry),
      };
      buildSearchIndex();
    } else {
      console.error(places.reason);
    }

    // A chip reads one or both of those two. Live as soon as either arrived —
    // a category over the surviving file is still a working category.
    if (campusAmenities || campusPlaces) {
      addCategoryLayer();
      enableLegend();
    }

    if (directory.status === 'fulfilled') {
      campusDirectory = directory.value;
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
    } else {
      console.error(directory.reason);
      // Nothing to list, so the section goes rather than sitting empty under a
      // heading. Its own hidden state, not the debug menu's — the rest of the
      // card is unaffected by a directory that failed to load.
      buildingsPanel.classList.add('hidden');
    }

    // Last of the five collections it reads, so this is where the legend stops
    // being a key and starts being a query. Degrades one source at a time: lose
    // directory.json and the outlines become per-footprint, lose the sheet and
    // Parking has no ground to paint, and every other row still answers.
    buildLegendIndex();

    if (labels.status === 'fulfilled') {
      // Classified on the way in rather than in the build script: which disc a
      // building name earns is presentation, and labels.json stays exactly what
      // my campus's cartographer set. See src/poi.js.
      // ...and the lots my campus never named get a marker before that runs, so the
      // generated ones and the printed ones are classified by the same pass and
      // cannot end up wearing different discs. The sheet is the source of the
      // shapes, and it has already been read a few branches up — if it failed
      // to arrive, withParkingMarks adds nothing and the five named lots still
      // get their P.
      campusLabels = withPoiIcons(withParkingMarks(labels.value, campusBasemap));
      addLabelLayers();
    } else {
      console.error(labels.reason);
    }

    if (networkResult.status === 'rejected') {
      console.error(networkResult.reason);
      setStatus('Routing server unreachable — is `npm run dev` still running?', true);
      return;
    }
    const routable = networkResult.value;

    // Snapping targets come from /api/vertices, which is the whole routing
    // graph. Falling back to the drawn network keeps clicks working on campus
    // if that one request fails — degraded, not broken: a start point outside
    // the fence would be dragged in to the nearest campus path.
    const vertices = vertexResult.status === 'fulfilled'
      ? vertexResult.value.vertices
      : [...new Map(routable.features
        .flatMap((f) => f.geometry.coordinates)
        .map((c) => [`${c[0]},${c[1]}`, c])).values()];
    if (vertexResult.status === 'rejected') console.error(vertexResult.reason);
    networkPoints = featureCollection(vertices.map(v => point(v)));

    // The moment a press-and-hold starts meaning something, and therefore the
    // moment it is honest to advertise one. Everything above this line has been
    // showing "Loading the campus…" over a map that could not be routed on.
    setStatus(idleHint());

    // Drawn only as far as the fence. my campus's driveways are drawn running out to
    // the public road, and past the boundary that white ribbon lands on top of
    // a road the basemap is already drawing. Cut rather than dropped, so a
    // driveway still reaches the gate instead of stopping at the junction
    // inside it — the route still runs the whole way, over their linework.
    customNetwork = trimToCampus(routable, CAMPUS_RING);

    map.getSource('custom-network').setData(customNetwork);
  });

  // -------------------------------------------------------------------------
  // Setting the two ends
  //
  // Both the map click and the search box arrive here, so a searched
  // destination and a clicked one behave identically from this point on.
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

  /**
   * Take the virtual location as the start, without drawing a start pin.
   *
   * ONE PIN, NOT TWO, and that is the whole point of it. With the fixture on
   * there is already a blue dot on the campus saying where you are, and the old
   * flow ignored it: the first click dropped a green Start marker somewhere else
   * and the second dropped the red one, so a map that knew your position still
   * made you tell it twice and then drew the answer in two places.
   *
   * Snapped to the network, because a fix lands wherever it lands and the router
   * walks between vertices. The blue dot stays where the GPS put it — moving it
   * onto the path would be the fixture lying about the position rather than the
   * router being honest about the graph.
   *
   * Returns whether it took. Nothing to adopt is a normal answer, not a failure:
   * the fixture is off, or the network has not landed yet.
   */
  function adoptFixtureStart() {
    const at = geolocation.fixture;
    if (!at || !networkPoints || !routingEnabled) return false;
    showRoutePanel();
    startPoint = point(nearestPoint(point(at), networkPoints).geometry.coordinates);
    // No marker. The dot is the marker — see above — and a green pin standing on
    // top of it would be the second pin this exists to remove.
    startMarker?.remove();
    startMarker = null;
    startCoordText.textContent = 'Your location';
    return true;
  }

  /** A start exists, adopting the virtual location if that is what is standing in. */
  const haveStart = () => Boolean(startPoint) || adoptFixtureStart();

  function placeStart(coords, label) {
    if (!routingEnabled) return;
    showRoutePanel();
    startPoint = point(coords);
    startMarker?.remove();
    startMarker = new mapboxgl.Marker({
      element: routePin(GOOGLE_GREEN, { title: 'Start' }),
      anchor: 'bottom',
      offset: liftedOffset(ROUTE_PIN_W),
    })
      .setLngLat(coords)
      .addTo(map);
    startCoordText.textContent = label ?? coordLabel(coords);
  }

  async function placeEnd(coords, label) {
    if (!routingEnabled) return;
    showRoutePanel();
    endPoint = point(coords);
    endMarker?.remove();
    endMarker = new mapboxgl.Marker({
      element: routePin(GOOGLE_RED, { title: 'Destination' }),
      anchor: 'bottom',
      offset: liftedOffset(ROUTE_PIN_W),
    })
      .setLngLat(coords)
      .addTo(map);
    endCoordText.textContent = label ?? coordLabel(coords);
    setStatus('Calculating route…');

    // Guard against a stale response landing after the user has moved on.
    const seq = ++requestSeq;
    let result;
    // The only wait in this app the user asked for directly. "Calculating
    // route…" has been the whole of the feedback here, and a sentence that does
    // not change cannot distinguish a server thinking from a server gone.
    setBusy(true);
    try {
      result = await requestRoute(startPoint.geometry.coordinates, coords);
    } catch (error) {
      console.error(error);
      setStatus('Routing server unreachable — is `npm run dev` still running?', true);
      endPoint = null;
      endMarker.remove();
      endMarker = null;
      return;
    } finally {
      setBusy(false);
    }
    if (seq !== requestSeq) return;

    if (!result) {
      setStatus('No path found between those two points.', true);
      distanceText.innerHTML = 'N/A';
      endPoint = null;
      endMarker.remove();
      endMarker = null;
      return;
    }

    routeCoords = result.geometry.coordinates;
    routeLine = lineString(routeCoords);
    cumulative = cumulativeDistances(routeCoords);
    maneuvers = result.maneuvers;
    stepIndex = 0;

    map.getSource('calculated-route').setData({
      type: 'Feature',
      geometry: result.geometry,
    });
    paintLegs();

    setDistanceFeet(result.distanceFeet);
    const turns = maneuvers.length - 2;
    setStatus(`Route calculated — ${turns} turn${turns === 1 ? '' : 's'}.`);
    setNavButtonsEnabled(true);

    // A walk that starts off campus does not fit the campus view it was planned
    // in, and half a route running off the top of the screen is the same bug as
    // a category whose pins are behind the panel. Same helper, so it leaves the
    // camera alone when the whole thing is already in front of you.
    frame(routeCoords, { maxZoom: 17 });
  }

  /**
   * Make a named point the destination, whichever list it was picked from.
   *
   * Shared by the search box and the category panel. Both can be used before a
   * start point exists, which is the case `pendingEnd` covers: the pin and the
   * label go down now, and the route is calculated the moment the next map
   * click supplies somewhere to walk from.
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

    // Both ends already set: start over rather than accumulating markers.
    if (startPoint && endPoint) resetMap();
    // Before the flyTo below, so the camera is framing the space the panel has
    // already taken rather than the space it is about to.
    showRoutePanel();

    // Searching for somewhere while the virtual location is on is a complete
    // question — from here, to that — so it routes rather than parking the
    // destination in `pendingEnd` and asking for a start that already exists.
    if (!startPoint) haveStart();

    if (!startPoint) {
      // Nothing to route yet, so the destination is the only thing worth
      // looking at. With a start point already down the camera belongs to the
      // route instead, and placeEnd frames it — flying here first would land on
      // the destination at z17, then test the route against the view it had
      // *before* the flight, decide it was already visible, and leave half the
      // walk off the top of the screen. Which is exactly what it did.
      // Padding stated rather than inherited: showRoutePanel above started a
      // 300 ms padding ease, and a flight that did not carry its own would
      // interrupt that ease and keep whatever partial value it had reached.
      map.flyTo({
        center: coords,
        zoom: Math.max(map.getZoom(), 17),
        padding: campusPadding(),
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
      endCoordText.textContent = name;
      setStatus(`${name} — now click the map to set where you are starting from.`);
      return;
    }
    await placeEnd(coords, name);
  }

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
    if (navActive) return;
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
    if (navActive || !networkPoints) return;
    // The release at the end of a press-and-hold. That gesture has already done
    // its work; without this the same finger would drop a route point and then
    // immediately clear the selection on the way back up.
    if (swallowClick) { swallowClick = false; return; }

    // A tap on a pin lifts it rather than dropping a second one beside it.
    // Tested before buildings because pins sit on top of them and half of them
    // are inside one — a defibrillator tapped through the Library's footprint
    // would otherwise open the Library.
    // A tap on a pin lifts it. If that pin is a building's own name, the
    // building card is the better thing to put beside it, so the lift happens
    // without the small one and the existing card path runs underneath.
    const pin = pinAt(e.point);
    if (pin) {
      const named = pin.text ? buildingAt(e.point) : null;
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
    if (activeCategory) { clearCategory(); return; }

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
  // Press and hold, the way Apple Maps does it, rather than on a plain tap.
  //
  // A tap used to place a start or an end, and it was the wrong gesture for a
  // map at this zoom: the two things a finger most wants to do to a campus are
  // "what is that" and "get closer", and both of them were spending a route
  // marker to find out. Double-tapping to zoom in was actively broken by it —
  // the first tap dropped a start point, the second dropped an end point, and
  // the map zoomed while drawing a route between two places nobody chose.
  //
  // Making the deliberate thing deliberate fixes both at once. A tap is now
  // free to mean "tell me about this", a double-tap is free to mean "closer",
  // and the one gesture that changes state is the one you have to mean.
  // -------------------------------------------------------------------------

  /** How long the press has to be held. Apple's own is around half a second. */
  const LONG_PRESS_MS = 500;

  /**
   * ...and how far the finger may travel first, in px.
   *
   * Generous, because this is competing with dragging the map and the two are
   * told apart by intent rather than by distance: somebody panning moves a long
   * way immediately, and somebody holding still on a phone in one hand wobbles
   * by a few pixels the whole time. Under about 8 the gesture is unusable while
   * walking, which is the condition this app is used in.
   */
  const LONG_PRESS_SLOP = 10;

  let pressTimer = 0;
  let pressAt = null;
  let swallowClick = false;

  /** The growing ring under the finger. Removed by whichever end comes first. */
  let pressRing = null;

  function endPress() {
    clearTimeout(pressTimer);
    pressTimer = 0;
    pressAt = null;
    pressRing?.remove();
    pressRing = null;
  }

  /**
   * What a completed hold does, which is what a tap used to do.
   *
   * Lifted out of the click handler unchanged — the ordering here is load
   * bearing and was worked out over several rounds of the routing UI, so it is
   * moved rather than rewritten.
   */
  async function dropRoutePoint(lngLat) {
    const clicked = point([lngLat.lng, lngLat.lat]);
    // Snapping the click locally keeps the marker instant; the server snaps
    // again on its own side, and lands on the same vertex.
    const snapped = nearestPoint(clicked, networkPoints).geometry.coordinates;

    // Both ends already set: start over rather than accumulating markers.
    if (startPoint && endPoint) resetMap();

    // With the virtual location on, every press is a destination — you are
    // already standing somewhere and the dot says where. Asked here rather than
    // baked into placeStart so an explicit "Start here" on a building's card
    // still overrides it: that is somebody saying they want to leave from
    // somewhere other than where they are, which is a real thing to want.
    if (!startPoint && haveStart()) {
      await placeEnd(snapped);
      return;
    }

    if (!startPoint) {
      placeStart(snapped);
      // A destination picked before a start has been waiting for exactly this.
      if (pendingEnd) {
        const { coords, name } = pendingEnd;
        pendingEnd = null;
        await placeEnd(coords, name);
      } else {
        setStatus('Great! Now press and hold to set an end point.');
      }
      return;
    }

    await placeEnd(snapped);
  }

  function beginPress(e) {
    if (navActive || !networkPoints) return;
    endPress();
    // A new gesture starts clean. This is also the recovery path for a hold
    // that ended without a click at all — a finger lifted over the sidebar, or
    // outside the window — where the flag would otherwise still be set and
    // would eat the next real tap.
    swallowClick = false;
    pressAt = e.point;

    // Feedback, and it is not decoration: a gesture with no visible response
    // until it has already fired is a gesture nobody discovers. The ring grows
    // for exactly as long as the hold lasts, so the animation IS the progress
    // bar — let go early and you can see you let go early.
    pressRing = document.createElement('div');
    pressRing.className = 'g-press-ring';
    pressRing.style.left = `${e.point.x}px`;
    pressRing.style.top = `${e.point.y}px`;
    pressRing.style.animationDuration = `${LONG_PRESS_MS}ms`;
    map.getContainer().append(pressRing);

    pressTimer = window.setTimeout(() => {
      endPress();
      // Set before the call, not after: dropRoutePoint is asynchronous and the
      // finger comes up long before it settles, so a flag set on the far side
      // of it would be set after the click it exists to swallow.
      //
      // Cleared by that click, or by the next press if none arrives. NOT on a
      // timer — the fire happens while the finger is still down, and there is
      // no upper bound on how long somebody holds it there, so any timeout
      // short enough to be useful is one a slow hand beats.
      swallowClick = true;
      // A hold does not clear a category or open a building the way a tap does
      // — it is a different gesture and means only one thing.
      dropRoutePoint(e.lngLat);
    }, LONG_PRESS_MS);
  }

  map.on('mousedown', (e) => {
    // Left button only. A right-press is the context menu, and on a trackpad a
    // two-finger press arrives here as button 2 while the hand is still.
    if (e.originalEvent.button === 0) beginPress(e);
  });
  map.on('touchstart', (e) => {
    // One finger. Two is a pinch or a two-finger rotate, and both of those are
    // held still for a moment at the start.
    if (e.points.length === 1) beginPress(e);
  });

  // Any travel past the slop is a drag, and a drag is panning.
  for (const moved of ['mousemove', 'touchmove']) {
    map.on(moved, (e) => {
      if (!pressAt) return;
      const at = e.point ?? e.points?.[0];
      if (at && Math.hypot(at.x - pressAt.x, at.y - pressAt.y) > LONG_PRESS_SLOP) endPress();
    });
  }

  // Every way a press can stop being one. `dragstart` and `zoomstart` are not
  // redundant with the movement test above: a momentum pan or a pinch can move
  // the map without the pointer itself travelling anywhere.
  for (const over of ['mouseup', 'touchend', 'touchcancel', 'dragstart', 'zoomstart']) {
    map.on(over, endPress);
  }

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
  // -------------------------------------------------------------------------

  const searchInput = document.getElementById('place-search');
  const searchResults = document.getElementById('place-results');
  const searchClear = document.getElementById('place-clear');

  const MAX_RESULTS = 8;
  // Built once from the committed artifact, which is static — unlike the place
  // index below, which waits on a fetch.
  const roomIndex = buildRoomIndex(roomsData);
  let searchIndex = [];
  let searchHits = [];
  let activeHit = -1;

  const normalise = (s) => (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  function buildSearchIndex() {
    // my campus lists a class like "Defibrillator" once per node, which build-places
    // splits into one feature each. Six identical rows in a result list is
    // noise, so they collapse to one entry holding every position.
    const groups = new Map();
    for (const feature of campusPlaces.features) {
      const { name, description } = feature.properties;
      const group = groups.get(name) ?? { name, description, points: [] };
      group.points.push(feature.geometry.coordinates);
      groups.set(name, group);
    }
    searchIndex = [...groups.values()].map((group) => ({
      ...group,
      nameKey: normalise(group.name),
      haystack: normalise(`${group.name} ${group.description ?? ''}`),
    }));
    searchInput.disabled = false;
  }

  /** 0 when a term is absent. Higher is a better place for it to have matched. */
  function scoreTerm(entry, term) {
    if (entry.nameKey === term) return 100;
    if (entry.nameKey.startsWith(`${term} `) || entry.nameKey === term) return 80;
    if (entry.nameKey.split(' ').some((w) => w.startsWith(term))) return 60;
    if (entry.nameKey.includes(term)) return 35;
    if (entry.haystack.includes(term)) return 12;
    return 0;
  }

  /**
   * Rooms and courses first, then places.
   *
   * Ahead rather than interleaved, and not because they score higher — they are
   * not scored at all. Typing "320" or "ACCT 101" is a different kind of act
   * from typing "library": it is a lookup with a right answer, and the place
   * index cannot produce that answer at any score because it has never heard of
   * a room. Ranking them together would let a fuzzy name match on some place
   * whose description happens to contain "320" outrank the room itself.
   *
   * They still share the budget, so a query that is both — "STEM 213" is a
   * building with that room AND a course code — cannot bury the ordinary
   * results entirely.
   */
  function runSearch(query) {
    const rooms = lookupRoom(query, roomIndex).slice(0, MAX_RESULTS - 2);
    const terms = normalise(query).split(' ').filter(Boolean);
    if (!terms.length) return rooms;
    const scored = [];
    for (const entry of searchIndex) {
      let total = 0;
      // Every term has to land somewhere, so "student center" cannot match a
      // row that only has "student".
      for (const term of terms) {
        const score = scoreTerm(entry, term);
        if (!score) { total = 0; break; }
        total += score;
      }
      // Shorter names break ties, so "Library" beats "Lockers for Library".
      if (total) scored.push({ entry, score: total - entry.nameKey.length / 1000 });
    }
    const places = scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
    return [...rooms, ...places].slice(0, MAX_RESULTS);
  }

  function closeResults() {
    searchResults.classList.add('hidden');
    searchResults.replaceChildren();
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
    searchHits = [];
    activeHit = -1;
  }

  function highlight(index) {
    activeHit = index;
    [...searchResults.children].forEach((li, i) => {
      // `aria-selected` alone: the stylesheet draws the highlight off it, so
      // the accessible state and the visible one cannot disagree.
      li.setAttribute('aria-selected', String(i === index));
    });
    if (index >= 0) {
      searchInput.setAttribute('aria-activedescendant', `place-result-${index}`);
      searchResults.children[index]?.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderResults(hits) {
    searchHits = hits;
    if (!hits.length) { closeResults(); return; }
    searchResults.replaceChildren(...hits.map((entry, i) => {
      const li = document.createElement('li');
      li.id = `place-result-${i}`;
      li.setAttribute('role', 'option');
      const name = document.createElement('div');
      name.className = 'g-result-name';
      name.textContent = entry.name;
      li.append(name);
      // Only worth a second line when it says something the name did not.
      const hint = entry.points.length > 1
        ? `${entry.points.length} locations`
        : entry.description;
      if (hint) {
        const sub = document.createElement('div');
        sub.className = 'g-result-sub';
        sub.textContent = hint;
        li.append(sub);
      }
      li.addEventListener('mousedown', (event) => {
        // mousedown, not click: blur would close the list first.
        event.preventDefault();
        chooseDestination(entry);
      });
      return li;
    }));
    searchResults.classList.remove('hidden');
    searchInput.setAttribute('aria-expanded', 'true');
    highlight(0);
  }

  /** The instance of a multi-location entry nearest whatever we can measure from. */
  function nearestInstance(entry) {
    if (entry.points.length === 1) return entry.points[0];
    const from = startPoint?.geometry.coordinates ?? map.getCenter().toArray();
    return entry.points.reduce((best, candidate) => (
      distance(point(candidate), point(from)) < distance(point(best), point(from))
        ? candidate : best
    ));
  }

  async function chooseDestination(entry) {
    // A row with nowhere to go: a class at the Natomas centre, or outdoor PE,
    // which the sheet draws as four separate fields. Both are real answers and
    // both are shown; neither can be routed to, so the panel says why instead
    // of dropping a pin somewhere defensible-looking.
    if (!entry.points.length) {
      searchInput.value = entry.name;
      searchClear.classList.remove('hidden');
      closeResults();
      setStatus(entry.spread
        ? `${entry.name} is ${entry.spread} — no single place to route to.`
        : `${entry.name} is at ${entry.place}, which is not on this campus.`, true);
      return;
    }
    const coords = nearestInstance(entry);
    searchInput.value = entry.name;
    searchClear.classList.remove('hidden');
    closeResults();
    searchInput.blur();
    await setDestination(coords, entry.name);
  }

  searchInput.addEventListener('input', () => {
    searchClear.classList.toggle('hidden', !searchInput.value);
    renderResults(runSearch(searchInput.value));
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeResults(); return; }
    if (!searchHits.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlight((activeHit + 1) % searchHits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight((activeHit - 1 + searchHits.length) % searchHits.length);
    } else if (event.key === 'Enter' && activeHit >= 0) {
      event.preventDefault();
      chooseDestination(searchHits[activeHit]);
    }
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value) renderResults(runSearch(searchInput.value));
  });
  searchInput.addEventListener('blur', () => setTimeout(closeResults, 0));

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.add('hidden');
    closeResults();
    searchInput.focus();
  });
}
