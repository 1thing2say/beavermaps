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
import { loadAmenityIcons, loadLabelPlate } from './map-images.js';
import { buildingCard } from './building-popup.js';
import { createThemeToggle, preferredTheme, applyThemeAttribute } from './theme.js';
import { createBasemapToggle, preferredBasemap } from './basemap.js';

const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

// Mapbox Standard rather than the classic light-v11/dark-v11 pair. Standard is
// a style *package*: its internal layers are not addressable, so nothing here
// can call removeLayer or setFilter on the basemap. What it gives back is a
// configuration API and named slots to insert into, which is what the campus
// mask below is built on.
//
// It also collapses light and dark into one style under two light presets, so
// the theme toggle is now a config change rather than a setStyle. Custom
// sources and layers survive it instead of being rebuilt.
const STANDARD = 'mapbox://styles/mapbox/standard';

// Per-theme layer colours. #4b5a74 is the slate that ties the map back to the
// banner grid.
// The network colours are deliberately off-grey. Both basemaps draw their own
// roads, parking aisles and label text in mid-grey, and this campus is almost
// blank on Mapbox's own data, so a grey network is unreadable: it merges with
// the basemap's linework and there is nothing left to judge it against. Giving
// it a hue of its own is what makes it legible as *our* data.
//
// `mask` is the colour painted over the campus once Mapbox's own data inside it
// has been taken out. It is deliberately a shade off the surrounding land
// rather than an exact match: matching exactly would make the campus look like
// a hole where the map failed to load, and would drift the moment Mapbox
// retunes Standard.
//
// These render as authored only because the mask sets fill-emissive-strength.
// Without it Standard lights the fill through its own lighting model, and under
// the `night` preset that swallowed it: an authored #141922 came back as
// #0e111d, and raising the authored value threefold moved the rendered pixel by
// about a tenth — so it is not a multiply that can be pre-compensated for. The
// fix belongs in the paint spec, not in these numbers.
//
// `land` recolours the printed my campus sheet. It is keyed by the `kind` written by
// scripts/build-basemap.mjs, and a kind with no entry here keeps my campus's own print
// colour, which is the right fallback for the things that have no theme opinion
// — court markings, sign faces, the HOME BASE badges — and the wrong one for
// ground, so every ground class needs a key. Deliberately desaturated against
// my campus's palette: their sheet is a standalone illustration, whereas these sit
// inside Mapbox Standard and have to look like they belong to it rather than
// like a picture pasted on top.
const THEMES = {
  dark: {
    style: STANDARD,
    lightPreset: 'night',
    network: '#7f8fa6',
    casing: '#101c1a',
    route: '#00ffcc',
    building: '#3b4a63',
    buildingLine: '#20252f',
    mask: '#2f3546',
    label: '#ccd5e6',
    labelHalo: '#181d29',
    areaLabel: '#a9c08c',
    plate: '#1e232d',
    plateText: '#eaf0fb',
    // Pitch and court markings. my campus prints them white, which at
    // fill-emissive-strength 1 glares against night ground.
    sportLine: '#66795a',
    parkingLabel: '#9aa6bd',
    land: {
      lawn: '#2b3a2f',
      tree: '#3a5341',
      shrub: '#33482c',
      paving: '#343a48',
      parking: '#2a2f3c',
      parking_stripe: '#3d4351',
      walkway: '#3a4152',
      driveway: '#333947',
      offsite_road: '#2b303c',
      crossing: '#454c5c',
      sport: '#3a4436',
      track: '#443c32',
      pool: '#1d4a5b',
      closed: '#31353f',
      building: '#39404f',
    },
  },
  light: {
    style: STANDARD,
    lightPreset: 'day',
    network: '#4b5a74',
    casing: '#0f3d38',
    route: '#0d9488',
    building: '#c7cdda',
    buildingLine: '#9ba4b1',
    mask: '#ece7db',
    label: '#3b4757',
    labelHalo: '#f8f5ee',
    areaLabel: '#5d6d49',
    plate: '#4e4e4f',
    plateText: '#ffffff',
    sportLine: '#ffffff',
    parkingLabel: '#6b7280',
    land: {
      lawn: '#d5e2b2',
      tree: '#9cba7c',
      shrub: '#b3cc90',
      paving: '#e7e2d6',
      parking: '#d8d7cf',
      parking_stripe: '#f2efe7',
      walkway: '#efece3',
      driveway: '#e4e0d5',
      offsite_road: '#dcd8cd',
      crossing: '#c9c4b8',
      sport: '#cfe0aa',
      track: '#ecdcc2',
      pool: '#8ac9db',
      closed: '#c6c2b8',
      building: '#fbfaf6',
    },
  },
};

