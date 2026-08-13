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
  sizeExpr, sizeAt, AMBIENT_SIZE, CATEGORY_SIZE, LABEL_SIZE, SELECTED_W, swayAngleAt,
  GROW_MS, GROW_EASE, SHRINK_MS, SHRINK_EASE,
  LABEL_START_SCALE, LABEL_RISE, LABEL_INK_DELAY, LABEL_INK_SPAN, SYMBOL_FADE_MS,
  swayAt, swayKeyframes, SWAY_AMP, SWAY_DECAY_MS, SWAY_PERIOD_MS, SWAY_DELAY_MS,
  SWAY_MS, SWAY_DIR, SWAY_STEP_MS, cubicBezier, growEase, scaleStops,
} from '../src/pin-select.js';
import {
  PIN_BASE_W, PIN_BOX, PIN_RING, PIN_ASPECT, LIFT_RING, LIFT_ASPECT, LIFT_DOT, LIFT_HEAD,
  AMENITY_KINDS, pinColour, glyphInk, pinInk, restingSvg, liftedSvg,
  FILL_TOP, FILL_BOTTOM,
} from '../src/map-images.js';
import { KIND_NAMES } from '../src/building-popup.js';
import { CATEGORIES } from '../src/categories.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root, deltaE, contrast, relLuminance } from './helpers.js';

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

