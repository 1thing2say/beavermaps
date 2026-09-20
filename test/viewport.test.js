// src/viewport.js — how much canvas the chrome is standing on.
//
// Every rule in here was arrived at by opening the app and seeing something
// wrong, and the comments record three of those occasions: the athletics field
// framed at z11 under a full-height sheet, the campus put underneath a bottom
// sheet whose width was reserved as if it were a sidebar, and three bus stops
// that counted as "in view" from behind a pane of glass. None of it could be
// checked without a phone, because it read the DOM and called map.project.
//
// It is rectangles. These are rectangles.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIT_MARGIN, MIN_VIEW, paddingAround, padBelowSheet, isVisible,
} from '../src/viewport.js';

/** A canvas at the origin, the way Mapbox reports one. */
const canvasOf = (width, height) => ({
  left: 0, top: 0, right: width, bottom: height, width, height,
});

const box = ({ left, top, width, height }) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});

const EVEN = {
  top: FIT_MARGIN, bottom: FIT_MARGIN, left: FIT_MARGIN, right: FIT_MARGIN,
};

const DESKTOP = canvasOf(1440, 900);
const PHONE = canvasOf(402, 874);

test('with nothing open the margin is even all round', () => {
  assert.deepEqual(paddingAround({ canvas: DESKTOP, boxes: [] }), EVEN);
});

test('a canvas that has not been laid out yet gets an even margin', () => {
  // Mapbox throws if padding exceeds the canvas, and a zero-width canvas is
  // what the constructor sees before the first layout.
  assert.deepEqual(paddingAround({ canvas: canvasOf(0, 0), boxes: [] }), EVEN);
  assert.deepEqual(paddingAround({ canvas: null, boxes: [] }), EVEN);
});

test('a card with no width is not a card', () => {
  // `.hidden` is a class, and a hidden element still has a rect — an empty one.
  const empty = box({ left: 0, top: 0, width: 0, height: 0 });
  assert.deepEqual(paddingAround({ canvas: DESKTOP, boxes: [empty] }), EVEN);
});

test('a card on the left reserves the left edge', () => {
  const card = box({ left: 16, top: 80, width: 360, height: 500 });
  const pad = paddingAround({ canvas: DESKTOP, boxes: [card] });
  assert.equal(pad.left, 376 + FIT_MARGIN);
  assert.equal(pad.right, FIT_MARGIN);
});

test('a card on the right reserves the right edge', () => {
  // Until the legend moved over there nothing was ever in the right half, and
  // a card there used to be skipped outright.
  const legend = box({ left: 1080, top: 80, width: 300, height: 400 });
  const pad = paddingAround({ canvas: DESKTOP, boxes: [legend] });
  assert.equal(pad.right, DESKTOP.right - 1080 + FIT_MARGIN);
  assert.equal(pad.left, FIT_MARGIN);
});

test('both edges at once, and the widest card on each side wins', () => {
  // Three stack in the left column and the legend holds the right edge.
  const boxes = [
    box({ left: 16, top: 80, width: 300, height: 200 }),
    box({ left: 16, top: 300, width: 380, height: 200 }),   // the wider one
    box({ left: 1100, top: 80, width: 280, height: 300 }),
  ];
  const pad = paddingAround({ canvas: DESKTOP, boxes });
  assert.equal(pad.left, 396 + FIT_MARGIN);
  assert.equal(pad.right, DESKTOP.right - 1100 + FIT_MARGIN);
});

test('a screen too narrow to hold both sides falls back to an even margin', () => {
  // Mapbox throws if the padding exceeds the canvas. Letting the chrome overlap
  // is the lesser failure.
  const narrow = canvasOf(600, 800);
  const boxes = [
    box({ left: 0, top: 0, width: 280, height: 400 }),
    box({ left: 330, top: 0, width: 270, height: 400 }),
  ];
  assert.deepEqual(paddingAround({ canvas: narrow, boxes }), EVEN);
});

test('a phone-width card costs height, not width', () => {
  // Below 640px the column becomes a bottom sheet spanning the full width.
  // Reserving its width would exceed the canvas and fall back to an even
  // margin, which puts the campus underneath it.
  const sheet = box({ left: 0, top: 500, width: PHONE.width, height: 374 });
  const pad = paddingAround({ canvas: PHONE, boxes: [sheet] });

  assert.equal(pad.left, FIT_MARGIN, 'it reserved width for a full-width sheet');
  assert.equal(pad.right, FIT_MARGIN);
  assert.equal(pad.bottom, PHONE.bottom - 500 + FIT_MARGIN);
});

