// src/pin-select.js — the sizes and the curve behind a lifted pin.
//
// Both halves of this fail quietly. The size table is read twice, once as a
// Mapbox expression for the symbol layer and once in JS to decide what size the
// animation starts at; if those two ever disagree the pin jumps the instant it
// is tapped and then animates smoothly from the wrong place, which looks like a
// rendering glitch rather than a bug in a number. And the easing is a string —
// a typo in it is not an error, it is `ease` and a pin that no longer springs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sizeExpr, sizeAt, AMBIENT_SIZE, CATEGORY_SIZE, SELECTED_W,
  GROW_MS, GROW_EASE, SHRINK_MS, SHRINK_EASE,
} from '../src/pin-select.js';
import {
  PIN_BASE_W, PIN_BOX, PIN_RING, PIN_ASPECT, LIFT_RING, LIFT_ASPECT, LIFT_DOT, LIFT_HEAD,
  AMENITY_KINDS, pinColour, glyphInk, pinInk, restingSvg, liftedSvg,
  FILL_TOP, FILL_BOTTOM,
} from '../src/map-images.js';
import { KIND_NAMES } from '../src/building-popup.js';
import { CATEGORIES } from '../src/categories.js';
import { deltaE, contrast, relLuminance } from './helpers.js';

/** The interpolation Mapbox will run, done by hand from the expression itself. */
function evaluate(expr, zoom) {
  assert.deepEqual(expr.slice(0, 3), ['interpolate', ['linear'], ['zoom']]);
  const stops = [];
  for (let i = 3; i < expr.length; i += 2) stops.push([expr[i], expr[i + 1]]);

  if (zoom <= stops[0][0]) return stops[0][1];
  if (zoom >= stops.at(-1)[0]) return stops.at(-1)[1];
  for (let i = 1; i < stops.length; i += 1) {
    const [z0, s0] = stops[i - 1];
    const [z1, s1] = stops[i];
    if (zoom <= z1) return s0 + ((s1 - s0) * (zoom - z0)) / (z1 - z0);
  }
  throw new Error('unreachable');
}

test('the layer and the animation read the same size table', () => {
  for (const stops of [AMBIENT_SIZE, CATEGORY_SIZE]) {
    const expr = sizeExpr(stops);
    // Every tenth of a zoom across the range the map is ever at, plus well
    // outside it — Mapbox clamps beyond the end stops and so must sizeAt, or a
    // pin tapped at z22 starts its animation at a size nothing was drawn at.
    for (let zoom = 10; zoom <= 22; zoom += 0.1) {
      assert.ok(
        Math.abs(sizeAt(stops, zoom) - evaluate(expr, zoom)) < 1e-12,
        `zoom ${zoom.toFixed(1)}: ${sizeAt(stops, zoom)} vs ${evaluate(expr, zoom)}`,
      );
    }
  }
});

test('a lifted pin is always bigger than the icon it replaced', () => {
  // If it were not, the "grow" would be a shrink at some zoom and the gesture
  // would read backwards. The category pins are the ones with any margin at
  // all — they are already the larger of the two ambient sets.
  for (const stops of [AMBIENT_SIZE, CATEGORY_SIZE]) {
    for (let zoom = 10; zoom <= 22; zoom += 0.5) {
      const from = PIN_BASE_W * sizeAt(stops, zoom);
      assert.ok(from < SELECTED_W, `at z${zoom} the ambient pin is ${from}px of ${SELECTED_W}`);
      assert.ok(from > 0);
    }
  }
  // And the largest ambient size is still under two thirds of the selected one,
  // which is what keeps the growth readable rather than a nudge.
  const widest = PIN_BASE_W * Math.max(...Object.values(CATEGORY_SIZE));
  assert.ok(widest / SELECTED_W < 0.66, `ambient is ${(widest / SELECTED_W).toFixed(2)} of selected`);
});

test('the two marker states keep the measured proportions', () => {
  // Read off the capture and divided through by its own scale. These decide
  // whether the marker reads as Apple's or as something near it, and nothing
  // at runtime will ever complain about a wrong one.
  assert.ok(Math.abs(PIN_RING / PIN_BOX.w - 0.117) < 0.005, `resting ring ${PIN_RING / PIN_BOX.w}`);
  assert.ok(Math.abs(LIFT_RING / PIN_BASE_W - 0.070) < 0.005, `lifted ring ${LIFT_RING / PIN_BASE_W}`);

  // The resting disc is a circle: as wide as it is tall, bar the shadow.
  assert.ok(PIN_ASPECT > 1 && PIN_ASPECT < 1.1, `resting aspect ${PIN_ASPECT}`);
  // The lifted one is taller, because it has a nub and a dot below the head.
  assert.ok(LIFT_ASPECT > PIN_ASPECT + 0.2, `lifted aspect ${LIFT_ASPECT}`);

  // The dot sits near the bottom and is small. Its position is what the whole
  // animation is pinned to — mountSelectedPin makes it the transform origin and
  // offsets the marker so its CENTRE lands on the coordinate — so a wrong value
  // here moves the place the marker claims, silently.
  assert.ok(LIFT_DOT.y > 0.9 && LIFT_DOT.y < 0.96, `dot at ${LIFT_DOT.y} of the height`);
  assert.ok(LIFT_DOT.y + LIFT_DOT.r <= 1, 'the dot hangs out of its own box');
  assert.ok(LIFT_HEAD < LIFT_DOT.y - 0.4, 'the head should float well clear of the dot');
});