test('the caption is lifted with the pin, not faded in beside it', () => {
  // Measured off a frame-by-frame trace of Apple's selection: their caption is
  // on screen the whole way, scaling 87px -> 100px and rising 9px on a 66px
  // head, and only crossing from the category hue to black in the last fifth of
  // the movement. Ours faded in from nothing over the middle of the run, which
  // reads as a second label arriving rather than the same one being picked up.
  assert.ok(
    Math.abs(1 / LABEL_START_SCALE - 100 / 87) < 0.02,
    `the caption scales by ${(1 / LABEL_START_SCALE).toFixed(3)}, measured 1.149`,
  );
  assert.ok(Math.abs(LABEL_RISE - 9 / 66) < 0.01, `rise is ${LABEL_RISE}, measured 0.136`);
  // Late, and inside the movement: an ink change that finishes early makes the
  // pin arrive already selected, and one that finishes after it is a separate
  // event.
  assert.ok(LABEL_INK_DELAY > 0.55 && LABEL_INK_DELAY < 0.75);
  assert.ok(LABEL_INK_DELAY + LABEL_INK_SPAN <= 1, 'the ink is still crossing after the pin lands');

  // The caption does fade, and has to: the symbol it replaces is rasterised
  // into the GL canvas and Mapbox fades it out rather than removing it, so an
  // opaque replacement draws the name twice. What matters is that the fade is a
  // CROSS-fade — same length as the symbol's, and starting at once. The fade
  // this replaced began 160 ms late, which left a gap with no name at all.
  assert.equal(SYMBOL_FADE_MS, 300, "Mapbox's text-fade-duration default");
  const css = readFileSync(path.join(root, 'src', 'input.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.pin-selected-label\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.pin-selected-label has no rule at all');
  assert.match(rule[1], /--pin-label-rise/, 'the caption no longer reads its rise');
  assert.doesNotMatch(rule[1], /transition/, 'the timing belongs to mountSelectedPin');
});

/**
 * The sideways settle, straight off the capture.
 *
 * Whole-marker silhouette centroid, in pixels, against a settled marker 65.91 px
 * wide; positive is right; t=0 is the first frame that moves. The rows are every
 * third frame of the 30 fps source, which is enough of them to pin the shape
 * without pasting fifty lines in. See the block above SWAY_AMP for how they were
 * taken and for why the map underneath is known to be still.
 */
const CAPTURE_W = 65.91;
const CAPTURE_SWAY = [
  [0, -0.46], [100, -0.19], [200, -1.50], [300, -4.96], [333, -5.64],
  [400, -4.50], [500, -2.49], [600, 0.97], [700, 1.51], [733, 1.63],
  [800, 1.22], [900, 0.21], [1000, -0.73], [1100, -0.75], [1200, -0.55],
  [1300, -0.22],
];

test('the pin bobbles sideways the way the capture does', () => {
  // Replayed at the capture's own marker width, so this compares the curve and
  // not the size we happen to draw pins at. The fit's own residual over all 51
  // frames is 0.27 px rms; a third of a pixel per sampled row is inside that.
  let worst = 0;
  for (const [ms, dx] of CAPTURE_SWAY) {
    worst = Math.max(worst, Math.abs(swayAt(ms, CAPTURE_W) - dx));
  }
  assert.ok(worst < 0.75, `the sway is ${worst.toFixed(2)}px off the capture at its worst row`);

  // The three peaks, which are the shape anyone actually watches: it goes out
  // furthest first, comes back a third as far, and the third swing is a twitch.
  const trace = Array.from({ length: SWAY_MS + 1 }, (_, ms) => swayAt(ms, CAPTURE_W));
  const first = Math.min(...trace);
  const second = Math.max(...trace.slice(500, 950));
  const third = Math.min(...trace.slice(950, 1300));
  assert.ok(Math.abs(first / CAPTURE_W + 0.079) < 0.006, `first peak ${first / CAPTURE_W}`);
  assert.ok(Math.abs(second / CAPTURE_W - 0.026) < 0.006, `second peak ${second / CAPTURE_W}`);
  assert.ok(Math.abs(third / CAPTURE_W + 0.009) < 0.006, `third peak ${third / CAPTURE_W}`);
  // Damped, not driven: each swing has to be smaller than the one before it.
  assert.ok(Math.abs(second) < Math.abs(first) && Math.abs(third) < Math.abs(second));
  assert.equal(SWAY_DIR, -1, 'the capture goes left first');

  // Pinned like the easings above: these are a measurement, and changing one
  // should mean having re-measured.
  assert.equal(SWAY_DECAY_MS, 344);
  assert.equal(SWAY_PERIOD_MS, 758);
  assert.equal(SWAY_DELAY_MS, 187);
  assert.ok(Math.abs(SWAY_AMP - 0.1297) < 1e-9);
});

test('the sway starts late and outlives the grow', () => {
  // It does not begin with the growth. The pin is a third of the way up before
  // it moves sideways at all — start the two together and the pin reads as
  // thrown rather than as settling.
  assert.ok(swayAt(0) === 0 && swayAt(SWAY_DELAY_MS) === 0, 'it moves before its delay');
  assert.ok(swayAt(SWAY_DELAY_MS + 1) !== 0, 'it never starts');
  assert.ok(SWAY_DELAY_MS > GROW_MS * 0.25 && SWAY_DELAY_MS < GROW_MS * 0.5,
    `the sway starts ${(SWAY_DELAY_MS / GROW_MS).toFixed(2)} of the way through the grow`);
  // And it is still going after the pin has finished growing, which is the whole
  // reason it cannot be a third axis on the grow's own transition.
  assert.ok(SWAY_MS > GROW_MS * 2, `sway ${SWAY_MS}ms against a ${GROW_MS}ms grow`);

  // A settle, not a lurch: at our own size the furthest it travels is a few
  // pixels, well under a tenth of the marker.
  const peak = Math.min(...Array.from({ length: SWAY_MS + 1 }, (_, ms) => swayAt(ms)));
  assert.ok(Math.abs(peak) / SELECTED_W < 0.1, `it swings ${Math.abs(peak) / SELECTED_W} of its width`);
  assert.ok(Math.abs(peak) > 2, `${Math.abs(peak)}px of travel is not going to be visible`);
});

test('the sway keyframes are a faithful sampling of the curve', () => {
  const frames = swayKeyframes(CAPTURE_W);
  // Degrees now, not pixels. The keyframes turn the head about the point the
  // pin is planted at rather than sliding the whole marker, so what is sampled
  // is `swayAngleAt`. The curve underneath is the same fitted one — see the
  // bobble test above, which still checks the displacement against the capture.
  const deg = (k) => Number(/-?[\d.]+/.exec(k.transform)[0]);

  // WAAPI requires ascending offsets, and silently animates nonsense otherwise.
  assert.ok(frames.every((k, i) => i === 0 || k.offset > frames[i - 1].offset),
    'the keyframe offsets are not ascending');
  assert.equal(frames[0].offset, 0);
  assert.equal(frames.at(-1).offset, 1);

  // It has to start and end at rest, or mounting the pin snaps it sideways and
  // removing it snaps it back. The end is exact because SWAY_MS lands on a zero
  // of the sine rather than on a round number.
  assert.equal(deg(frames[0]), 0);
  assert.equal(deg(frames.at(-1)), 0);
  assert.ok(Math.abs(swayAt(SWAY_MS, CAPTURE_W)) < 1e-9,
    'SWAY_MS is no longer at a zero crossing, so the last keyframe is a jump');

  // The corner where the flat lead-in meets the sine needs a keyframe on it.
  // Without one the grid steps across it and cuts it off, which slides the pin a
  // third of a pixel before the motion is meant to have started.
  assert.ok(frames.some((k) => Math.abs(k.offset * SWAY_MS - SWAY_DELAY_MS) < 1e-9),
    'nothing is anchored at the delay');

  // The browser draws straight lines between these, so the straight lines are
  // what has to match the curve — not the samples, which match by construction.
  let worst = 0;
  for (let ms = 0; ms <= SWAY_MS; ms += 0.5) {
    const f = ms / SWAY_MS;
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].offset < f) i += 1;
    const [a, b] = [frames[i], frames[i + 1]];
    const u = (f - a.offset) / (b.offset - a.offset);
    worst = Math.max(worst, Math.abs(deg(a) + u * (deg(b) - deg(a)) - swayAngleAt(ms, CAPTURE_W)));
  }
  // 0.06 degrees, which is the angle that moves the head about a twentieth of a
  // pixel at this marker's lever — the same sub-pixel budget the px version of
  // this assertion held the slide to.
  assert.ok(worst < 0.06, `linear interpolation is ${worst.toFixed(4)} degrees off the curve`);
  assert.ok(frames.length < 60, `${frames.length} keyframes is more than this curve needs`);
  assert.ok(SWAY_STEP_MS > 0);
});

