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
import { M_PER_DEG_LAT, M_PER_DEG_LON } from './flyover.js';

const TILESET = 'https://tile.googleapis.com/v1/3dtiles/root.json';

/** One full circle, in ms. */
const ORBIT_MS = 30_000;

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
 * because the tileset evicts. loaders.gl keeps an LRU of loaded tiles against
 * this budget and unloads the least recently used ones past it; over budget it
 * also raises its own working screen-space error, so a device under pressure
 * degrades to coarser tiles instead of failing. Both behaviours are in
 * Tileset3D — see `_unloadTiles` and `memoryAdjustedScreenSpaceError`.
 *
 * Never unloading was the alternative and would have been a real problem, not a
 * theoretical one: this is DECODED geometry, several times the 124 KiB the tile
 * arrived as, and holding a campus of it would be hundreds of megabytes of GPU
 * memory on a phone that is also running Mapbox GL.
 *
 * 24 rather than the library's 32 because this viewport is a fifth of the
 * screen at most and never needs the working set a full-page globe does.
 */
const MAX_GPU_MB = 24;

/**
 * The hard ceiling on how many tiles may be drawn in one frame.
 *
 * The memory budget above is a rolling one — it evicts after the fact, once the
 * decoded geometry is already on the GPU. This is the one that acts before
 * anything is drawn, and it is what a low-end device actually needs: a phone
 * that cannot hold sixty draw calls at 60fps does not want to find that out by
 * making them. loaders.gl keeps the closest N and drops the rest (see
 * `limitSelectedTiles`, which sorts by distance to camera), so what is given up
 * is always the farthest ground rather than the building in the middle.
 *
 * Zero is the library's default and means unlimited.
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
  import('@deck.gl/extensions'),
  import('@deck.gl/layers'),
]).then(([core, geo, tiles, ext, layers]) => ({
  Deck: core.Deck,
  MapView: core.MapView,
  Tile3DLayer: geo.Tile3DLayer,
  Tiles3DLoader: tiles.Tiles3DLoader,
  LineLayer: layers.LineLayer,
  Clip: geoClip(ext.ClipExtension, core.COORDINATE_SYSTEM),
})).catch((error) => {
  // Not cached on failure, so a flyover opened on a dropped connection can be
  // retried by closing the card and opening it again.
  toolkit = null;
  throw error;
}));

/**
 * deck.gl's clip extension, taught which coordinate system the bounds are in.
 *
 * THIS IS THE PERIMETER. Everything else in this file that mentions the box
 * decides which TILES to ask for and which to draw; this is the thing that
 * decides which PIXELS survive, and it is the difference between a bound and a
 * boundary. A tile is a few dozen metres of ground either side of an arbitrary
 * line of Google's choosing, so culling by tile leaves a ragged edge that
 * wanders in and out of the box by the width of whatever tile straddled it.
 * The extension discards fragments instead: it hands the shader a rectangle,
 * every fragment tests its own 2D position against it, and what comes out is a
 * clean square of ground with the grid around it.
 *
 * Wrapped rather than used directly because of one line in the stock `draw()`:
 * it calls `this.projectPosition(clipBounds)`, and `projectPosition` reads the
 * coordinate system off the LAYER it is called on. Tile3DLayer builds each of
 * its sublayers as `METER_OFFSETS` around that tile's own cartographic origin,
 * so the stock version hands a pair of longitudes and latitudes to a projection
 * that is expecting metres, and the clip lands somewhere off the coast of
 * Africa. Saying where the numbers come from is the whole fix.
 *
 * Built through a function because @deck.gl/extensions is lazily imported —
 * there is no ClipExtension to subclass until the toolkit has landed.
 */
function geoClip(ClipExtension, COORDINATE_SYSTEM) {
  return class GeoClipExtension extends ClipExtension {
    draw() {
      const { clipBounds } = this.props;
      const from = {
        fromCoordinateSystem: COORDINATE_SYSTEM.LNGLAT,
        fromCoordinateOrigin: [0, 0, 0],
        // The second half of the fix, and the one that made the clip discard
        // the entire viewport rather than merely land in the wrong place.
        // `projectPosition` runs the point through `this.props.modelMatrix`
        // BEFORE projecting it, and every one of these sublayers carries the
        // tile's own ECEF transform there — so a longitude and a latitude were
        // being multiplied by a matrix built for metres near the Earth's core.
        modelMatrix: null,
      };
      const a = this.projectPosition([clipBounds[0], clipBounds[1], 0], from);
      const b = this.projectPosition([clipBounds[2], clipBounds[3], 0], from);
      this.setShaderModuleProps({
        clip: {
          bounds: [
            Math.min(a[0], b[0]), Math.min(a[1], b[1]),
            Math.max(a[0], b[0]), Math.max(a[1], b[1]),
          ],
        },
      });
    }
  };
}

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
 * Whether a tile belongs inside the building's box — in all three dimensions.
 *
 * `boundingBox` is loaders.gl's own cartographic extent of the tile,
 * `[[west, south, minHeight], [east, north, maxHeight]]`, with the heights in
 * metres above the WGS84 ellipsoid. It is computed from whichever volume type
 * the tile declared and cached on first access, so asking every frame costs
 * three comparisons rather than a projection.
 *
 * TWO TESTS, because one is not enough and the reason is specific to how a
 * tile pyramid is shaped.
 *
 *   OVERLAP, on all three axes. This is the box proper. The vertical axis was
 *   missing from the first version, which made the bound a column of infinite
 *   height — over a tileset whose coarse levels are literally kilometres tall
 *   (the depth-2 slab over my campus starts 742 km up) that is not a rounding error.
 *
 *   SIZE, because overlap alone rejects almost nothing. Every ancestor of a
 *   tile over the campus contains the campus — that is what makes it an
 *   ancestor — so no overlap test can ever reject one. Measured against the
 *   live tileset, overlap rejects one of the eighteen tiles covering the
 *   Parking Garage. The size test rejects the ones that are mostly not the
 *   building: kilometre-wide slabs drawn at a few pixels of detail, which exist
 *   only to be replaced by their children.
 *
 * Overlap rather than containment for the first test, and it has to be:
 * Google's tiles line up with nothing, so a tile holding half the building also
 * holds ground well outside the box. Containment would drop exactly the tiles
 * the building is standing on.
 *
 * A tile that cannot say where it is, is kept. The failure this guards against
 * is a tileset shape this does not know how to read, and losing the picture
 * over one is worse than drawing a little too much of it.
 */
