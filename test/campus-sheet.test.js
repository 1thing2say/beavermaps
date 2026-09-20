// src/campus-sheet.js — the printed sheet, drawn at the size things are.
//
// `groundWidth` converts METRES ON THE GROUND into pixels at a zoom, through a
// constant that is a property of the Web Mercator projection at this campus's
// latitude. That is arithmetic with a right answer, and it was buried in the
// middle of a seven-thousand-line file where nothing could ask it anything.
//
// `closedBearing` is the other one: it reads the grain of a shape out of a
// generated artifact, so that a rebuild which nudges the geometry cannot leave
// a hard-coded angle quietly wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  M_PER_PIXEL_AT_Z0, CLOSED_KIND, CLOSED_TEXT, CLOSED_RED, CLOSED_INK, closedBearing,
} from '../src/campus-sheet.js';
import { load, contrast } from './helpers.js';

test('the metres-per-pixel constant is Web Mercator at this latitude', () => {
  // 40075016.686 m of equator / 256 px at z0, times cos(38.65°).
  const equator = 40075016.686 / 256;
  const here = equator * Math.cos((38.64916 * Math.PI) / 180);
  assert.ok(Math.abs(M_PER_PIXEL_AT_Z0 - here) / here < 0.02,
    `${M_PER_PIXEL_AT_Z0} is not ${here.toFixed(0)} — the projection or the latitude moved`);
});

test('a path drawn at its true width is a sane number of pixels', () => {
  // The sheet's default path is 1.65 m across. At z18 that should be a few
  // pixels — visible, not a motorway. This is the check that catches a units
  // slip in either direction.
  const metres = 1.65;
  const pixelsAt = (zoom) => metres * (2 ** zoom / M_PER_PIXEL_AT_Z0);

  assert.ok(pixelsAt(18) > 2 && pixelsAt(18) < 12, `${pixelsAt(18).toFixed(1)}px at z18`);
  assert.ok(pixelsAt(20) > pixelsAt(18), 'it does not grow with zoom');
  // At campus overview the true width is below a pixel, which is exactly why
  // groundWidth takes a floor.
  assert.ok(pixelsAt(14) < 1, `${pixelsAt(14).toFixed(2)}px at z14 — the floor is unused`);
});

test('the closed block names itself the same way in both halves', () => {
  // One is a `kind` on the sheet, the other is the word drawn over it. They are
  // deliberately different strings, and pin-state.js needs the second to keep
  // that label out of the printed set.
  assert.equal(CLOSED_KIND, 'closed');
  assert.equal(CLOSED_TEXT, 'Closed');
});

test('the closed red is one hue, and its ink is legible on both themes', () => {
  // The wash, hatch and outline are the same hue at three opacities, so the
  // shape reads as one object. The TEXT cannot join them — it has to stay
  // legible as type.
  assert.match(CLOSED_RED, /^#[0-9a-f]{6}$/i);
  assert.ok(contrast(CLOSED_INK.light, '#ffffff') > 3.5, 'the light-theme ink is too pale');
  assert.ok(contrast(CLOSED_INK.dark, '#111111') > 3.5, 'the dark-theme ink is too dark');
});

test('the bearing is read off the real geometry', () => {
  const basemap = load('basemap');
  const shape = basemap.features.find((f) => f.properties.kind === CLOSED_KIND);
  if (!shape) return;   // the sheet no longer carries one; nothing to prove

  const angle = closedBearing(basemap);
  assert.ok(Number.isFinite(angle), `${angle}`);
  // Normalised to the half-turn that reads left to right, so the word is never
  // upside down whichever way round the ring was wound.
  assert.ok(angle > -90 && angle <= 90, `${angle}° would set the word upside down`);
});

test('the block really is on the diagonal, which is why this exists at all', () => {
  // The label was setting horizontally and crossing two of its edges.
  const basemap = load('basemap');
  if (!basemap.features.some((f) => f.properties.kind === CLOSED_KIND)) return;
  assert.notEqual(Math.round(closedBearing(basemap)), 0, 'the shape is axis-aligned now');
});

test('no closed block means no rotation, not a crash', () => {
  // A generated artifact that stops carrying one must not take the label layer
  // down with it.
  assert.equal(closedBearing(null), 0);
  assert.equal(closedBearing(undefined), 0);
  assert.equal(closedBearing({ features: [] }), 0);
  assert.equal(closedBearing({ features: [{ properties: { kind: 'closed' }, geometry: null }] }), 0);
});

test('a degenerate ring has no grain', () => {
  const twoPoints = {
    features: [{
      properties: { kind: CLOSED_KIND },
      geometry: { coordinates: [[[-121.3, 38.6], [-121.3, 38.6]]] },
    }],
  };
  assert.equal(closedBearing(twoPoints), 0);
});

test('the longest edge is the one that decides it', () => {
  // A wide, short rectangle lies east-west; the word should set flat along it.
  const flat = {
    features: [{
      properties: { kind: CLOSED_KIND },
      geometry: {
        coordinates: [[
          [-121.3500, 38.6500], [-121.3480, 38.6500],
          [-121.3480, 38.6502], [-121.3500, 38.6502], [-121.3500, 38.6500],
        ]],
      },
    }],
  };
  assert.ok(Math.abs(closedBearing(flat)) < 1, `${closedBearing(flat)}° on an east-west block`);
});