test('the sway is wrapped around the head, not applied to it', () => {
  // The grow is a CSS transition on `transform` and the sway is a WAAPI
  // animation on `transform`; a running animation beats a transition outright,
  // so putting them on one element would delete the growth for the length of the
  // swing rather than blending the two. Hence a wrapper — and hence a rule for
  // it, which is where the compositor hint lives.
  const css = readFileSync(path.join(root, 'src', 'input.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const sway = /\.pin-selected-sway\s*\{([^}]*)\}/.exec(css);
  const scale = /\.pin-selected-scale\s*\{([^}]*)\}/.exec(css);
  assert.ok(sway, '.pin-selected-sway has no rule, so the wrapper is unstyled');
  assert.match(sway[1], /will-change:\s*transform/);
  // The two must stay separate elements. A transform declared on the scaler
  // would be overwritten by mountSelectedPin anyway; one here would be
  // overwritten by the animation.
  assert.doesNotMatch(sway[1], /transform:/, 'the sway transform comes from the keyframes');
  assert.ok(scale, '.pin-selected-scale has gone');
  assert.doesNotMatch(scale[1], /animation:/, 'the sway has landed on the growing element');
});

test('the bezier solver agrees with the browser that runs the other copy', () => {
  // The lift hands GROW_EASE to CSS and a whole category of arriving pins is
  // driven by evaluating the same string here. Two implementations of one curve,
  // so the risk is that they quietly differ and the two motions stop matching.

  // cubic-bezier(1/3, 1/3, 2/3, 2/3) IS the identity, exactly, and any error in
  // the root-finding shows up against it immediately.
  const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
  for (let i = 0; i <= 1000; i += 1) {
    assert.ok(Math.abs(linear(i / 1000) - i / 1000) < 1e-6, `linear at ${i / 1000}`);
  }

  // CSS `ease`, whose midpoint is a published number.
  assert.ok(Math.abs(cubicBezier(0.25, 0.1, 0.25, 1)(0.5) - 0.8024) < 1e-3);
  // ...and `ease-in-out`, which is symmetric about its own middle.
  const easeInOut = cubicBezier(0.42, 0, 0.58, 1);
  assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-6);
  for (const x of [0.1, 0.25, 0.4]) {
    assert.ok(Math.abs(easeInOut(x) + easeInOut(1 - x) - 1) < 1e-6, `asymmetric at ${x}`);
  }

  // The ends are pinned, or a pin starts or finishes at the wrong size.
  for (const ease of [linear, growEase, easeInOut]) {
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    assert.equal(ease(-5), 0, 'clamped below');
    assert.equal(ease(5), 1, 'clamped above');
  }
});