function inBox(tile, box) {
  let extent;
  try {
    extent = tile.boundingBox;
  } catch {
    return true;
  }
  if (!extent) return true;

  const [lo, hi] = extent;
  const { min, max, maxTileSpan } = box;
  for (let axis = 0; axis < 3; axis += 1) {
    if (lo[axis] > max[axis] || hi[axis] < min[axis]) return false;
  }

  // Degrees to metres on the ground. Latitude is the tighter of the two here
  // and the cheaper to be wrong about, so the wider span decides.
  const wide = Math.max((hi[0] - lo[0]) * M_PER_DEG_LON, (hi[1] - lo[1]) * M_PER_DEG_LAT);
  return wide <= maxTileSpan;
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
   * outlives every card — so the box has to be reachable from the stage rather
   * than closed over at layer construction, or every building after the first
   * would be culled against the first one's box.
   */
  box: null,
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

function makeLayer({ Tile3DLayer, Tiles3DLoader, Clip }, key, box) {
  return new Tile3DLayer({
    // Constant id and constant `data`, which is what stops the tileset being
    // reloaded. deck.gl matches layers across renders by id and only calls
    // `_loadTileset` when `props.data` actually changes — so every subsequent
    // building reuses the tree that is already in memory, and pays nothing.
    id: 'flyover-tiles',
    data: TILESET,
    loader: Tiles3DLoader,
    loadOptions: {
      fetch: keyedFetch(key),
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
        maximumMemoryUsage: MAX_GPU_MB,
        maximumTilesSelected: MAX_TILES_DRAWN,
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
          // The box, applied to DRAWING. The far plane has already cut most of
          // what is outside it, but a plane is only a plane: it stops the
          // camera looking further, not sideways, so ground beside the building
          // still arrives. This is the exact test, and what it excludes is
          // where the grid shows through.
          const box = stage.box;
          const kept = box ? selected.filter((tile) => inBox(tile, box)) : selected;
          if (kept.some((tile) => tile.contentAvailable)) stage.onReady?.();
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
    _subLayerProps: box ? {
      scenegraph: {
        extensions: [new Clip()],
        clipBounds: [box.min[0], box.min[1], box.max[0], box.max[1]],
        clipByInstance: false,
      },
    } : undefined,
  });
}

function buildStage(tools, key, view, box, centre, span) {
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
    layers: [makeGrid(tools, centre, span), makeLayer(tools, key, box)],
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
 * @param {number}   options.reach    Half-width of the tile box, metres.
 * @param {number[][]} options.box    [[w, s], [e, n]] tiles are loaded inside.
 * @param {string}  [options.name]    For the spinner's caption and the a11y label.
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createFlyover({ key, centre, span, pitch, reach, box, name }) {
  /** Identity for this card's claim on the shared canvas. */
  const token = {};

  const el = document.createElement('figure');
  el.className = 'g-flyover';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', name ? `Aerial view of ${name}` : 'Aerial view');

  const credit = document.createElement('figcaption');
  credit.className = 'g-flyover-credit';
  credit.textContent = FALLBACK_CREDIT;
  el.append(credit);

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
      stage.box = null;
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
    const view = { longitude, latitude, zoom: zoomFor(span, width, latitude), pitch, bearing: 0 };

    stage.box = box ?? null;

    if (!stage.deck) {
      try {
        buildStage(tools, key, view, box, centre, span);
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
        layers: [makeGrid(tools, centre, span), makeLayer(tools, key, box)],
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
      // The spinner goes as soon as there is something to look at, rather than
      // when the whole set has landed. Waiting for the traversal to go quiet
      // would hold a spinner over a scene that is already showing the building;
      // the remaining tiles refine what is on screen, and watching a roof
      // sharpen is a better wait than watching a ring turn.
      if (!busy.isConnected) return;
      busy.stop?.();
      busy.remove();
    };

    // A still frame under `prefers-reduced-motion`. The three-quarter bearing
    // is not arbitrary — a building photographed square-on from the air reads
    // as a plan, and turning it off-axis is what gives it two visible faces and
    // a depth to it. It is the frame the orbit would have paused at.
    if (prefersStill()) {
      stage.deck.setProps({ viewState: { ...view, bearing: 35 } });
      return;
    }

    const start = performance.now();
    const tick = (now) => {
      if (dead || stage.owner !== token || !stage.deck) return;
      // Wall-clock rather than a per-frame increment, so the circle takes
      // ORBIT_MS whether the tab is rendering at 120fps or dropping frames
      // decoding tiles — which is exactly when this is running.
      const bearing = (((now - start) / ORBIT_MS) * 360) % 360;
      stage.deck.setProps({ viewState: { ...view, bearing } });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }).catch((error) => fail(error?.message ?? 'Aerial view unavailable'));

  return { el, destroy };
}