// Imagery is dark, busy and its own fixed brightness, so it does not follow the
// light/dark theme and needs high-contrast line colours of its own.
const SATELLITE = {
  style: 'mapbox://styles/mapbox/standard-satellite',
  lightPreset: 'day',
  // Sky blue rather than white: the imagery basemap draws its own roads in
  // cream, and a white network is indistinguishable from them over pale roofs.
  network: '#38bdf8',
  casing: '#0b1220',
  route: '#facc15',
  building: '#94a3b8',
  // No fill mask over imagery — seeing the ground is the entire point of this
  // basemap, so here the campus only gets the clip, which removes Mapbox's
  // labels and 3D objects while leaving the photograph intact.
  mask: null,
  // Same reasoning for the ground cover: painting my campus's lawns and car parks over
  // a photograph of the actual lawns and car parks hides the better data. The
  // amenity symbols and place labels stay, because the imagery carries neither.
  land: null,
  buildingLine: null,
  label: '#ffffff',
  labelHalo: '#101828',
  areaLabel: '#ffffff',
  parkingLabel: '#dbeafe',
  plate: '#151b28',
  plateText: '#ffffff',
};

/** Layer colours and basemap style for the current basemap/theme pair. */
function palette(basemap, theme) {
  return basemap === 'satellite' ? SATELLITE : THEMES[theme];
}

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
// by scripts/build-paths.mjs — regenerate paths.json and this may need updating.
const CAMPUS_BOUNDS = [
  [-121.350400, 38.645604],
  [-121.342272, 38.653111],
];

// Breathing room around the campus when it is framed, in px.
const FIT_MARGIN = 40;

