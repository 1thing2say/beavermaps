// The helicopter shot: Google's photorealistic 3D tiles, orbiting one building,
// in a box in the sidebar.
//
// WHY THIS AND NOT GOOGLE'S 3D MAP ELEMENT. The Maps JavaScript API ships a
// `<gmp-map-3d>` web component with a `flyCameraAround` method that is this
// feature in one call, and it is the wrong tool for the same reason the raster
// provider does not load Google's SDK either — see the note at the top of
// src/google-tiles.js. It would put a second renderer and a second map runtime
// on the page to fill a 190px box. What is used here instead is the 3D Tiles
// REST endpoint, which is the same key and the same billing SKU as the ground
// tiles this app already draws, and which was verified against this campus
// before a line of it was written: the tileset descends 25 levels over my campus to a
// geometric error of 2.01 m, the same detail Google serves Manhattan.
//
// ONE STAGE, NOT ONE PER CARD, AND IT IS A BILLING DECISION.
//
// The Photorealistic 3D Tiles SKU bills the ROOT TILESET REQUEST. Google's
// documentation is explicit that "session token requests and tile requests for
// Photorealistic 3D Tiles don't impact your daily quota" — so the meter is
// `root.json`, and nothing else here costs anything however many megabytes it
// moves.
//
// A Deck per card would therefore have been a Deck per BUILDING TAPPED: deck.gl
// calls `_loadTileset` whenever a Tile3DLayer sees a new `data` prop, so twelve
// buildings in one visit would have been twelve billable events instead of one.
// Cheap in absolute terms and the wrong scaling curve — the cost would have
// tracked how much somebody used the app rather than how many people opened it.
//
// So there is exactly one Deck, one Tile3DLayer and one Tileset3D for the life
// of the tab, and a card borrows the canvas rather than making one. Opening a
// second building moves the canvas into the new card and changes the camera.
// `root.json` is fetched once.
//
// Caching cannot do this job instead, which was worth checking rather than
// assuming: Google serves that file `cache-control: private, max-age=0,
// must-revalidate`, so the browser has to revalidate every time and every
// revalidation reaches their server.
//
// WHAT KEEPS IT ON CAMPUS. There is no way to fence a Google key to a bounding
// box, so the fence is the camera: the view has no controller. It cannot be
// panned, dragged or zoomed, it is centred on one building, and it holds a
// fixed radius. The frustum therefore never leaves a couple of hundred metres
// of the thing that was tapped. Adding drag-to-look would be a pleasant fifteen
// minutes and would also mean any visitor could walk this viewport to another
// state pulling tiles the whole way, which is the one thing this was asked not
// to do.

import { spinnerOverlay } from './spinner.js';
// The same scale the box was built with. Imported rather than restated,
// because a tile measured on one scale against a box built on another is a
// comparison of two different things that happen to share a unit.
import { M_PER_DEG_LAT, M_PER_DEG_LON, campusBox } from './flyover.js';
import {
  pinLayers, dropPixels, pinHeight, CLEAR_M, HOLD_MS, SETTLED_MS, DROP_MS, warmPinIcons,
} from './flyover-pin.js';
import { highlightLayers, HIGHLIGHT_UP_MS } from './flyover-cage.js';

/**
 * Whether the flown-over building is boxed at all. Off for now, by request.
 *
 * Switched HERE rather than inside src/flyover-cage.js, and that is the whole
 * reason this is one line: the module keeps working, keeps its tests, and keeps
 * being the thing that describes what a highlight is. Only the view's decision
 * to ask for one has changed. Flip this back to `true` and the box returns
 * exactly as it was — there is nothing else to put back.
 */
const SHOW_HIGHLIGHT = false;
import { PUSH_PIN_RED } from './push-pin.js';

const TILESET = 'https://tile.googleapis.com/v1/3dtiles/root.json';

/**
 * The tile layer's id, which is also the prefix Tile3DLayer gives its sublayers
 * — so it is how `drawn` asks whether any geometry exists yet.
 */
const TILES_ID = 'flyover-tiles';

/**
 * How much sky the roof should have over it, as a share of the frame's height.
 *
 * What the camera's aim is solved for — see the padding in `createFlyover`.
 *
 * 0.46 was set when a "Here" label stood over the ball: pin plus gap plus a line
 * of type is a little over 0.43 of the frame's height where the pin alone is
 * 0.28, and at 0.4 the word was clipped clean off the top edge. The label is
 * gone and the number is kept, because the slack it bought is what stops the pin
 * being SHORTENED to fit on a tall building — which it can do (see HEADROOM in
 * src/flyover-pin.js) but should not have to. Sky over a roof is not wasted
 * frame; it is what makes the shot read as aerial rather than as a wall.
 */
const WANT_SKY = 0.46;

/**
 * One full circle, in ms.
 *
 * 90 seconds, which is a drift rather than an orbit: four degrees a second, and
 * nobody holds a card open long enough to see a quarter of it. That is the
 * point. A circle you can perceive as a circle is a turntable, and the thing
 * being looked at stops being a building and starts being an exhibit; slow
 * enough and the camera reads as holding still while the light moves over the
 * faces, which is what a helicopter actually looks like.
 *
 * It costs nothing. The orbit is wall-clock rather than per-frame, tiles are
 * requested by what the frustum contains rather than by how fast it moves, and
 * the traversal is the same set of tiles either way — just held longer.
 */
const ORBIT_MS = 90_000;

/**
 * How much detail to ask for, as loaders.gl's screen-space error in pixels.
 *
 * This is the bandwidth knob, and it is the one number here that had to be
 * measured rather than reasoned about. Higher means the traversal stops at a
 * coarser level.
 *
 * The reasoning that got it wrong first, because it is the obvious reasoning:
 * the viewport is small, small viewports need less detail, so a generous
 * threshold saves bandwidth for free. It does not, because screen-space error
 * is ALREADY in screen pixels — the smallness of the box is counted once in the
 * projection and counting it again just stops the traversal early. Set to 24,
 * the box rendered a blur, and the giveaway was the attribution: the tiles that
 * arrived were crediting GEBCO, IBCAO and Landsat, which are Google's global
 * bathymetry and satellite sources. It was drawing the planet, not the campus.
 *
 * What it should be follows from the framing. At the default span the box shows
 * about 0.4 m of ground per pixel, so a tile whose geometric error is G metres
 * projects to roughly G / 0.4 pixels: the 2.01 m leaves over my campus land at ~5 px
 * and the 4.01 m level at ~10. Eight therefore reaches the second-finest level
 * and stops, which is the right trade for a box this size on a phone — the
 * finest level is four times the tiles for detail below the resolution of the
 * viewport it is being drawn into.
 */