test('the easings are the fitted ones, and the way out has no bounce', () => {
  // The numbers are a measurement — see the header of pin-select.js — so they
  // are pinned here rather than described. Changing them should mean having
  // re-measured, and re-measuring means changing this line too.
  assert.equal(GROW_EASE, 'cubic-bezier(0.5, 1.525, 0.5, 1)');
  assert.equal(GROW_MS, 540);

  const control = (ease) => ease.match(/-?[\d.]+/g).map(Number);
  // y1 > 1 is what an overshoot IS in a cubic-bezier: the curve leaves the
  // start heading past its own destination.
  assert.ok(control(GROW_EASE)[1] > 1, 'the grow has lost its overshoot');
  assert.ok(control(SHRINK_EASE).every((n) => n >= 0 && n <= 1), 'the shrink should not bounce');
  assert.ok(SHRINK_MS < GROW_MS / 2, 'putting a pin back should be quicker than lifting it');
});

test('every pin that can be tapped has a name for its card', () => {
  // The card falls back to KIND_NAMES when the feature carries no name of its
  // own, which is every ambient amenity whose label is missing and every
  // category pin whose name would not have identified it. A kind with no entry
  // gets a card headed "Marker", and nothing anywhere says so.
  const drawn = new Set(AMENITY_KINDS);
  for (const category of CATEGORIES) {
    for (const kind of category.kinds ?? []) {
      assert.ok(drawn.has(kind), `${kind} is drawn by no pin`);
      assert.ok(KIND_NAMES[kind], `no card title for the amenity kind "${kind}"`);
    }
    if (category.icon) {
      assert.ok(KIND_NAMES[category.icon], `no card title for the category disc "${category.icon}"`);
    }
  }
});

test('no two marker hues read as the same colour', () => {
  const hues = [...new Set(AMENITY_KINDS.map(pinColour))];
  assert.ok(hues.length >= 9, `only ${hues.length} distinct hues`);

  // With the names off the ambient markers, colour is what separates a
  // telephone from a bike rack at 16 px. The floor is the tightest pair the
  // six-hue palette this replaces already had — red against orange, dE 31.6 —
  // so a wider set is not allowed to be a muddier one.
  let worst = { d: Infinity };
  for (let i = 0; i < hues.length; i += 1) {
    for (let j = i + 1; j < hues.length; j += 1) {
      const d = deltaE(hues[i], hues[j]);
      if (d < worst.d) worst = { d, a: hues[i], b: hues[j] };
    }
  }
  assert.ok(worst.d > 28, `${worst.a} and ${worst.b} are only dE ${worst.d.toFixed(1)} apart`);

  // The two greens are the pair this nearly went wrong on: Google's own #188038
  // sits dE 19.9 from the mint this map already spends on sport.
  assert.ok(deltaE(pinColour('bike_rack'), pinColour('sport')) > 35);
});

test('every pictogram is legible on the disc it sits in', () => {
  for (const kind of AMENITY_KINDS) {
    const disc = pinColour(kind);
    // WCAG's floor for a non-text graphic. glyphInk switches to dark ink rather
    // than let a glyph fall under it — one hue needs that and nothing says so
    // at runtime, because an unreadable icon still renders.
    assert.ok(contrast(disc, glyphInk(disc)) >= 3,
      `${kind}: glyph on ${disc} is only ${contrast(disc, glyphInk(disc)).toFixed(2)}:1`);
    // And the name under it, in both themes, against the ground it sits on.
    assert.ok(contrast(pinInk(kind, 'light'), '#ffffff') >= 4.5, `${kind}: light label`);
    assert.ok(contrast(pinInk(kind, 'dark'), '#212121') >= 4.5, `${kind}: dark label`);
  }
});

/** The two stop colours out of an SVG's one linearGradient. */
function gradientStops(svg) {
  const stops = [...svg.matchAll(/<stop offset="([01])" stop-color="(#[0-9a-f]{6})"/g)];
  assert.equal(stops.length, 2, 'a marker should carry exactly one two-stop gradient');
  return stops.map((m) => m[2]);
}

test('a marker does not change colour when it is picked up', () => {
  // Measuring Apple's two states turned up that they share one gradient: their
  // lifted head runs rgb(70,205,86) to rgb(28,164,60) and the resting disc
  // beside it rgb(76,203,86) to rgb(18,160,51), which is the same pair within a
  // couple of levels. Ours used to have a gradient on the lifted state only, so
  // selecting a pin visibly flattened-to-shaded as well as growing.
  //
  // The two SVGs are built by different functions, so nothing but this notices
  // if one of them is later "simplified" back to a flat fill.
  for (const kind of AMENITY_KINDS) {
    const resting = gradientStops(restingSvg(kind));
    const lifted = gradientStops(liftedSvg(kind));
    assert.deepEqual(resting, lifted, `${kind} is shaded differently at rest`);
    // ...and the gradient is a real one, lighter at the top, in every hue.
    const [top, bottom] = resting.map(relLuminance);
    assert.ok(top > bottom, `${kind} is darker at the top`);
    assert.ok(top / bottom > 1.15, `${kind}'s gradient is too faint to see`);
  }
  assert.ok(FILL_TOP > 1 && FILL_BOTTOM < 1, 'the gradient no longer straddles the flat colour');
});
