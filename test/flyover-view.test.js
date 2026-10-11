// src/flyover-view.js — the shared stage, and the ways it used to stop for good.
//
// The flyover keeps ONE Deck and one tileset for the tab, by design (it is a
// billing decision; see the top of that file). Every failure here was the price
// of that sharing going unhandled: a renderer that never got a WebGL context, or
// lost the one it had, left every later card blank; a render loop kept ticking
// after the card closed; and the pin dropped on the first coarse tile rather
// than on the roof.
//
// The module imports a stylesheet (through src/spinner.js) and deck.gl, neither
// of which node can load, so both are swapped for fakes at resolve time. The
// stage is module state and outlives every card, exactly as it does in a tab,
// so these tests run in order against one stage, and each leaves it with no
// card open.

import test from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { element } from './fake-dom.js';

// ---------------------------------------------------------------------------
// The fakes
// ---------------------------------------------------------------------------

const fakes = {
  decks: [],
  tileLayers: [],
  /** What the next Deck does once constructed. Replaced per test. */
  onDeck: () => {},
};
globalThis.flyoverFakes = fakes;

class Layer { constructor(props) { this.props = props; this.id = props.id; } }
class Tile3DLayer extends Layer {
  constructor(props) { super(props); fakes.tileLayers.push(this); }
}

class Deck {
  constructor(props) {
    this.props = { ...props };
    this.sublayers = [];
    this.layerManager = { getLayers: () => this.sublayers };
    this.calls = { start: 0, stop: 0, finalize: 0 };
    this.animationLoop = {
      start: () => { this.calls.start += 1; return Promise.resolve(this.animationLoop); },
      stop: () => { this.calls.stop += 1; return this.animationLoop; },
    };
    fakes.decks.push(this);
    fakes.onDeck(this);
  }

  setProps(props) { Object.assign(this.props, props); }

  finalize() { this.calls.finalize += 1; this.layerManager = null; }

  /** As if Tile3DLayer had built a sublayer for a tile. */
  draw() {
    const tiles = this.props.layers.find((l) => l instanceof Tile3DLayer);
    this.sublayers = [{ id: `${tiles.id}-scenegraph-1` }];
  }
}

class WebMercatorViewport {
  // Anywhere comfortably inside a 320 x 200 frame.
  project() { return [160, 120]; }
}

Object.assign(fakes, {
  Deck, Tile3DLayer, WebMercatorViewport,
  MapView: Layer, LineLayer: Layer, IconLayer: Layer, PathLayer: Layer, SolidPolygonLayer: Layer,
});

const fromFakes = (...names) => names
  .map((n) => `export const ${n} = globalThis.flyoverFakes.${n};`).join('\n');

const MODULES = {
  '@deck.gl/core': fromFakes('Deck', 'MapView', 'WebMercatorViewport'),
  '@deck.gl/geo-layers': fromFakes('Tile3DLayer'),
  '@loaders.gl/3d-tiles': 'export const Tiles3DLoader = {};',
  '@deck.gl/layers': fromFakes('LineLayer', 'IconLayer', 'PathLayer', 'SolidPolygonLayer'),
  // Its stylesheet is the one thing on this path node cannot import.
  './spinner.js': 'export const spinnerOverlay = () => globalThis.flyoverFakes.spinner();',
};