const SCREEN_SPACE_ERROR = 8;

/**
 * The ceiling on decoded geometry held on the GPU, in MB.
 *
 * This is the answer to "will it bog the device down", and the answer is no
 * because the tileset evicts: loaders.gl keeps an LRU of loaded tiles and
 * unloads the least recently used ones past this budget. A tile touched by the
 * current traversal is never evicted, so what this gives up is always a
 * building somebody has stopped looking at.
 *
 * Never unloading was the alternative and would have been a real problem, not a
 * theoretical one: this is DECODED geometry, several times the 124 KiB the tile
 * arrived as, and holding a campus of it would be hundreds of megabytes of GPU
 * memory on a phone that is also running Mapbox GL.
 *
 * 24 rather than the library's 32 because this viewport is a fifth of the
 * screen at most and never needs the working set a full-page globe does.
 *
 * IT HAS TO BE SET ON THE TILESET, not passed in its options, and it was not:
 * the number lands in `tileset.options.maximumMemoryUsage`, while the eviction
 * loop reads `tileset.maximumMemoryUsage` — a class field initialised to 32 that
 * the constructor never assigns from the options (see TilesetCache.unloadTiles
 * against Tileset3D's field declaration). So this was inert and the real budget
 * was the library's default. Applied in `onTilesetLoad` instead. Measured over a
 * campus sweep, that is the difference between settling around 90 MB and
 * settling around 30.
 */
const MAX_GPU_MB = 24;

/**
 * The hard ceiling on how many tiles may be drawn in one frame.
 *
 * The memory budget above is a rolling one — it evicts after the fact, once the
 * decoded geometry is already on the GPU. This is the one that acts before
 * anything is drawn, and it is what a low-end device actually needs: a phone
 * that cannot hold sixty draw calls at 60fps does not want to find that out by
 * making them.
 *
 * ENFORCED HERE RATHER THAN BY loaders.gl, AND THAT IS NOT A PREFERENCE. Passing
 * it as `maximumTilesSelected` hands the job to `limitSelectedTiles`, which
 * ranks tiles by `tile.header.mbs` — the I3S minimum bounding sphere. 3D Tiles
 * headers have no such field, so the moment a traversal selects more tiles than
 * the cap, that helper destructures `undefined` and throws.
 *
 * The throw is what made this worth chasing rather than merely worth avoiding.
 * It lands inside `traverse()`, so `_onTraversalEnd` never runs, so
 * `traverseCounter` never comes back down from 1 — and `doUpdate` opens with
 * `if (this.traverseCounter > 0) return`. One exception therefore stops every
 * future traversal for the life of the tab: no selection, no requests, a
 * viewport frozen on whatever it happened to be holding. Cycling buildings
 * quickly is simply how you get past 48 selected tiles.
 *
 * IT BRIEFLY BECAME THE BINDING CONSTRAINT and is a backstop again, which is
 * the more comfortable place for it to sit. Removing the per-building clip left
 * the frustum as the only fence, and at 68 degrees off nadir a frustum holds a
 * lot: the traversal came back with 65 tiles over the Library where the box had
 * allowed far fewer, and this was culling 17 of them every frame. Bounding the
 * ground to the CAMPUS instead — see `offCampus` — takes 14 to 16 off the
 * selection at the far edge rather than at the near one, which lands both the
 * Library and the Parking Garage in the low forties and gives this room again.
 *
 * The sort is what makes the fallback safe rather than hoped for: what is given
 * up is always the farthest ground and never the building in the middle.
 */
const MAX_TILES_DRAWN = 48;

/**
 * How far the ground grid reaches from the building, in spans.
 *
 * It has to cover everything the camera can see, because the grid is what
 * stands for "no tiles here" and a grid that stops before the frame edge just
 * moves the problem outward. Deck.gl's own far plane stops about 0.6 spans past
 * the target at this pitch — measured — so 1.5 covers the visible ground with
 * room to spare in every direction the orbit swings through.
 *
 * THIS IS WHY THERE IS NO LONGER A CUSTOM FAR PLANE. An earlier version cut the
 * frustum to the building's box to stop the traversal requesting distant tiles,
 * and that is incompatible with this: the far plane clips ALL geometry, so a
 * plane tight enough to bound the tiles also sliced the grid off mid-frame. The
 * default plane is already a real bound — it is the 0.6 spans measured above,
 * not the horizon — and the tile budgets that remain (screen-space error, the
 * memory ceiling, the drawn-tile cap and the clip itself) are the ones that
 * were doing the heavy work anyway.
 */
const GRID_SPANS = 1.5;

/**
 * Grid cells across the frame.
 *
 * A count rather than a cell size in metres, so the ruling looks the same over
 * Adaptive PE and over the Parking Garage — those differ by a factor of seven
 * in width, and a fixed 20 m cell would be a fine mesh on one and four squares
 * on the other.
 */
const GRID_CELLS = 24;

/**
 * How far below the ground the grid is drawn, in metres.
 *
 * Under the terrain rather than on it, which is what makes "everywhere the
 * tiles are not" work without any coordination between the two. Where tiles
 * render they are nearer the camera and the depth test hides the grid; where
 * the clip discarded them nothing was written to the depth buffer at all — a
 * discarded fragment writes no depth — so the grid shows through. The two never
 * have to agree about where the boundary is, because the boundary is wherever
 * the tiles happen to stop.
 *
 * Deep enough to clear the terrain's own relief. my campus is flat and sits near zero
 * metres ellipsoidal, and the finest tiles measure -6.4 m at their lowest, so
 * eight metres down is below all of it without being far enough to show a
 * parallax gap at the edges.
 */
const GRID_DEPTH_M = -8;

/** Google requires attribution and it is per-tile. Shown until tiles say more. */
const FALLBACK_CREDIT = 'Google';

/**
 * deck.gl and loaders.gl, fetched the first time somebody opens a building and
 * never again.
 *
 * This is by far the largest thing in the bundle — bigger than Mapbox GL — and
 * the overwhelming majority of visits to a campus wayfinder never open a
 * building card at all. Static imports would have made every one of those
 * visits pay for a renderer they did not use. The promise is cached rather than
 * the modules so two fast taps share one download instead of racing.
 */
