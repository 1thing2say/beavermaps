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
} from './map-images.js';
import { buildingCard, pinCard } from './building-popup.js';
import {
  mountSelectedPin, sizeExpr, sizeAt, LABEL_MAX_EM,
  AMBIENT_SIZE, CATEGORY_SIZE, LABEL_SIZE,
  growEase, swayAt, scaleStops, GROW_MS, SWAY_MS,
} from './pin-select.js';
import { createThemeControl, preferredTheme, applyThemeAttribute } from './theme.js';
import { createBasemapToggle, preferredBasemap } from './basemap.js';
import { createProviderToggle, preferredProvider } from './provider.js';
import { createSkinControl, preferredSkin, applySkinAttribute } from './skin.js';
import { googleGround } from './google-tiles.js';
import { paintIcons } from './g-icons.js';
import { CATEGORIES, CATEGORY_BY_ID, collect } from './categories.js';
import {
  withPoiIcons, withAmenityNames, POI_LABEL_KINDS, AMENITY_ZOOM, AMENITY_ZOOM_DEFAULT,
} from './poi.js';
import { ringOf, trimToCampus } from './campus-clip.js';
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

  // Banner transition state
  let renderedStep = -1;
  let bannerBusy = false;
  let bannerTimers = [];
  let liveCard = null;      // the sign currently showing; owns the countdown

  // GUI Elements
  const instructionText = document.getElementById('instruction-text');
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
    instructionText.textContent = message;
    // One class rather than the five Tailwind toggles this used to need. The
    // hint's normal and error colours are both stated in the stylesheet, so
    // there is no specificity race between a muted class and a red one.
    instructionText.classList.toggle('is-error', isError);
  }

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
    setStatus("Click on the map to set a start point.");
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
        'fill-extrusion-emissive-strength': 0.75,
      },
    }, 'route-casing');
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

  const groundWidth = (floor) => [
    'interpolate', ['exponential', 2], ['zoom'],
    // The floor keeps the thinnest paths from disappearing when zoomed out,
    // where true width would put them below a pixel.
    14, ['max', floor, ['*', ['coalesce', ['get', 'width'], 1.65], 2 ** 14 / M_PER_PIXEL_AT_Z0]],
    20, ['max', floor, ['*', ['coalesce', ['get', 'width'], 1.65], 2 ** 20 / M_PER_PIXEL_AT_Z0]],
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
      for (const id of ['campus-sheet-line', 'campus-sheet-fill']) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      return;
    }

    const fillColour = sheetPaint(land, 'fill');
    // Strokes that are ground read as ground; the rest keep my campus's ink. Building
    // outlines follow the theme so they agree with the footprints drawn on top.
    const lineColour = sheetPaint(
      { walkway: land.walkway, driveway: land.driveway, offsite_road: land.offsite_road, crossing: land.crossing },
      'stroke',
      { building: colors.buildingLine, bleachers: colors.buildingLine, sport: colors.sportLine },
    );

    if (map.getLayer('campus-sheet-fill')) {
      map.setPaintProperty('campus-sheet-fill', 'fill-color', fillColour);
      map.setPaintProperty('campus-sheet-line', 'line-color', lineColour);
      return;
    }
    if (!campusBasemap) return; // still in flight; addNetworkLayers re-runs

    if (!map.getSource('campus-sheet')) {
      map.addSource('campus-sheet', { type: 'geojson', data: campusBasemap });
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
      filter: ['all', visible, ['has', 'fill']],
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
      filter: ['all', visible, ['has', 'stroke']],
      layout: { 'line-sort-key': ['get', 'i'], 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': lineColour,
        'line-width': groundWidth(0.4),
        'line-opacity': ['coalesce', ['get', 'opacity'], 1],
        'line-emissive-strength': 1,
      },
    }, anchor);
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
   * A hovered row wins over the selected one, and gives it back on the way out.
   *
   * Two variables rather than one because a preview has to be undoable: hover
   * "Defibrillator" while "Parking" is selected and the car parks come back the
   * moment the pointer leaves, without the selection ever having been touched.
   */
  const shownRow = () => hoverRow ?? stickyRow;

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
    loadAmenityIcons(map).then(() => {
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
          'text-size': 11,
          'text-anchor': 'top',
          'text-offset': [0, 0.85],
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
    loadAmenityIcons(map).then(() => {
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
          'text-size': 12,
          // Under the disc, and far enough under to clear its lower half —
          // the anchor point is the coordinate and the disc is centred on it.
          'text-anchor': 'top',
          'text-offset': [0, 0.95],
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
    const active = Boolean(activeCategory);

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
      features: categoryHits.map((hit) => ({
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
      if (!map.getLayer(layer)) return;
      map.setLayoutProperty(layer, 'icon-size', base);
      map.setPaintProperty(layer, 'icon-translate', [0, 0]);
      map.setPaintProperty(layer, 'icon-opacity', 1);
      map.setPaintProperty(layer, 'text-opacity', 1);
    };
    if (prefersStill()) { settle(); return; }

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
    if (activeCategory && POI_LABEL_KINDS.has(kind)) return ['boolean', false];
    const mine = ['==', ['get', 'kind'], kind];
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
      from,
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

  function selectCategory(id) {
    const category = CATEGORY_BY_ID.get(id);
    if (!category) return;

    // Pressing the pressed chip is how you get back to the whole map.
    if (activeCategory === id) { clearCategory(); return; }

    activeCategory = id;
    const found = collect(category, { amenities: campusAmenities, places: campusPlaces });

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
    categoryHits = found
      .map((hit) => ({ ...hit, feet: feetFrom(hit.coords) }))
      .sort((a, b) => a.feet - b.feet);

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
   * Only the ones that HAVE a disc, though — an area name or a car park number
   * has no marker to agree with, so those keep the map's own ink.
   */
  const labelPaint = (kind, colors) => (POI_LABEL_KINDS.has(kind)
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
   * Put a card in the left column, or take whatever is there away.
   *
   * One panel for both kinds — a building's card and a pin's — because from the
   * map they are one gesture: you tapped a thing, and this is the thing. The
   * two used to be separate Mapbox popups anchored to what they described,
   * which is why opening the LRC covered the campus with a list of what is
   * inside the LRC. The tie to the marker survives without the anchor: the pin
   * itself is lifted and stays lifted for as long as this is up.
   */
  function showPlaceCard(card) {
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

  function showBuildingCard(raw) {
    // Vector tiles hand nested properties back as JSON strings.
    const props = { ...raw };
    for (const key of ['contents', 'facilities', 'parts', 'entrance', 'anchor']) {
      if (typeof props[key] === 'string') {
        try { props[key] = JSON.parse(props[key]); } catch { delete props[key]; }
      }
    }

    showPlaceCard(buildingCard(props, {
      onStart: (coords, name) => {
        if (startPoint && endPoint) resetMap();
        clearSelection();
        placeStart(coords, name);
        setStatus(`Start set at ${name}. Now pick a destination.`);
      },
      onEnd: async (coords, name) => {
        clearSelection();
        if (!startPoint) {
          pendingEnd = { coords, name };
          showRoutePanel();
          setStatus(`${name} set as the destination. Click the map to set a start point.`);
          return;
        }
        if (endPoint) resetMap0(coords, name);
        else await placeEnd(coords, name);
      },
      onClose: clearSelection,
    }));
    highlightBuilding(props.officialName);
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
    loadAmenityIcons(map)
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
          'text-field': ['get', 'text'],
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
          'text-letter-spacing': area ? 0.07 : 0,
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
    setConfig('lightPreset', colors.lightPreset);
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

    // Last, so the symbols and labels sit above the route rather than under it.
    addDirectoryLayers();
    addAmenityLayer();
    addCategoryLayer();
    addLabelLayers();

    if (navActive) addBuildingsLayer();
    map.getCanvas().style.cursor = 'crosshair';
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
    sidePanel.classList.add('hidden');
    navBanner.classList.remove('hidden');
    navFooter.classList.remove('hidden');
    map.resize();

    if (!userMarker) {
      const dot = document.createElement('div');
      dot.className = 'user-dot';
      userMarker = new mapboxgl.Marker({ element: dot });
    }
    userMarker.setLngLat(routeCoords[0]).addTo(map);

    onUserMoved(routeCoords[0], { duration: 900 });

    if (simulate) startSimulation();
  }

  function endNavigation() {
    stopSimulation();
    if (!navActive) return;
    navActive = false;
    resetBannerAnimation();

    document.body.classList.remove('navigating');
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

  function startSimulation() {
    stopSimulation();
    simAlong = 0;
    const totalKm = cumulative[cumulative.length - 1];
    const perTickKm =
      (WALK_FEET_PER_SEC * SIM_SPEED * (SIM_TICK_MS / 1000)) / FEET_PER_KM;

    simTimer = setInterval(() => {
      simAlong = Math.min(simAlong + perTickKm, totalKm);
      const position = along(routeLine, simAlong).geometry.coordinates;
      if (userMarker) userMarker.setLngLat(position);
      onUserMoved(position);
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
    }
  }

  // Fires on first load *and* after every setStyle, which is exactly when the
  // custom layers need rebuilding.
  map.on('style.load', () => {
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
    addNetworkLayers();
    if (map.getLayer('campus-buildings')) addBuildingsLayer();
  }

  // No `cycle` any more: that was the rail's one-glyph version of this, which
  // had to guess a next value because a rail button has room for one word. The
  // layers menu asks the question outright, three buttons for three answers.
  createThemeControl({
    group: themeModes,
    onChange: (theme) => {
      currentTheme = theme;
      syncBasemapStyle();
    },
  });

  createBasemapToggle({
    button: basemapToggle,
    icon: basemapIcon,
    label: basemapLabel,
    onChange: (basemap) => {
      currentBasemap = basemap;
      syncBasemapStyle();
    },
  });

  // Last of the three, so that its initial onChange — which can start a session
  // request — runs after the theme and basemap have published their own state.
  providerControl = createProviderToggle({
    // One door now. `surfaces` stays a list because the control genuinely
    // supports several and the second was the rail's; nothing about the state
    // behind it changed when that went.
    surfaces: [
      { button: providerToggle, icon: providerIcon, label: providerLabel },
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
    const was = !sidePanel.classList.contains('hidden');
    const open = toggleSheet(sidePanel, directionsBtn, force);
    directionsBtn.setAttribute('aria-label', open ? 'Hide directions' : 'Directions');
    if (open !== was) map.easeTo({ padding: campusPadding(), duration: 300 });
    return open;
  }

  /**
   * Bring the route panel up because something needs to be read in it.
   *
   * The panel starts closed, which means every message this app writes about a
   * route — the distance, "Now click to set an end point", a routing server
   * that is down — is being written into a hidden card. Anything that sets an
   * endpoint or reports an error opens it first, so the panel appears at the
   * moment it acquires something to say and not before.
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

  legendOpen.addEventListener('click', () => {
    toggleSheet(layersMenu, layersBtn, false);
    const open = toggleLegendPanel();
    if (!open) { clearLegendHighlight(); return; }
    // On the phone these two are alternatives, not a stack: both at once is a
    // sheet over two thirds of the screen with three legend rows showing, and a
    // campus squeezed into the strip above it.
    if (phone.matches) toggleRoutePanel(false);
  });

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
  // The legend, which is also the query
  //
  // Generated from src/categories.js, so the key and what it finds cannot
  // disagree about what this map's symbols mean.
  //
  // This list and the chip strip used to be two controls. They were built from
  // the same twelve rows in the same order with the same pictograms, and the
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
  //   puts back whatever was selected — so running an eye down twelve rows
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

  function previewLegendRow(id) {
    if (hoverRow === id) return;
    hoverRow = id;
    paintHighlight();
  }

  /** Both halves of the state, for the places the legend itself goes away. */
  function clearLegendHighlight() {
    hoverRow = null;
    if (activeCategory) clearCategory();
    else { stickyRow = null; paintHighlight(); }
  }

  /**
   * Do the join, once, when the overlays that feed it have arrived.
   *
   * Every row is resolved up front rather than on first hover: the answer is
   * what the row prints under its caption, so it has to exist before anything
   * is pointed at, and twelve categories over 90 areas is a few milliseconds.
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
    const geolocate = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    });
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
    geolocate.on('geolocate', (e) => {
      onUserMoved([e.coords.longitude, e.coords.latitude], { duration: 1000 });
    });

    map.getCanvas().style.cursor = 'crosshair';

    // All from the same server, so ask together. They are settled separately
    // because only the network is load-bearing: without it nothing can be
    // routed, whereas every overlay is decoration and its loss costs one layer.
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
      ]);

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
    } else {
      console.error(directory.reason);
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
      campusLabels = withPoiIcons(labels.value);
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

  function placeStart(coords, label) {
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
    try {
      result = await requestRoute(startPoint.geometry.coordinates, coords);
    } catch (error) {
      console.error(error);
      setStatus('Routing server unreachable — is `npm run dev` still running?', true);
      endPoint = null;
      endMarker.remove();
      endMarker = null;
      return;
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
    // Both ends already set: start over rather than accumulating markers.
    if (startPoint && endPoint) resetMap();
    // Before the flyTo below, so the camera is framing the space the panel has
    // already taken rather than the space it is about to.
    showRoutePanel();

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
  // "open this", not "drop a point here", and the crosshair says the wrong one.
  //
  // One query across all three rather than pinAt() and buildingAt() in turn:
  // this runs on every mouse move, and three hit tests a frame to decide the
  // shape of a cursor is three times the work the answer is worth.
  const POINTER_LAYERS = ['category-pins', 'campus-amenities', 'campus-directory-hit'];
  map.on('mousemove', (e) => {
    if (navActive) return;
    const layers = POINTER_LAYERS.filter((id) => map.getLayer(id));
    const over = layers.length > 0 && map.queryRenderedFeatures(e.point, { layers }).length > 0;
    map.getCanvas().style.cursor = over ? 'pointer' : 'crosshair';
  });

  // Esc puts a selection back, which is the one thing every card on every map
  // agrees on. Both halves of it: a tap on a footprint opens a card without
  // lifting anything, so an Esc that only put pins down would leave that one up.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSelection();
  });

  map.on('click', async (e) => {
    if (navActive || !networkPoints) return;

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
    // building card and the route below. One tap should do one thing, and a tap
    // that both cleared the restrooms and opened whatever building was behind
    // them would leave the map in a state nobody asked for. The second tap gets
    // the building.
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

    const clicked = point([e.lngLat.lng, e.lngLat.lat]);
    // Snapping the click locally keeps the marker instant; the server snaps
    // again on its own side, and lands on the same vertex.
    const snapped = nearestPoint(clicked, networkPoints).geometry.coordinates;

    // Both ends already set: start over rather than accumulating markers.
    if (startPoint && endPoint) resetMap();

    if (!startPoint) {
      placeStart(snapped);
      // A destination picked before a start has been waiting for exactly this.
      if (pendingEnd) {
        const { coords, name } = pendingEnd;
        pendingEnd = null;
        await placeEnd(coords, name);
      } else {
        setStatus('Great! Now click to set an end point.');
      }
      return;
    }

    await placeEnd(snapped);
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