test('either card can be the sheet', () => {
  // On a phone the legend replaces the route panel rather than stacking under
  // it, so this asks the boxes rather than one named element. The highest top
  // edge wins, because that is the one covering most canvas.
  const boxes = [
    box({ left: 0, top: 620, width: PHONE.width, height: 254 }),
    box({ left: 0, top: 500, width: PHONE.width, height: 374 }),
  ];
  assert.equal(paddingAround({ canvas: PHONE, boxes }).bottom, PHONE.bottom - 500 + FIT_MARGIN);
});

test('a sheet that would eat the whole canvas is ignored', () => {
  const swallowing = box({ left: 0, top: 20, width: PHONE.width, height: 854 });
  assert.deepEqual(paddingAround({ canvas: PHONE, boxes: [swallowing] }), EVEN);
});

// --- the sheet's own guard -------------------------------------------------

const below = (sheetTop, canvas = PHONE, pad = EVEN) => padBelowSheet({
  pad, sheetTop, canvasBottom: canvas.bottom, canvasHeight: canvas.height,
});

test('no sheet means no adjustment', () => {
  assert.deepEqual(below(null), EVEN);
  assert.deepEqual(below(undefined), EVEN);
});

test('a half-height sheet is reserved', () => {
  const pad = below(500);
  assert.equal(pad.bottom, PHONE.bottom - 500 + FIT_MARGIN);
  assert.equal(pad.top, FIT_MARGIN, 'it changed something other than the bottom');
});

test('a sheet that leaves too thin a strip is ignored entirely', () => {
  // THE ATHLETICS FIELD AT Z11. The old guard was "leave SOME canvas", and a
  // sheet at `full` passed it with 110px to spare — into which fitBounds duly
  // squeezed forty miles of the county with the five buildings you asked about
  // as a smudge under the glass.
  const leftOver = PHONE.height * MIN_VIEW;
  const tooTall = PHONE.height - leftOver - FIT_MARGIN + 10;   // just inside the floor
  assert.deepEqual(below(PHONE.height - tooTall), EVEN, 'it framed into a sliver');
});

test('the floor is MIN_VIEW of the canvas, measured from the padded top', () => {
  // Sweep the sheet up the screen and find where it stops being reserved. The
  // boundary has to be where MIN_VIEW says it is, not merely somewhere.
  let lastReserved = null;
  for (let top = PHONE.height; top >= 0; top -= 1) {
    const pad = below(top);
    if (pad.bottom !== EVEN.bottom) lastReserved = top;
  }
  const strip = PHONE.height - (PHONE.bottom - lastReserved + FIT_MARGIN) - FIT_MARGIN;
  assert.ok(strip >= PHONE.height * MIN_VIEW, `left a ${strip}px strip`);
  assert.ok(strip < PHONE.height * MIN_VIEW + 2, `left ${strip}px, more than the floor needs`);
});

// --- and whether a point can be read ---------------------------------------

test('a point in the middle of an unobstructed canvas is visible', () => {
  assert.equal(isVisible({ point: { x: 700, y: 450 }, width: 1440, height: 900, pad: EVEN }), true);
});

test('a point behind the sidebar is not visible, though it is on the canvas', () => {
  // The three bus stops at the west edge. map.getBounds().contains() said yes,
  // because bounds are the whole canvas including the strip behind the glass.
  const pad = { ...EVEN, left: 400 };
  assert.equal(isVisible({ point: { x: 120, y: 450 }, width: 1440, height: 900, pad }), false);
});

test('a point behind the sheet is not visible', () => {
  const pad = { ...EVEN, bottom: 420 };
  assert.equal(isVisible({ point: { x: 200, y: 700 }, width: 402, height: 874, pad }), false);
});

test('the padded rectangle is inclusive at its edges', () => {
  const at = (x, y) => isVisible({ point: { x, y }, width: 1000, height: 800, pad: EVEN });
  assert.equal(at(FIT_MARGIN, FIT_MARGIN), true);
  assert.equal(at(1000 - FIT_MARGIN, 800 - FIT_MARGIN), true);
  assert.equal(at(FIT_MARGIN - 1, FIT_MARGIN), false);
  assert.equal(at(1000 - FIT_MARGIN + 1, 800 - FIT_MARGIN), false);
});

test('a point off the canvas entirely is not visible', () => {
  const at = (x, y) => isVisible({ point: { x, y }, width: 1000, height: 800, pad: EVEN });
  assert.equal(at(-500, 400), false);
  assert.equal(at(400, 3000), false);
});