let toolkit = null;
const loadToolkit = () => (toolkit ??= Promise.all([
  import('@deck.gl/core'),
  import('@deck.gl/geo-layers'),
  import('@loaders.gl/3d-tiles'),
  import('@deck.gl/layers'),
]).then(([core, geo, tiles, layers]) => ({
  Deck: core.Deck,
  MapView: core.MapView,
  // Not for rendering. The pin's fall is measured in screen pixels and needs to
  // know where on screen the roof is, which is a question only the projection
  // can answer — see `dropPixels` in src/flyover-pin.js.
  WebMercatorViewport: core.WebMercatorViewport,
  Tile3DLayer: geo.Tile3DLayer,
  Tiles3DLoader: tiles.Tiles3DLoader,
  LineLayer: layers.LineLayer,
  IconLayer: layers.IconLayer,
  PathLayer: layers.PathLayer,
  SolidPolygonLayer: layers.SolidPolygonLayer,
})).catch((error) => {
  // Not cached on failure, so a flyover opened on a dropped connection can be
  // retried by closing the card and opening it again.
  toolkit = null;
  throw error;
}));


/** Asked each time, so a preference changed mid-session takes effect at once. */
const prefersStill = () => Boolean(
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
);

/**
 * Every tile request, with the key on it.
 *
 * loaders.gl resolves a child tile's URI against its parent's and carries the
 * `session` parameter Google puts there itself, but nothing carries the API
 * key — so without this every request after the root is a 403. Done as a fetch
 * wrapper rather than with the `X-GOOG-API-KEY` header that Google's own
 * deck.gl sample uses, because a custom header turns every one of these into a
 * CORS preflight: two round trips per tile instead of one, on the request path
 * that is already the slow part.
 */
function keyedFetch(key) {
  return (url, options) => {
    const target = new URL(url, TILESET);
    if (target.hostname.endsWith('googleapis.com') && !target.searchParams.has('key')) {
      target.searchParams.set('key', key);
    }
    return fetch(target.toString(), options);
  };
}

/**
 * The zoom that fits `span` metres across a viewport `width` pixels wide.
 *
 * Web Mercator's ground resolution at the equator is 156543.03392 m per pixel
 * at zoom 0, shrinking by cos(latitude) as you leave it and by half per level.
 * Inverting that for the zoom which puts `span` metres in `width` pixels is the
 * whole of this. Pitch is ignored deliberately: tilting the camera stretches
 * what is visible toward the horizon but leaves the scale at the centre of the
 * screen alone, and the centre is where the building is.
 */
/**
 * The grid, as line segments on the ground in lon/lat.
 *
 * Built in geographic coordinates rather than drawn as a texture because that
 * is the whole of what was wrong with the first version: a CSS background sits
 * on the screen, so it stayed put while the camera orbited past it and read as
 * graph paper taped to the monitor. These are segments lying flat in the scene,
 * so they recede with the ground, converge toward the horizon, and turn with
 * the building — which is the only way a grid can say "this is ground we did
 * not load" rather than "this is a decorated background".
 *
 * Square in METRES, not in degrees. A degree of longitude at my campus is 0.78 of a
 * degree of latitude, so a grid ruled on degrees would be visibly oblong.
 */
function gridLines([lon, lat], extent, step) {
  const lines = [];
  for (let m = -extent; m <= extent + 1e-6; m += step) {
    const dLat = m / M_PER_DEG_LAT;
    const dLon = m / M_PER_DEG_LON;
    const eastWest = extent / M_PER_DEG_LON;
    const northSouth = extent / M_PER_DEG_LAT;
    lines.push({
      from: [lon - eastWest, lat + dLat, GRID_DEPTH_M],
      to: [lon + eastWest, lat + dLat, GRID_DEPTH_M],
    });
    lines.push({
      from: [lon + dLon, lat - northSouth, GRID_DEPTH_M],
      to: [lon + dLon, lat + northSouth, GRID_DEPTH_M],
    });
  }
  return lines;
}

/**
 * The grid's ink, read from the stylesheet so it follows the theme.
 *
 * `--g-grid-ink` is the same token the card's own surfaces are drawn from, and
 * taking it from the computed style rather than restating it here is what stops
 * the 3D grid and the panel around it drifting apart the next time either
 * palette is touched. deck.gl wants bytes, CSS gives hex; the fallback is the
 * light theme's value, for the case where the token has not resolved yet.
 */