/** One resolver, written once and installed with whichever API this node has. */
const resolverSource = `
  let modules;
  export function initialize(data) { modules = data; }
  export function resolve(specifier, context, next) {
    const source = modules[specifier];
    const ours = !specifier.startsWith('.') || context.parentURL?.endsWith('/src/flyover-view.js');
    if (source === undefined || !ours) return next(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
`;
const resolverUrl = `data:text/javascript,${encodeURIComponent(resolverSource)}`;
if (module.registerHooks) {
  const hooks = await import(resolverUrl);
  hooks.initialize(MODULES);
  module.registerHooks({ resolve: hooks.resolve });
} else {
  module.register(resolverUrl, { data: MODULES });
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** fake-dom's element, plus the few things a card does that it does not. */
function node(tag) {
  const el = element('', tag);
  el.setAttribute = () => {};
  el.prepend = (child) => { el.appendChild(child); el.children.unshift(el.children.pop()); };
  Object.defineProperty(el, 'isConnected', { get: () => el.parent !== null });
  el.clientWidth = 320;
  el.clientHeight = 200;
  return el;
}
fakes.spinner = () => {
  const busy = node('div');
  busy.className = 'g-spinner';
  busy.stop = () => {};
  return busy;
};

globalThis.window = { devicePixelRatio: 1 };
globalThis.document = { createElement: node, documentElement: node('html') };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

/** Frames are run by hand, at a clock the test chooses. */
let frames = new Map();
let nextFrame = 1;
globalThis.requestAnimationFrame = (fn) => { frames.set(nextFrame, fn); return nextFrame++; };
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
let clock = 0;
function runFrames(count, gap = 16) {
  for (let i = 0; i < count; i += 1) {
    clock += gap;
    const due = frames;
    frames = new Map();
    for (const fn of due.values()) fn(clock);
  }
}

// Collected rather than printed: the failure paths log by design.
const errors = [];
console.error = (...args) => errors.push(args);

const { createFlyover } = await import('../src/flyover-view.js');

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A card for the Library, without a pin unless it asks for one. */
async function open(options = {}) {
  const card = createFlyover({
    key: 'k', centre: [-121.3464, 38.6492], span: 120, pitch: 63, maxTileSpan: 200,
    name: 'Library', ...options,
  });
  for (let i = 0; i < 5; i += 1) await settle();
  return card;
}

const failed = (card) => card.el.classList.contains('g-flyover--failed');
const spinning = (card) => card.el.children.some((c) => c.classList.contains('g-spinner'));
const latestTiles = () => fakes.tileLayers.at(-1);

// ---------------------------------------------------------------------------
// The tests, in tab order
// ---------------------------------------------------------------------------

test('a Deck that never gets a WebGL context fails the card instead of spinning', async () => {
  // What luma does: the device is created asynchronously, its failure goes to
  // onError, and the constructor itself returns normally.
  fakes.onDeck = (deck) => queueMicrotask(
    () => deck.props.onError(new Error('Failed to create WebGL context')),
  );
  const card = await open();
  assert.equal(fakes.decks.length, 1);
  assert.ok(failed(card), 'the card says so');
  assert.ok(!spinning(card), 'and stops spinning');
  card.destroy();

  // The next card does not inherit the dead renderer.
  fakes.onDeck = () => {};
  const next = await open();
  assert.equal(fakes.decks.length, 2, 'a fresh Deck');
  assert.equal(fakes.decks[0].calls.finalize, 1, 'and the broken one let go');
  assert.ok(!failed(next));
  next.destroy();
});

test('a layer error is logged and leaves the renderer alone', async () => {
  const card = await open();
  const deck = fakes.decks.at(-1);
  errors.length = 0;
  deck.props.onError(new Error('bad tile'), latestTiles());
  assert.ok(!failed(card));
  assert.equal(errors.length, 1);
  card.destroy();
  const next = await open();
  assert.equal(fakes.decks.at(-1), deck, 'still the same Deck');
  next.destroy();
});

test('a lost context fails the card, and the next card builds a new stage', async () => {
  const card = await open();
  const deck = fakes.decks.at(-1);
  deck.props.canvas.fire('webglcontextlost');
  assert.ok(failed(card));
  card.destroy();

  const next = await open();
  assert.notEqual(fakes.decks.at(-1), deck);
  assert.equal(deck.calls.finalize, 1);
  next.destroy();
});

test('the render loop stops when the card closes and resumes for the next', async () => {
  const card = await open();
  const deck = fakes.decks.at(-1);
  const before = fakes.decks.length;
  const { stop, start } = deck.calls;
  card.destroy();
  assert.equal(deck.calls.stop, stop + 1);

  const next = await open();
  assert.equal(fakes.decks.length, before, 'no second Deck');
  assert.equal(deck.calls.start, start + 1);
  next.destroy();
});

test('a coarse tile arriving does not drop the pin; the roof\'s own tile does', async () => {
  const roof = [-121.3464, 38.6492, 20];
  const card = await open({ roof });
  const deck = fakes.decks.at(-1);
  const pins = () => deck.props.layers.length - 2;
  deck.draw();

  // A 64 m ancestor lands, as one does first on a cold load. Four seconds is
  // past HOLD_MS plus the calm ceiling, so a drop would have happened by now.
  latestTiles().props.onTileLoad({ content: { gltf: { asset: { copyright: 'Google;Landsat' } } } });
  runFrames(250);
  assert.equal(pins(), 0, 'no pin on a coarse tile');
  const caption = card.el.children.find((c) => c.tag === 'figcaption');
  assert.equal(caption.textContent, 'Google, Landsat', 'the credit still follows the tiles');

  // The traversal finds an 8 m tile over the roof — narrower than maxTileSpan,
  // or it would be culled as one of the coarse slabs.
  const box = [[roof[0] - 0.0004, roof[1] - 0.0004, 0], [roof[0] + 0.0004, roof[1] + 0.0004, 40]];
  latestTiles().props.loadOptions.tileset.onTraversalComplete([{
    geometricError: 8, contentAvailable: true, boundingBox: box, unselect() {}, _distanceToCamera: 0,
  }]);
  runFrames(250);
  assert.ok(pins() > 0, 'the pin is down');
  card.destroy();
});