test('the grow curve keeps its overshoot when read as a function', () => {
  // The whole character of the lift is that it goes PAST the size it is heading
  // for. A solver that clamped y to [0,1] — which is a reasonable-looking thing
  // to write — would return a curve that fits every other test here and has no
  // bounce at all, and the pins would read as resizing.
  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i <= 1000; i += 1) {
    const v = growEase(i / 1000);
    if (v > peak) { peak = v; peakAt = (i / 1000) * GROW_MS; }
  }
  assert.ok(peak > 1.05, `the grow curve peaks at ${peak.toFixed(4)} and should overshoot`);
  assert.ok(peakAt > GROW_MS * 0.45 && peakAt < GROW_MS * 0.7,
    `it peaks ${peakAt.toFixed(0)}ms into a ${GROW_MS}ms run`);

  // It comes back down and stays down: one overshoot, not a wobble. The sway is
  // where the oscillation lives, and it is a different axis.
  let crossed = 0;
  for (let i = 1; i <= 1000; i += 1) {
    const [a, b] = [growEase((i - 1) / 1000), growEase(i / 1000)];
    if ((a - 1) * (b - 1) < 0) crossed += 1;
  }
  assert.equal(crossed, 1, `the grow crosses its destination ${crossed} times`);

  // And it is the string, not a second copy of the numbers.
  const control = GROW_EASE.match(/-?[\d.]+/g).map(Number);
  const rebuilt = cubicBezier(...control);
  for (let i = 0; i <= 100; i += 1) {
    assert.ok(Math.abs(rebuilt(i / 100) - growEase(i / 100)) < 1e-12);
  }
});

test('a growing layer scales its stops, not the finished expression', () => {
  // Mapbox permits `['zoom']` only as the direct input to a TOP-LEVEL step or
  // interpolate. `['*', sizeExpr(...), grown]` — the obvious way to animate a
  // layer's size — buries it under an operator and is rejected outright, which
  // shows up as pins that simply never grow rather than as an error anyone sees.
  for (const factor of [0.349, 0.7, 1.0568]) {
    const expr = sizeExpr(scaleStops(CATEGORY_SIZE, factor));
    assert.deepEqual(expr.slice(0, 3), ['interpolate', ['linear'], ['zoom']],
      'the zoom input is no longer at the top level');

    // And it has to MEAN the same thing: scaling the stops of a linear
    // interpolation is scaling its result, at every zoom including the clamped
    // ends outside the table.
    for (let zoom = 10; zoom <= 22; zoom += 0.1) {
      const scaled = sizeAt(scaleStops(CATEGORY_SIZE, factor), zoom);
      assert.ok(Math.abs(scaled - sizeAt(CATEGORY_SIZE, zoom) * factor) < 1e-12,
        `z${zoom.toFixed(1)} at x${factor}`);
    }
  }
  // The stops themselves are untouched — this returns a new table each time, and
  // a version that mutated would permanently shrink the layer it animated.
  //
  // Against a snapshot rather than against the literal values, which is what
  // this claim actually is: "scaleStops did not touch its input". Written out
  // as {14: 0.72, 19: 0.92} it also failed the day the pins were made bigger,
  // reporting a mutation that had not happened.
  const before = { ...CATEGORY_SIZE };
  scaleStops(CATEGORY_SIZE, 0.5);
  assert.deepEqual(CATEGORY_SIZE, before);
  assert.notEqual(scaleStops(CATEGORY_SIZE, 1), CATEGORY_SIZE);
});

test('an arriving category of pins sways in screen space', () => {
  // `icon-translate` defaults to a MAP anchor, which is bearing-relative: the
  // same animation would settle along a compass direction rather than sideways
  // once the map is rotated. Nothing catches that but looking at a rotated map
  // during the one second the pins arrive.
  const main = readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  assert.match(main, /'icon-translate-anchor':\s*'viewport'/,
    'the category pins sway with the compass rather than with the screen');
  // The entrance drives icon-translate; a layer that declares one without the
  // anchor beside it is the bug above waiting to happen.
  const translates = main.match(/'icon-translate':/g) ?? [];
  const anchors = main.match(/'icon-translate-anchor':/g) ?? [];
  assert.ok(anchors.length >= 1 && translates.length >= 1);
});

test('every layer that draws a pin has a size table', () => {
  // Three layers draw the same disc — the amenities, a category's own pins, and
  // the 38 printed labels that carry a pictogram — and `ambientWidth` has to
  // know which size each is at to start an animation from it. The third was
  // missing for a long time, which is why tapping a building name did nothing
  // at all: it was not a pin as far as the click handler was concerned.
  for (const stops of [AMBIENT_SIZE, CATEGORY_SIZE, LABEL_SIZE]) {
    const zooms = Object.keys(stops).map(Number);
    assert.ok(zooms.length >= 2, 'a size table needs two stops to interpolate');
    for (const z of zooms) assert.ok(z >= 10 && z <= 22, `stop at zoom ${z}`);
    for (const v of Object.values(stops)) assert.ok(v > 0 && v < 1.5);
  }
});