function gridInk() {
  const css = getComputedStyle(document.documentElement)
    .getPropertyValue('--g-grid-ink').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(css)?.[1] ?? 'd8dade';
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function zoomFor(span, width, latitude) {
  const metresPerPixel = 156543.03392 * Math.cos((latitude * Math.PI) / 180);
  return Math.log2((width * metresPerPixel) / span);
}

/**
 * Whether a tile is one of the ancestor slabs that exist only to be replaced.
 *
 * WHAT IS LEFT OF THE BOX. There used to be a square here — a clip that cut the
 * imagery along a straight line with grid outside it, and a matching test that
 * unselected anything beyond it. The line is gone, because a hard edge across a
 * photograph reads as a crop of the picture rather than as an edge of the world,
 * and every request in this feature's history has been to push it further out.
 * What the frustum shows is now what gets drawn.
 *
 * The SIZE half stays, and it was always the half doing work that could not be
 * seen. An overlap test can never reject an ancestor — every ancestor of a tile
 * over my campus contains my campus, which is what makes it an ancestor; measured against
 * the live tileset it rejected one of the eighteen tiles covering the Parking
 * Garage. This rejects the ones that are mostly not the building: kilometre-wide
 * slabs at a few pixels of detail. Drawing those is what turned this viewport
 * into global bathymetry once already — see SCREEN_SPACE_ERROR.
 *
 * A tile that cannot say how big it is, is kept. The failure this guards against
 * is a tileset shape this does not know how to read, and losing the picture over
 * one is worse than drawing a little too much of it.
 */
function offCampus(tile, bounds) {
  let extent;
  try {
    extent = tile.boundingBox;
  } catch {
    return false;
  }
  if (!extent) return false;

  const [lo, hi] = extent;
  // Overlap rather than containment, and only in lon/lat. Containment would
  // reject every tile the campus edge runs through, which is exactly the ground
  // an edge building is standing on; the vertical axis is left to `tooCoarse`,
  // because a height bound rejects almost nothing here — every ancestor of a
  // tile over my campus contains my campus however tall it is.
  return lo[0] > bounds.max[0] || hi[0] < bounds.min[0]
    || lo[1] > bounds.max[1] || hi[1] < bounds.min[1];
}

function tooCoarse(tile, maxTileSpan) {
  let extent;
  try {
    extent = tile.boundingBox;
  } catch {
    return false;
  }
  if (!extent) return false;

  const [lo, hi] = extent;
  // Degrees to metres on the ground. Latitude is the tighter of the two here
  // and the cheaper to be wrong about, so the wider span decides.
  const wide = Math.max((hi[0] - lo[0]) * M_PER_DEG_LON, (hi[1] - lo[1]) * M_PER_DEG_LAT);
  return wide > maxTileSpan;
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * The one renderer, and everything that outlives a card.
 *
 * `owner` is the token of the flyover currently holding the canvas. Teardown
 * checks it rather than assuming, because the cards overlap by design: the next
 * card is built — and takes the canvas — before the outgoing one is told to go
 * away, so an unguarded `destroy` would detach the canvas from the card that
 * just claimed it.
 */
const stage = {
  host: null,
  canvas: null,
  deck: null,
  credits: new Set(),
  owner: null,
  /** Set by whichever flyover holds the canvas, so traversals reach the right card. */
  onReady: null,
  /**
   * The current building's tile box, [[w, s], [e, n]].
   *
   * Read by `onTraversalComplete`, which belongs to the layer and therefore
   * outlives every card — so it has to be reachable from the stage rather than
   * closed over at layer construction, or every building after the first would
   * be measured against the first one's framing.
   */
  maxTileSpan: 0,
  /**
   * The campus, as the ground the tiles may cover. Same reason as above: the
   * traversal callback outlives every card, so this cannot be closed over.
   */
  bounds: null,
  /**
   * The current building's roof point, for the same reason and read by the same
   * callback: it is what "the building has arrived" is tested against.
   */
  roof: null,
  /**
   * The grid and the tiles for the current building, held so the pin can be
   * animated without rebuilding them.
   *
   * deck.gl takes the whole layer list on every `setProps`, and the pin moves on
   * every frame — so without this the tile layer would be reconstructed sixty
   * times a second. That is survivable (the tileset is keyed by `data` and would
   * not refetch) but it throws away and rebuilds a composite layer's sublayers
   * for no reason, which is exactly the churn a low-end device cannot afford.
   */
  base: [],
};

/**
 * The tile layer, built fresh for each building because the clip is a prop.
 *
 * Rebuilding it is free and — importantly — does not refetch anything: deck.gl
 * matches layers across renders by `id` and only calls `_loadTileset` when
 * `data` actually changes. Both are constants here, so a new instance inherits
 * the tileset already in memory. That is the difference between a clip that
 * costs nothing and one that costs a billable root request per building.
 */
/**
 * The ground the tiles are not covering.
 *
 * Drawn first and below everything, so it needs no knowledge of where the tiles
 * stop — see GRID_DEPTH_M. Its own id is constant so deck.gl updates it in
 * place across buildings rather than rebuilding the geometry.
 */
function makeGrid({ LineLayer }, centre, span) {
  return new LineLayer({
    id: 'flyover-grid',
    data: gridLines(centre, span * GRID_SPANS, span / GRID_CELLS),
    getSourcePosition: (d) => d.from,
    getTargetPosition: (d) => d.to,
    getColor: gridInk(),
    // A hairline whatever the zoom, like ruled paper rather than like painted
    // lines on tarmac — the grid is a notation, not part of the scene.
    widthUnits: 'pixels',
    getWidth: 1,
    widthMinPixels: 1,
  });
}

/**
 * The coarsest a tile may be and still count as "the building has arrived".
 *
 * `contentAvailable` alone was not enough, and the photograph of it is
 * unambiguous: the spinner came off at 1.45 s over a viewport of nothing but
 * grid and the building appeared at 2.6 s — more than a second of an empty box
 * with no spinner over it, and a pin dropping onto blank ground in the middle of
 * it. Some tile really had loaded; it was just not a tile of my campus. Google's
 * tileset descends through 64.20, 32.10, 16.05, 8.03, 4.01 and 2.01 m over this
 * campus, and the coarse levels are ground that has been simplified until a
 * building is a bump in it.
 *
 * 8.03 is the level above the 4.01 the traversal is actually aiming at (see
 * SCREEN_SPACE_ERROR), and 16 was tried first and was still half a second early:
 * a 16 m tile of my campus clipped to a 78 m perimeter is pale, almost flat ground,
 * which against this grid is indistinguishable from no tile at all. It was being
 * drawn. It just did not look like anything. One level finer is where a roof
 * with edges on it appears, and it is still two levels coarser than the leaves,
 * so a slow connection is not held under a spinner waiting for detail nobody
 * asked for.
 */
const READY_ERROR_M = 8.5;

/**
 * Whether this tile is the building the card is about, rather than some ground
 * that happens to be under it.
 *
 * Two tests, and the second is the one that matters for the pin: fine enough to
 * be a building, and covering the ROOF the pin is going to land on. A pin
 * dropping onto ground that has not loaded is worse than a pin that is late,
 * because the first reads as a bug and the second reads as loading.
 */
function showsSubject(tile, roof) {
  if (!(tile.geometricError <= READY_ERROR_M)) return false;
  if (!roof) return true;
  let extent;
  try { extent = tile.boundingBox; } catch { return true; }
  if (!extent) return true;
  const [lo, hi] = extent;
  return roof[0] >= lo[0] && roof[0] <= hi[0] && roof[1] >= lo[1] && roof[1] <= hi[1];
}

function makeLayer({ Tile3DLayer, Tiles3DLoader }, key) {
  return new Tile3DLayer({
    // Constant id and constant `data`, which is what stops the tileset being
    // reloaded. deck.gl matches layers across renders by id and only calls
    // `_loadTileset` when `props.data` actually changes — so every subsequent
    // building reuses the tree that is already in memory, and pays nothing.
    id: TILES_ID,
    data: TILESET,
    loader: Tiles3DLoader,
    loadOptions: {
      fetch: keyedFetch(key),
      // OFF THE MAIN THREAD, and this is the difference between a fall and a
      // stutter. loaders.gl will parse a glTF inline unless it is told not to,
      // and Google's tiles arrive Draco-compressed — so a tile landing during
      // the pin's 160 ms drop decodes its meshes on the same thread that is
      // supposed to be drawing them. Measured before this, the orbit held an
      // 8.3 ms median frame and still threw four frames past 25 ms with a
      // single 83 ms stall in it; 83 ms is half the drop, and it is exactly the
      // kind of hitch that reads as "the animation is laggy" rather than as
      // "the network is slow".
      worker: true,
      // The worker pool has to be big enough that one slow mesh does not queue
      // the rest behind it, and small enough not to fight the render thread for
      // cores. Four is the library's own default for tile loading and is a
      // reasonable share of the phones this has to run on.
      maxConcurrency: 4,
      // Draco is not optional here: Google serves this geometry compressed and
      // says so in every glTF it returns (`"generator":"draco_decoder"`).
      '3d-tiles': { loadGLTF: true },
      // Pulled back out of loadOptions and handed to the Tileset3D constructor
      // by Tile3DLayer — see `_loadTileset`, which destructures exactly this
      // key. Setting these on the tileset after it loads works too, and one
      // traversal too late: the first pass has already chosen its tiles at the
      // defaults and asked for them.
      tileset: {
        maximumScreenSpaceError: SCREEN_SPACE_ERROR,
        // HOW MANY TILES MAY BE IN FLIGHT AT ONCE. The library's default is 64,
        // which on a cold flyover means the whole first traversal is requested
        // together and lands together — and every arrival is a GPU upload and a
        // deck.gl sub-layer built on the main thread, whatever the parsing
        // thread did. That burst is the three seconds at twenty frames a second
        // the pin used to fall through.
        //
        // Twelve is about a screenful at this error budget, so nothing waits
        // that is actually needed to draw the first picture; what it delays is
        // the tail, which is refinement nobody is looking at yet. The total
        // bytes are identical — this changes when they arrive, not how many.
        maxRequests: 12,
        // Deliberately not `maximumTilesSelected` and not `maximumMemoryUsage`.
        // Both are applied elsewhere — see the notes on MAX_TILES_DRAWN, which
        // the library cannot enforce without throwing, and on MAX_GPU_MB, which
        // it accepts here and then ignores.
        // A traversal always completes, which is why this rather than
        // `onTileLoad` is what takes the spinner off: now that the tileset is
        // shared, a building standing on tiles already in the cache loads
        // nothing, fires no load event, and would sit under a spinner for ever
        // waiting for one.
        //
        // `contentAvailable` rather than `selected.length` is the whole of the
        // correctness here, and the first version got it wrong. Selection
        // happens before loading — the traversal picks the tiles it WANTS —
        // so a bare length check fired on the first frame, and the spinner came
        // off over an empty box half a second before the building appeared in
        // it. `contentAvailable` is the library's own "ready and has geometry".
        onTraversalComplete: (selected) => {
          // `unselect()` rather than only dropping it from the returned list,
          // because dropping it is not what stops it being drawn. Tile3DLayer
          // walks `tileset.tiles` and draws whatever still answers `tile.selected`
          // — a flag the traversal set before this callback ran — so a tile
          // merely left out of this array keeps its draw call and is drawn
          // anyway. Clearing the flag is what makes a rejection cost nothing.
          const { maxTileSpan, bounds } = stage;
          const kept = [];
          for (const tile of selected) {
            const out = (maxTileSpan && tooCoarse(tile, maxTileSpan))
              || (bounds && offCampus(tile, bounds));
            if (out) tile.unselect();
            else kept.push(tile);
          }

          // The drawn-tile cap. Nearest first, so what is given up is always the
          // farthest ground rather than the building in the middle.
          // `_distanceToCamera` is the traversal's own metric, refreshed for
          // every tile it visits this frame.
          if (kept.length > MAX_TILES_DRAWN) {
            kept.sort((a, b) => a._distanceToCamera - b._distanceToCamera);
            for (const tile of kept.splice(MAX_TILES_DRAWN)) tile.unselect();
          }

          if (kept.some((tile) => tile.contentAvailable && showsSubject(tile, stage.roof))) {
            stage.onReady?.();
          }
          return kept;
        },
      },
    },
    onTileLoad: (tile) => {
      // Collected from the tiles themselves. Google's copyright is not a
      // constant — it is a property of whose imagery is under you — and it
      // arrives in each glTF's `asset.copyright`, not in the tileset JSON. The
      // tileset carries none at any level; every leaf carries its own.
      //
      // SPLIT ON THE SEMICOLON, and this is not tidying. Each tile's string is
      // already a list — "Google;Data SIO, NOAA, U.S. Navy, NGA, GEBCO;IBCAO" —
      // and neighbouring tiles carry overlapping but not identical lists.
      // Collected whole, twenty tiles produced twenty near-duplicate entries
      // and the caption grew to five lines covering a third of the picture.
      // Split into its sources, the whole campus is one line of about ten
      // names, because that is how many distinct sources there actually are.
      for (const part of (tile?.content?.gltf?.asset?.copyright ?? '').split(';')) {
        const source = part.trim();
        if (source) stage.credits.add(source);
      }
      // The caption has to be repainted as tiles arrive, not written once: the
      // first traversal completes on a handful of tiles and the rest of the
      // sources turn up over the next few seconds.
      stage.onReady?.();
    },
    onTileError: () => {},
    // The one moment the tileset exists and nothing has traversed it yet. Fires
    // once for the tab, because `_loadTileset` runs once — see the note on `id`
    // above. This is where MAX_GPU_MB has to be applied to bite; the option of
    // the same name does nothing.
    onTilesetLoad: (tileset) => {
      tileset.maximumMemoryUsage = MAX_GPU_MB;
    },
    // The perimeter, pushed down onto the layers that actually draw glTF.
    // Tile3DLayer is a composite and renders one ScenegraphLayer per tile, so
    // the extension has to be handed to the sublayer rather than to the parent.
    //
    // `clipByInstance: false` is the load-bearing half. The extension has two
    // modes and picks by whether the layer is instanced: a ScenegraphLayer is,
    // so left alone it would clip by each tile's ANCHOR — showing or hiding
    // whole tiles, which is the ragged per-tile behaviour the clip exists to
    // replace. False forces the fragment path, where every pixel tests its own
    // position and a tile straddling the line is cut along it.
  });
}

function buildStage(tools, view) {
  const host = document.createElement('div');
  host.className = 'g-flyover-stage';

  const canvas = document.createElement('canvas');
  canvas.className = 'g-flyover-canvas';
  host.append(canvas);

  stage.host = host;
  stage.canvas = canvas;
  stage.deck = new tools.Deck({
    canvas,
    views: new tools.MapView({ id: 'flyover' }),
    // No controller, on purpose. See the note at the top of this file: it is
    // what keeps the tiles this pulls inside the campus.
    controller: false,
    initialViewState: view,
    // Nothing sets a clear colour here because deck.gl's own default is already
    // a transparent clear, which is what this wants: the grid behind the canvas
    // shows through everywhere the clip discarded, which is the whole point of
    // drawing a grid there.
    layers: stage.base,
  });
}

/**
 * Build a flyover viewport for one place.
 *
 * Returns immediately with an element to put in a card; the canvas arrives in
 * it once the toolkit has loaded, and the spinner comes off once there are
 * tiles. The caller MUST call `destroy()` when the card goes away — not to free
 * the renderer, which is deliberately kept, but to stop the orbit and release
 * the canvas for the next card.
 *
 * @param {object}   options
 * @param {string}   options.key      Google browser API key.
 * @param {number[]} options.centre   [lon, lat] to orbit.
 * @param {number}   options.span     Ground width to hold in frame, metres.
 * @param {number}   options.pitch    Camera tilt off nadir, degrees.
 * @param {number}   options.maxTileSpan  Widest tile worth drawing, metres.
 * @param {number[][]} options.box    [[w, s], [e, n]] tiles are loaded inside.
 * @param {string}  [options.name]    For the spinner's caption and the a11y label.
 * @param {number[]} [options.roof]   [lon, lat, z] the pin drops onto; see roofOf.
 * @param {boolean} [options.fps]     Draw a frame-rate readout over the view.
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createFlyover({
  key, centre, span, pitch, maxTileSpan, bounds, name, roof, footprint, mass,
  fps = false,
}) {
  /** Identity for this card's claim on the shared canvas. */
  const token = {};

  /**
   * When the pin's fall began, or 0 while there is still nothing to fall onto.
   *
   * Set by the orbit once two things are true — the roof's own tile has content
   * and the tileset has gone quiet — and read by it on every frame after. The
   * orbit starts turning before either, so this cannot be the orbit's own clock.
   */
  let dropAt = 0;
  /** Whether the roof this pin is aimed at has actually loaded. */
  let roofReady = false;
  /** When the building first appeared, which HOLD_MS is counted from. */
  let shownAt = 0;

  const el = document.createElement('figure');
  el.className = 'g-flyover';

  /**
   * The frame-rate readout, when the back room asks for one.
   *
   * MEASURED WHERE THE FRAMES ARE, which is the point of it being here rather
   * than a page-wide counter. The orbit runs its own rAF and hands deck.gl a new
   * view and new layers on each pass; a counter on the document tells you the
   * PAGE is ticking over, which it is, and says nothing about whether this
   * viewport got a frame. The gap between those two is exactly where the pin's
   * landing stutters live.
   *
   * Three numbers, because one is not enough to see a stall. The average is what
   * the eye reports; the median frame gap is what it should be; and the worst
   * gap in the last window is the one that shows up as a hitch and never appears
   * in an average. A run of 60 fps with a 90 ms frame in it is not a smooth run.
   */
  const meter = fps ? document.createElement('div') : null;
  if (meter) {
    meter.className = 'g-flyover-fps';
    meter.textContent = '--';
    // Not announced: it is a developer readout over a picture, and a screen
    // reader has no use for a number changing four times a second.
    meter.setAttribute('aria-hidden', 'true');
  }

  /**
   * How long the last few frames took, always — not only when the readout is on.
   *
   * The drop reads this too. See `calm`.
   */
  const recent = [];
  const RECENT = 24;
  /** Frame gaps since the last time the readout was written. */
  const gaps = [];
  let lastFrame = 0;
  let lastWrite = 0;

  function noteFrame(now) {
    if (lastFrame) {
      const gap = now - lastFrame;
      recent.push(gap);
      if (recent.length > RECENT) recent.shift();
      gaps.push(gap);
    }
    lastFrame = now;
  }

  /**
   * Whether this viewport is currently drawing fast enough to animate in.
   *
   * THE FIRST THREE SECONDS OF A COLD FLYOVER ARE NOT LIKE THE REST. Nothing is
   * cached: the tileset root is fetched, the tree is walked, and then thirty or
   * forty tiles arrive at once and each one is a glTF to parse, a set of buffers
   * to upload and a deck.gl sub-layer to build. Parsing moved to a worker, but
   * the GPU upload and the layer construction are main-thread by nature, and
   * they land in a burst. Measured on a cold load, that burst is about three
   * seconds at roughly twenty frames a second.
   *
   * The pin used to fall straight into it — the drop began the moment the roof's
   * own tile reported content, which is the PEAK of the flood rather than the
   * end of it. A hundred and sixty milliseconds of animation over three or four
   * frames is not a fall, it is a jump, and no amount of easing fixes a frame
   * that was never drawn.
   *
   * So it waits for calm — and "calm" took two goes to define, which is the
   * interesting part. Eight frames under 24 ms was the first attempt, and
   * measured under a 6x CPU throttle it fired 742 ms in, reported calm, and the
   * fall still ran at 24 fps: a burst that big has lulls in it, and eight frames
   * is short enough to sit inside one. Half a second of evidence and a ceiling
   * on the WORST frame in it is what actually distinguishes a lull from the end.
   *
   * Median for the floor, because a single 90 ms upload should not veto an
   * otherwise smooth run; a separate cap on the worst, because a run containing
   * a 120 ms frame is not calm however good its median is, and that frame is
   * precisely what a 160 ms fall cannot survive.
   */
  const CALM_MS = 20;
  const CALM_WORST_MS = 45;
  const CALM_FRAMES = 16;
  const CALM_WAIT_MS = 2500;
  const calm = () => {
    if (recent.length < CALM_FRAMES) return false;
    const last = recent.slice(-CALM_FRAMES).sort((a, b) => a - b);
    return last[CALM_FRAMES >> 1] < CALM_MS && last.at(-1) < CALM_WORST_MS;
  };

  function tickMeter(now) {
    if (!meter) return;
    // Four times a second: often enough to watch, slow enough to read.
    if (now - lastWrite < 250 || gaps.length < 2) return;
    lastWrite = now;
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const worst = sorted.at(-1);
    const mean = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
    meter.textContent = `${Math.round(1000 / mean)} fps  ${median.toFixed(1)}ms`
      + `  peak ${worst.toFixed(0)}ms`;
    // Amber once a frame has taken longer than two at 60, which is the point a
    // dropped frame becomes a visible one.
    meter.classList.toggle('is-slow', worst > 33);
    gaps.length = 0;
  }
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', name ? `Aerial view of ${name}` : 'Aerial view');

  const credit = document.createElement('figcaption');
  credit.className = 'g-flyover-credit';
  credit.textContent = FALLBACK_CREDIT;
  el.append(credit);
  // Over the picture and over the credit, because it is a reading of the thing
  // underneath it rather than part of the picture.
  if (meter) el.append(meter);

  const busy = spinnerOverlay('Loading aerial view');
  el.append(busy);

  let frame = 0;
  let dead = false;

  function fail(message) {
    if (dead) return;
    busy.stop?.();
    busy.remove();
    // Replaces the box rather than sitting over it. A viewport that stays empty
    // with a line of text under it reads as still loading.
    el.classList.add('g-flyover--failed');
    const note = document.createElement('p');
    note.className = 'g-flyover-note';
    note.textContent = message;
    el.append(note);
  }

  function destroy() {
    dead = true;
    cancelAnimationFrame(frame);
    busy.stop?.();
    // Only if this card still holds it. The next card may already have taken
    // the canvas — see the note on `stage.owner`.
    if (stage.owner === token) {
      stage.owner = null;
      stage.onReady = null;
      // Not left set. The layer's traversal keeps running for a frame or two
      // after the canvas is detached, and culling those against a box for a
      // building nobody is looking at is the sort of thing that shows up as a
      // blank viewport on the NEXT card.
      stage.maxTileSpan = 0;
      stage.bounds = null;
      stage.roof = null;
      stage.host?.remove();
    }
  }

  loadToolkit().then((tools) => {
    if (dead) return;

    const [longitude, latitude] = centre;
    // Measured off the element rather than assumed, because the sidebar is a
    // different width on a phone and the zoom is a function of it.
    //
    // Safe to measure here even though `el` is returned before the caller puts
    // it in a card: this runs behind `loadToolkit`, which is a dynamic import
    // over the network, while the caller inserts the card synchronously in the
    // same tick that created this. The fallback covers the one case that would
    // break that — a card built into a hidden panel — by producing a sensible
    // camera instead of a division by zero.
    const width = el.clientWidth || 320;
    const height = el.clientHeight || Math.round(width * 0.625);
    /**
     * How far down the frame the camera's target sits, in pixels of padding.
     *
     * WHY THE CAMERA IS NOT AIMED AT THE MIDDLE. deck.gl's MapView aims at a
     * geographic point, which is on the GROUND — so the building grows upward
     * from the centre of the picture and everything above it is sky the shot
     * does not have. At 55 degrees off nadir that was survivable. At 63 it is
     * not: altitude projects further the more oblique the shot, and the
     * Library's roof went out of the top of its own frame, taking the pin
     * standing on it with it.
     *
     * `padding` is deck.gl's own answer and the only one — there is no target
     * altitude to set. It says which box the target is centred in, so top
     * padding puts the ground low in the picture and gives the building the
     * rest of it, moving the target down by half of whatever is asked for.
     *
     * MEASURED PER BUILDING rather than fixed, because a constant is wrong at
     * both ends. Enough padding for the Library, which is tall enough to leave
     * the frame, is half a picture of empty horizon over the Parking Garage,
     * which is a flat deck. So the roof is projected once with no padding at
     * all, and the shot is given exactly the difference between where that put
     * it and where a pin needs it to be. A building with no measured roof asks
     * for nothing, which is what it needs: nothing is standing on it.
     */
    const bare = { longitude, latitude, zoom: zoomFor(span, width, latitude), pitch, bearing: 0 };
    const roofY = roof
      ? new tools.WebMercatorViewport({ ...bare, width, height }).project(roof)[1]
      : height;
    const view = {
      ...bare,
      // Clamped, because a roof projecting above the frame entirely — which the
      // projection can produce even if the framing does not — would otherwise
      // ask for a padding that leaves no viewport to draw in.
      padding: {
        top: Math.round(Math.min(height * 0.6, Math.max(0, WANT_SKY * height - roofY) * 2)),
        bottom: 0,
        left: 0,
        right: 0,
      },
    };

    stage.maxTileSpan = maxTileSpan ?? 0;
    stage.bounds = bounds ? campusBox(bounds) : null;
    stage.roof = roof ?? null;
    // The cage sits between the ground and the tiles in the list and above both
    // on screen: its x-ray pass has the depth test off, so list order is what
    // puts it over the imagery rather than under it.
    stage.base = [makeGrid(tools, centre, span), makeLayer(tools, key)];

    if (!stage.deck) {
      try {
        buildStage(tools, view);
      } catch (error) {
        fail(error?.message ?? 'Aerial view unavailable');
        return;
      }
    } else {
      // Per building, because both the camera and the perimeter are. Replacing
      // rather than mutating is what deck.gl expects of each: a View is
      // immutable once constructed, and a layer's props are read at
      // construction, so a new instance is how either is changed.
      stage.deck.setProps({
        views: new tools.MapView({ id: 'flyover' }),
        layers: stage.base,
      });
    }
    stage.owner = token;
    // Cleared per building, not per tab. The requirement is to credit the
    // imagery being SHOWN, and the tileset outlives any one card — left to
    // accumulate, a card would eventually be crediting sources for a building
    // three taps ago that is nowhere on screen.
    stage.credits.clear();
    el.prepend(stage.host);

    // Called both when a traversal selects tiles and when one finishes loading,
    // so it does two jobs and has to be safe to call repeatedly.
    stage.onReady = () => {
      if (dead) return;
      credit.textContent = [...stage.credits].join(', ') || FALLBACK_CREDIT;
      // HALF of the drop's condition. This one says a fine tile covering the
      // roof has ARRIVED; the other half, `drawn`, says deck.gl has built
      // geometry out of it, and is checked per frame because it becomes true
      // between frames rather than in any callback.
      roofReady = true;
    };

    /**
     * Whether there is anything on screen yet — as opposed to loaded.
     *
     * MEASURED, and it is the difference between a marker landing on a building
     * and a marker landing on an empty grid. Photographed on the Parking Garage:
     * a fine tile covering the roof reported content at 1.2 s and Tile3DLayer
     * had not built a single sublayer out of it until 2.1 s, which is exactly
     * when imagery appeared in the box. Nine hundred milliseconds of a picture
     * that was ready by every signal except the one that matters.
     *
     * Tile3DLayer is a composite, so its geometry is its SUBLAYERS. Every one
     * that exists is also loaded — checked across the whole load, the drawn
     * count never once lagged the sublayer count — so their existence is the
     * whole test and `isLoaded` adds nothing to it.
     *
     * `layerManager` is not part of deck.gl's documented surface, which is why
     * every step of the walk is optional: a release that renames it makes this
     * return false, and false costs the pin its drop rather than throwing inside
     * the orbit. There is no public route to "has this composite drawn yet".
     */
    const drawn = () => !!stage.deck?.layerManager?.getLayers?.()
      ?.some((l) => l.id.startsWith(`${TILES_ID}-`));

    /** Spinner off, once, the moment there is a building to look at. */
    const reveal = () => {
      if (!busy.isConnected) return;
      busy.stop?.();
      busy.remove();
    };

    // How far the pin has to fall to start off camera, in CSS pixels, worked
    // out ONCE from where the roof actually projects — not per frame. The orbit
    // moves the roof around the picture, so a per-frame answer would change the
    // fall's length while the pin was in the middle of it; over the 300 ms this
    // takes the camera turns under four degrees, which moves the roof by a few
    // pixels of a fall that is a couple of hundred.
    // `clear` goes with it: what CLEAR_M of altitude is worth in pixels here, so
    // the pin can be anchored that far above the roof for the depth test and put
    // straight back where it belongs on screen.
    let fall = { drop: 0, clear: 0, px: 0 };
    const measureDrop = (bearing) => {
      const seen = new tools.WebMercatorViewport({ ...view, bearing, width, height });
      const at = seen.project(roof)[1];
      const above = seen.project([roof[0], roof[1], roof[2] + CLEAR_M])[1];
      // The pin's size comes from here too, because it is the only place that
      // knows how much sky the roof has over it. See HEADROOM.
      const px = pinHeight(height, at);
      // Every compression the landing will draw, decoded now. This runs when the
      // drop is MEASURED, which is a beat and a fall ahead of the first squashed
      // frame — without it each step's first appearance is an image decode and an
      // atlas repack inside the 190 ms the pin is compressing. See warmPinIcons.
      warmPinIcons(PUSH_PIN_RED, px);
      return { drop: dropPixels(at, height), clear: at - above, px };
    };

    // `ms` of null means "not yet": before the drop has a reason to start there
    // is no pin at all, rather than a pin parked somewhere. `roof` is absent for
    // anything src/roofs.json has no measured centre for, and an unmarked
    // flyover is a better answer than one marking a guess.
    // The highlight and the pin share one clock, because they are one event:
    // the pin lands and the building it landed on is marked. The highlight is
    // drawn from the FOOTPRINT and only reads `roof` for the plane to hang at,
    // so it is not inside the `roof` guard the pin is — a building with a traced
    // outline and no measured centre still gets outlined, at its peak.
    const marks = (ms) => (ms === null ? [] : [
      ...(SHOW_HIGHLIGHT ? highlightLayers(tools, { footprint, mass, roof, ms }) : []),
      ...(roof ? pinLayers(tools, { roof, ...fall, span, width, height, ms }) : []),
    ]);

    // A still frame under `prefers-reduced-motion`. The three-quarter bearing
    // is not arbitrary — a building photographed square-on from the air reads
    // as a plan, and turning it off-axis is what gives it two visible faces and
    // a depth to it. It is the frame the orbit would have paused at.
    //
    // The pin still lands, because it is not decoration — it is the answer to
    // "which of these buildings". What it loses is the fall: `settled` is past
    // the end of the shutter, so every ghost has caught up and the pin is simply
    // there.
    //
    // It POLLS, briefly, and that is not laziness. The pin may not be drawn
    // until there is a building under it, and "there is a building" becomes true
    // between frames rather than in a callback — see `drawn`. The orbit checks
    // the same thing on the frame it is already drawing; this path has no frames
    // of its own, so it borrows a few and stops as soon as it has an answer.
    if (prefersStill()) {
      // THE FRAME WHERE EVERYTHING HAS FINISHED, which is the later of the two
      // clocks and not the pin's alone. `SETTLED_MS` is when the pin has stopped
      // moving; the highlight fades up behind it and is still climbing then, so
      // borrowing the pin's number parks the still on a mark at a sixth of its
      // strength. It used to agree by accident — the pin waited a second for a
      // label it no longer has.
      const STILL_MS = SHOW_HIGHLIGHT
        ? Math.max(SETTLED_MS, DROP_MS + HIGHLIGHT_UP_MS)
        : SETTLED_MS;
      const settle = (landed) => stage.deck?.setProps({
        viewState: { ...view, bearing: 35 },
        layers: [...stage.base, ...marks(landed ? STILL_MS : null)],
      });
      const wait = () => {
        if (dead || stage.owner !== token) return;
        if (busy.isConnected && drawn()) reveal();
        if (!(roofReady && drawn())) { frame = requestAnimationFrame(wait); return; }
        // Landed, so the fall's length changes nothing on screen — but the
        // trail's spacing is solved from it, and a zero is a division by zero.
        if (roof) fall = measureDrop(35);
        settle(true);
      };
      settle(false);
      frame = requestAnimationFrame(wait);
      return;
    }

    const start = performance.now();
    const tick = (now) => {
      if (dead || stage.owner !== token || !stage.deck) return;
      // Wall-clock rather than a per-frame increment, so the circle takes
      // ORBIT_MS whether the tab is rendering at 120fps or dropping frames
      // decoding tiles — which is exactly when this is running.
      const bearing = (((now - start) / ORBIT_MS) * 360) % 360;
      // Nothing falls onto a building that is not on screen yet — and nothing
      // waits once one is. This used to hold for a further 300 ms of silence
      // from the tileset, on the reasoning that a tile reporting content is not
      // yet a tile on screen. Photographed, the building was up at 133 ms and
      // the pin did not move until 435: the whole of that gap was the wait,
      // spent looking at a finished picture with nothing happening in it.
      //
      // What made it safe to drop is `showsSubject`, which did not exist when
      // the wait was written: readiness now means a tile at 8.5 m of geometric
      // error whose box CONTAINS the roof, rather than any tile anywhere with
      // content. The fall covers the rest — the pin needs DROP_MS to arrive,
      // which is a further 220 ms of cover for a roof still being uploaded.
      // Two different moments, and they are worth separating. The spinner goes
      // the instant there is ANY geometry, because watching a coarse roof sharpen
      // is a better wait than watching a ring turn. The pin waits for the roof's
      // own tile on top of that, because it is about to stand on it.
      noteFrame(now);
      tickMeter(now);
      if (busy.isConnected && drawn()) reveal();
      if (!shownAt && roofReady && drawn()) {
        shownAt = now;
        // Warm the pin's icons HERE rather than at the drop, which is HOLD_MS
        // away. They were being decoded inside `measureDrop`, and measureDrop
        // runs on the very frame the fall starts — thirteen image decodes and an
        // atlas repack landing on frame one of a nineteen-frame animation, which
        // is a stall exactly where it is most visible. `warmPinIcons` is
        // idempotent, so the measurement below is free to ask again.
        if (roof) warmPinIcons(PUSH_PIN_RED, measureDrop(bearing).px);
      }
      // The beat, AND frames to spend it on. The ceiling is what stops a slow
      // device waiting for a calm that is not coming: past it the pin falls
      // regardless, because a pin that never drops is worse than one that drops
      // roughly. Two and a half seconds is longer than the cold burst measured
      // above and shorter than anyone will sit still for.
      const waited = shownAt ? now - shownAt : 0;
      if (shownAt && !dropAt && waited >= HOLD_MS && (calm() || waited >= HOLD_MS + CALM_WAIT_MS)) {
        dropAt = now;
        // A dev-only mark, the same kind of handle as `window.__map`. Whether
        // the pin waited for calm or timed out is the one thing about this that
        // cannot be read off the outside, and it is stripped from the build.
        if (import.meta.env.DEV) {
          window.__flyoverDrop = { at: now, waited: Math.round(waited), calm: calm() };
        }
        if (roof) fall = measureDrop(bearing);
      }
      stage.deck.setProps({
        viewState: { ...view, bearing },
        layers: [...stage.base, ...marks(dropAt ? now - dropAt : null)],
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }).catch((error) => fail(error?.message ?? 'Aerial view unavailable'));

  return { el, destroy };
}