if (!accessToken || accessToken === 'YOUR_MAPBOX_TOKEN_HERE') {
  console.warn("Please add your Mapbox Access Token to the .env file as VITE_MAPBOX_TOKEN.");
} else {
  mapboxgl.accessToken = accessToken;

  // Set the attribute before the map exists so the first paint is never the
  // wrong theme, and so the basemap starts on the matching style.
  let currentTheme = preferredTheme();
  applyThemeAttribute(currentTheme);
  let currentBasemap = preferredBasemap();
  let appliedStyle = palette(currentBasemap, currentTheme).style;

  const map = new mapboxgl.Map({
    container: 'map',
    style: appliedStyle,
    // Fitting the network's own bounds rather than a fixed centre/zoom means the
    // campus fills the frame on a phone and a desktop alike.
    bounds: CAMPUS_BOUNDS,
    fitBoundsOptions: { padding: FIT_MARGIN },
  });

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
  // The open building card, and which building it belongs to.
  let openCard = null;
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
  const navBanner = document.getElementById('nav-banner');
  const navFooter = document.getElementById('nav-footer');
  const navStack = document.getElementById('nav-stack');

  /**
   * Padding for framing the campus. The side panel floats over the west edge of
   * the map, so an even margin centres the campus in the *container* and leaves
   * it visibly pushed left in the part you can actually see. Reserving the
   * panel's real width fixes that, and it has to be measured rather than
   * hard-coded because the panel is hidden during navigation.
   *
   * Mapbox throws if padding exceeds the canvas, so on a screen too narrow to
   * hold both, fall back to an even margin and let the panel overlap.
   */
  function campusPadding() {
    const even = { top: FIT_MARGIN, bottom: FIT_MARGIN, left: FIT_MARGIN, right: FIT_MARGIN };
    if (sidePanel.classList.contains('hidden')) return even;

    const panel = sidePanel.getBoundingClientRect();
    const canvas = map.getCanvas().getBoundingClientRect();
    if (!panel.width || !canvas.width) return even;

    const left = panel.right - canvas.left + FIT_MARGIN;
    if (left + FIT_MARGIN >= canvas.width) return even;
    return { ...even, left };
  }

  // The constructor framed the campus before these element refs existed, so it
  // could only use an even margin. Re-frame now that the panel can be measured;
  // instantly, since no tiles have been drawn yet.
  map.fitBounds(CAMPUS_BOUNDS, { padding: campusPadding(), duration: 0 });
  const signTemplate = document.getElementById('nav-sign-template');
  const navRemaining = document.getElementById('nav-remaining');
  const navEta = document.getElementById('nav-eta');
  const themeToggle = document.getElementById('theme-toggle');
  const themeIcon = document.getElementById('theme-toggle-icon');
  const themeLabel = document.getElementById('theme-toggle-label');
  const basemapToggle = document.getElementById('basemap-toggle');
  const basemapIcon = document.getElementById('basemap-toggle-icon');
  const basemapLabel = document.getElementById('basemap-toggle-label');

  function setDistanceFeet(feet) {
    distanceText.innerHTML =
      `${Math.round(feet).toLocaleString()} <span class="text-lg text-gray-500 font-medium">ft</span>`;
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
    instructionText.textContent = message;
    // The muted classes have to come off entirely on error: `dark:text-gray-400`
    // out-specifies a plain `text-red-600` and would swallow the warning.
    instructionText.classList.toggle('text-gray-500', !isError);
    instructionText.classList.toggle('dark:text-gray-400', !isError);
    instructionText.classList.toggle('text-red-600', isError);
    instructionText.classList.toggle('dark:text-red-400', isError);
    instructionText.classList.toggle('font-semibold', isError);
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

    closeBuildingCard();

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
    const colors = palette(currentBasemap, currentTheme);

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
      },
    }, 'route-casing');
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
    const colors = palette(currentBasemap, currentTheme);
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
    const visible = ['!', ['to-boolean', ['get', 'hidden']]];
    const anchor = map.getLayer('network-lines') ? 'network-lines' : undefined;

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

  /**
   * Amenity pictograms. Nothing here is theme-dependent — the icons carry their
   * own colour and a white rim so they read on lawn, paving and imagery alike.
   *
   * The layer is added inside the promise because setStyle drops registered
   * images along with the layers, so the icons have to be re-registered before
   * anything can reference them.
   */
  function addAmenityLayer() {
    if (!campusAmenities || map.getLayer('campus-amenities')) return;

    if (!map.getSource('campus-amenities')) {
      map.addSource('campus-amenities', { type: 'geojson', data: campusAmenities });
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
          'icon-size': ['interpolate', ['linear'], ['zoom'], 16, 0.4, 19, 0.62],
          'icon-padding': 2,
        },
        paint: { 'icon-emissive-strength': 1 },
      });
    }).catch((error) => console.error('amenity icons unavailable:', error));
  }

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
   * Three layers rather than one because the sheet sets three kinds of label and
   * they differ in more than colour: areas are letterspaced capitals, and the
   * larger building names are reversed out of a dark plate, which needs an icon
   * behind the text that a single layer cannot apply selectively.
   */
  const LABEL_KINDS = ['area', 'plate', 'building', 'parking'];

  /**
   * Text size from the label's own point size on the sheet, so my campus's hierarchy
   * survives — Library is 13.1 pt against Oak Cafe's 6.6 and stays bigger here.
   * Ground-true scaling was tried and grows far too fast, roughly doubling per
   * zoom level; this is gentler and stays readable across the useful range.
   */
  const labelSize = (scale) => [
    'interpolate', ['linear'], ['zoom'],
    15, ['*', ['get', 'pt'], 1.1 * scale],
    17, ['*', ['get', 'pt'], 1.45 * scale],
    19, ['*', ['get', 'pt'], 1.9 * scale],
  ];

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
  // The side panel is w-72 at a 1rem inset, plus a margin; the card is w-72 too
  // and centres on its anchor, so it needs half its own width of clearance as
  // well before it stops reaching under the panel.
  const SIDE_PANEL_WIDTH = 320;
  const CARD_WIDTH = 288;

  function addDirectoryLayers() {
    const colors = palette(currentBasemap, currentTheme);

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

  function closeBuildingCard() {
    if (openCard) openCard.remove();
    openCard = null;
    highlightBuilding(null);
  }

  /** The building under a click, or null. */
  function buildingAt(pointer) {
    if (!map.getLayer('campus-directory-hit')) return null;
    const [hit] = map.queryRenderedFeatures(pointer, { layers: ['campus-directory-hit'] });
    return hit?.properties ?? null;
  }

  function showBuildingCard(lngLat, raw) {
    closeBuildingCard();
    // Vector tiles hand nested properties back as JSON strings.
    const props = { ...raw };
    for (const key of ['contents', 'facilities', 'parts', 'entrance', 'anchor']) {
      if (typeof props[key] === 'string') {
        try { props[key] = JSON.parse(props[key]); } catch { delete props[key]; }
      }
    }

    // Point at the building rather than at the tap, so the card lands in the
    // same place each time the same building is opened.
    const at = props.anchor ?? [lngLat.lng, lngLat.lat];

    // The side panel is an HTML overlay, so Mapbox's own edge-flipping cannot
    // see it and will happily open a card underneath it. Naming an anchor turns
    // that flipping off entirely, though, so once the horizontal side is forced
    // the vertical one has to be chosen too or a tall card runs off the top.
    const screen = map.project(at);
    const height = map.getCanvas().clientHeight;
    const overPanel = screen.x < SIDE_PANEL_WIDTH + CARD_WIDTH / 2;
    const vertical = screen.y < height / 3 ? 'top-' : screen.y > (height * 2) / 3 ? 'bottom-' : '';
    const anchor = overPanel ? `${vertical}left` : undefined;

    openCard = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: 'none',
      className: 'campus-popup',
      offset: 10,
      ...(anchor ? { anchor } : {}),
    })
      .setLngLat(at)
      .setDOMContent(buildingCard(props, {
        onStart: (coords, name) => {
          if (startPoint && endPoint) resetMap();
          closeBuildingCard();
          placeStart(coords, name);
          setStatus(`Start set at ${name}. Now pick a destination.`);
        },
        onEnd: async (coords, name) => {
          closeBuildingCard();
          if (!startPoint) {
            pendingEnd = { coords, name };
            setStatus(`${name} set as the destination. Click the map to set a start point.`);
            return;
          }
          if (endPoint) resetMap0(coords, name);
          else await placeEnd(coords, name);
        },
      }))
      .addTo(map);

    openCard.on('close', () => { openCard = null; highlightBuilding(null); });
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
    const colors = palette(currentBasemap, currentTheme);

    // An image cannot be recoloured in place, so the plate is re-registered.
    if (campusLabels) loadLabelPlate(map, colors.plate);

    if (map.getLayer('campus-labels-building')) {
      map.setPaintProperty('campus-labels-building', 'text-color', colors.label);
      map.setPaintProperty('campus-labels-building', 'text-halo-color', colors.labelHalo);
      map.setPaintProperty('campus-labels-area', 'text-color', colors.areaLabel);
      map.setPaintProperty('campus-labels-area', 'text-halo-color', colors.labelHalo);
      map.setPaintProperty('campus-labels-plate', 'text-color', colors.plateText);
      map.setPaintProperty('campus-labels-parking', 'text-color', colors.parkingLabel);
      map.setPaintProperty('campus-labels-parking', 'text-halo-color', colors.labelHalo);
      return;
    }
    if (!campusLabels) return;

    if (!map.getSource('campus-labels')) {
      map.addSource('campus-labels', { type: 'geojson', data: campusLabels });
    }

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

    for (const kind of LABEL_KINDS) {
      const area = kind === 'area';
      const plate = kind === 'plate';
      map.addLayer({
        ...common,
        id: `campus-labels-${kind}`,
        filter: ['==', ['get', 'kind'], kind],
        layout: {
          'text-field': ['get', 'text'],
          'text-font': area
            ? ['DIN Pro Bold', 'Arial Unicode MS Bold']
            : ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-size': labelSize(area ? 0.95 : 1),
          // 8 ems is where the sheet breaks its own labels, so the printed ones
          // keep their original line breaks. The names added from my campus's database
          // have no printed breaks to reproduce and carry a width fitted to the
          // footprint instead — see build-labels.mjs.
          'text-max-width': ['coalesce', ['get', 'maxWidth'], 8],
          'text-line-height': 1.05,
          'text-letter-spacing': area ? 0.14 : 0,
          'symbol-sort-key': sortKey,
          ...(plate ? {
            'icon-image': 'label-plate',
            'icon-text-fit': 'both',
            'icon-text-fit-padding': [3, 6, 3, 6],
          } : {}),
        },
        paint: {
          'text-color': area ? colors.areaLabel
            : plate ? colors.plateText
            : kind === 'parking' ? colors.parkingLabel
            : colors.label,
          // A plate is its own background; a halo on top of it only muddies the
          // edge of the type.
          'text-halo-color': colors.labelHalo,
          'text-halo-width': plate ? 0 : 1.4,
          'text-emissive-strength': 1,
          'icon-emissive-strength': 1,
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
    const colors = palette(currentBasemap, currentTheme);

    if (!map.getSource('campus-boundary')) {
      map.addSource('campus-boundary', { type: 'geojson', data: campusBoundary });
    }

    if (!map.getLayer('campus-clip')) {
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
    }, map.getLayer('network-lines') ? 'network-lines' : undefined);
  }

  function addNetworkLayers() {
    const colors = palette(currentBasemap, currentTheme);

    // Mapbox Standard exposes configuration instead of addressable layers, and
    // this is where light and dark actually happen now.
    try {
      map.setConfigProperty('basemap', 'lightPreset', colors.lightPreset);
    } catch (error) {
      // Older styles have no config; the map is still perfectly usable.
      console.warn('basemap config unavailable', error);
    }

    addCampusMask();
    addBasemapLayers();

    if (!map.getSource('custom-network')) {
      map.addSource('custom-network', { type: 'geojson', data: customNetwork ?? EMPTY });
    }
    if (!map.getSource('calculated-route')) {
      map.addSource('calculated-route', { type: 'geojson', data: routeFeature() });
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
        paint: { 'line-color': colors.network, 'line-width': 2, 'line-dasharray': [2, 2] }
      });
    } else {
      map.setPaintProperty('network-lines', 'line-color', colors.network);
    }

    // Dark casing under the route so it stays readable against pale buildings.
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

  // Fires on first load *and* after every setStyle, which is exactly when the
  // custom layers need rebuilding.
  map.on('style.load', addNetworkLayers);

  /**
   * Swap the basemap if the current basemap/theme pair calls for a different
   * one. Both toggles route through here: on satellite the theme no longer
   * changes the map, so this becomes a no-op and only the page chrome restyles.
   */
  function syncBasemapStyle() {
    const nextStyle = palette(currentBasemap, currentTheme).style;

    if (nextStyle !== appliedStyle) {
      appliedStyle = nextStyle;
      // diff:false forces a full style reload. The default diffing path can
      // drop custom layers without firing style.load, leaving a bare basemap.
      map.setStyle(nextStyle, { diff: false }); // style.load re-adds our layers
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

  createThemeToggle({
    button: themeToggle,
    icon: themeIcon,
    label: themeLabel,
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

  map.on('load', async () => {
    // Real GPS. Requires a secure context (https or localhost) or the browser
    // silently refuses to report a position.
    const geolocate = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    });
    map.addControl(geolocate);
    geolocate.on('geolocate', (e) => {
      onUserMoved([e.coords.longitude, e.coords.latitude], { duration: 1000 });
    });

    map.getCanvas().style.cursor = 'crosshair';

    // All from the same server, so ask together. They are settled separately
    // because only the network is load-bearing: without it nothing can be
    // routed, whereas every overlay is decoration and its loss costs one layer.
    const [networkResult, buildings, basemap, amenities, places, labels, directory] =
      await Promise.allSettled([
        fetchNetwork(),
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
      campusBasemap = basemap.value;
      addBasemapLayers();
    } else {
      console.error(basemap.reason);
    }

    if (amenities.status === 'fulfilled') {
      campusAmenities = amenities.value;
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

    if (directory.status === 'fulfilled') {
      campusDirectory = directory.value;
      addDirectoryLayers();
    } else {
      console.error(directory.reason);
    }

    if (labels.status === 'fulfilled') {
      campusLabels = labels.value;
      addLabelLayers();
    } else {
      console.error(labels.reason);
    }

    if (networkResult.status === 'rejected') {
      console.error(networkResult.reason);
      setStatus('Routing server unreachable — is `npm run dev` still running?', true);
      return;
    }
    customNetwork = networkResult.value;

    const vertices = [];
    const seen = new Set();
    customNetwork.features.forEach(feature => {
      feature.geometry.coordinates.forEach(coord => {
        const key = `${coord[0]},${coord[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          vertices.push(coord);
        }
      });
    });
    networkPoints = featureCollection(vertices.map(v => point(v)));

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
    startPoint = point(coords);
    startMarker?.remove();
    startMarker = new mapboxgl.Marker({ color: '#22c55e' }) // Tailwind green-500
      .setLngLat(coords)
      .addTo(map);
    startCoordText.textContent = label ?? coordLabel(coords);
  }

  async function placeEnd(coords, label) {
    endPoint = point(coords);
    endMarker?.remove();
    endMarker = new mapboxgl.Marker({ color: '#ef4444' }) // Tailwind red-500
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

    setDistanceFeet(result.distanceFeet);
    const turns = maneuvers.length - 2;
    setStatus(`Route calculated — ${turns} turn${turns === 1 ? '' : 's'}.`);
    setNavButtonsEnabled(true);
  }

  map.on('click', async (e) => {
    if (navActive || !networkPoints) return;

    // A tap on a building asks what it is rather than dropping a pin on it.
    // The card's own buttons then set a start or destination, and they do it at
    // the entrance node rather than wherever the finger landed.
    const building = buildingAt(e.point);
    if (building) {
      showBuildingCard(e.lngLat, building);
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

  function runSearch(query) {
    const terms = normalise(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
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
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS).map((s) => s.entry);
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
      const on = i === index;
      li.setAttribute('aria-selected', String(on));
      li.classList.toggle('bg-cyan-50', on);
      li.classList.toggle('dark:bg-neutral-700', on);
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
      li.className = 'px-3 py-2 cursor-pointer hover:bg-cyan-50 dark:hover:bg-neutral-700';
      const name = document.createElement('div');
      name.className = 'text-gray-800 dark:text-gray-100';
      name.textContent = entry.name;
      li.append(name);
      // Only worth a second line when it says something the name did not.
      const hint = entry.points.length > 1
        ? `${entry.points.length} locations`
        : entry.description;
      if (hint) {
        const sub = document.createElement('div');
        sub.className = 'text-xs text-gray-500 dark:text-gray-400 line-clamp-2';
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
    const coords = nearestInstance(entry);
    searchInput.value = entry.name;
    searchClear.classList.remove('hidden');
    closeResults();
    searchInput.blur();

    if (startPoint && endPoint) resetMap();

    map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 17), duration: 900 });

    if (!startPoint) {
      pendingEnd = { coords, name: entry.name };
      endMarker?.remove();
      endMarker = new mapboxgl.Marker({ color: '#ef4444' }).setLngLat(coords).addTo(map);
      endCoordText.textContent = entry.name;
      setStatus(`${entry.name} — now click the map to set where you are starting from.`);
      return;
    }
    await placeEnd(coords, entry.name);
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
