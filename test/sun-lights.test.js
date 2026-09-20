// src/sun-lights.js — the sun the app brings with it.
//
// Extrusions came up as flat slabs because `map.getLights()` answered
// `[{ id: 'flat', type: 'flat' }]`: Google's style is blank and a blank style
// has no lighting model, so the campus was casting shadows in a world with no
// sun. This is the sun, and the one thing it must never do is point upwards —
// a directional light under the ground sends every shadow in the scene at the
// sky.
//
// Inside startApp() none of that was askable. Here it is a loop over a year.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sunLights, sunHeight, assist,
  AMBIENT_ASSIST, AMBIENT_FLOOR, AMBIENT_SUN, SUN_INTENSITY, SUN_RAMP_DEG, MAX_POLAR_DEG,
} from '../src/sun-lights.js';
import { sunAt, HORIZON_DEG } from '../src/daylight.js';

/** Middle of the campus, which is what main.js passes. */
const HERE = [-121.34638, 38.64916];

const lightsAt = (iso) => {
  const at = new Date(iso);
  const [ambient, directional] = sunLights(at, HERE);
  return { at, ambient, directional, elevation: sunAt(at, HERE[0], HERE[1]).elevation };
};

/** Every three hours through a year, so solstices and equinoxes are all in. */
function* throughTheYear() {
  const start = Date.UTC(2025, 0, 1);
  for (let h = 0; h < 365 * 24; h += 3) yield new Date(start + h * 3600_000);
}

test('sunHeight is a fraction, clamped at both ends', () => {
  assert.equal(sunHeight(-90), 0);
  assert.equal(sunHeight(HORIZON_DEG), 0);
  assert.equal(sunHeight(HORIZON_DEG + SUN_RAMP_DEG), 1);
  assert.equal(sunHeight(90), 1);
  assert.ok(sunHeight(HORIZON_DEG + SUN_RAMP_DEG / 2) > 0);
  assert.ok(sunHeight(HORIZON_DEG + SUN_RAMP_DEG / 2) < 1);
});

test('the scene always has two lights, an ambient and a directional', () => {
  const { ambient, directional } = lightsAt('2025-06-21T20:00:00Z');
  assert.equal(ambient.id, 'ambient');
  assert.equal(ambient.type, 'ambient');
  assert.equal(directional.id, 'directional');
  assert.equal(directional.type, 'directional');
});

test('the sun never shines upwards, on any day of the year', () => {
  // THE ONE THAT MATTERS. A polar angle at or past 90 is a light source below
  // the horizon, and every shadow on the campus would point at the sky.
  for (const at of throughTheYear()) {
    const [, directional] = sunLights(at, HERE);
    const [azimuth, polar] = directional.properties.direction;
    assert.ok(polar >= 1 && polar <= MAX_POLAR_DEG, `${at.toISOString()}: polar angle ${polar}`);
    assert.ok(Number.isFinite(azimuth), `${at.toISOString()}: azimuth ${azimuth}`);
  }
});

test('below the horizon the directional light is off, not dim', () => {
  for (const at of throughTheYear()) {
    const { elevation } = sunAt(at, HERE[0], HERE[1]);
    if (elevation > HORIZON_DEG) continue;
    const [, directional] = sunLights(at, HERE);
    assert.equal(directional.properties.intensity, 0, at.toISOString());
    assert.equal(directional.properties['shadow-intensity'], 0, at.toISOString());
  }
});

test('the ambient never goes out', () => {
  // What keeps the buildings solid at night instead of silhouettes.
  for (const at of throughTheYear()) {
    const [ambient] = sunLights(at, HERE);
    const { intensity } = ambient.properties;
    assert.ok(intensity >= AMBIENT_FLOOR, `${at.toISOString()}: ${intensity}`);
    assert.ok(intensity <= AMBIENT_FLOOR + AMBIENT_SUN + 1e-12, `${at.toISOString()}: ${intensity}`);
  }
});

test('the directional light never exceeds its own maximum', () => {
  for (const at of throughTheYear()) {
    const [, directional] = sunLights(at, HERE);
    assert.ok(directional.properties.intensity <= SUN_INTENSITY + 1e-12);
    assert.ok(directional.properties.intensity >= 0);
  }
});

test('a high summer sun is at full strength with short shadows', () => {
  // Local solar noon in late June, here, is around 20:00 UTC.
  const { directional, elevation } = lightsAt('2025-06-21T20:00:00Z');
  assert.ok(elevation > 60, `the test premise moved: elevation ${elevation}`);
  assert.equal(directional.properties.intensity, SUN_INTENSITY);
  assert.equal(directional.properties['shadow-intensity'], 1);
  // Polar angle is measured away from straight up, so a high sun is a small one.
  assert.ok(directional.properties.direction[1] < 30);
});

test('a low sun is warm and casts long shadows; a high one is white', () => {
  // The one colour decision in here rather than an astronomical one — but it is
  // the decision every photograph of a low sun makes.
  const high = lightsAt('2025-06-21T20:00:00Z');
  const low = lightsAt('2025-06-21T03:30:00Z');

  assert.equal(high.directional.properties.color, '#ffffff');
  assert.notEqual(low.directional.properties.color, '#ffffff');
  assert.ok(low.directional.properties.direction[1] > high.directional.properties.direction[1]);
});

test('the sky light is cool and the sun light is warm', () => {
  // Scattered light versus direct. If these ever swap, a dawn looks like a
  // fluorescent tube.
  const dawn = lightsAt('2025-03-20T13:30:00Z');
  const red = (hex) => parseInt(hex.slice(1, 3), 16);
  const blue = (hex) => parseInt(hex.slice(5, 7), 16);

  assert.ok(blue(dawn.ambient.properties.color) >= red(dawn.ambient.properties.color),
    'the sky went warm');
  assert.ok(red(dawn.directional.properties.color) >= blue(dawn.directional.properties.color),
    'the sun went cool');
});

// --- the ambient assist ----------------------------------------------------

const standardNight = () => [
  { id: 'ambient', type: 'ambient', properties: { color: 'hsl(217, 100%, 11%)', intensity: 0.5 } },
  { id: 'directional', type: 'directional', properties: { color: '#ffffff', intensity: 0.2 } },
];

test('the assist lifts the ambient after dark on the light theme', () => {
  const lifted = assist(standardNight(), 'night', 'light');
  assert.equal(lifted[0].properties.intensity, AMBIENT_ASSIST.night.intensity);
  assert.equal(lifted[0].properties.color, AMBIENT_ASSIST.night.color);
});

test('the assist replaces the COLOUR, not only the number', () => {
  // Standard's night ambient is very nearly black, and scaling a black light by
  // any intensity leaves it black. Measured on the bench: ambient 0.5 to 1.0 at
  // night moves a roof by about one L* until the colour moves too.
  const lifted = assist(standardNight(), 'night', 'light');
  assert.notEqual(lifted[0].properties.color, 'hsl(217, 100%, 11%)');
});

test('the assist leaves the directional light alone', () => {
  const lifted = assist(standardNight(), 'night', 'light');
  assert.deepEqual(lifted[1].properties, { color: '#ffffff', intensity: 0.2 });
});

test('somebody who chose dark gets dark', () => {
  const untouched = assist(standardNight(), 'night', 'dark');
  assert.deepEqual(untouched, standardNight());
});

test('daylight needs no assist', () => {
  assert.deepEqual(assist(standardNight(), 'day', 'light'), standardNight());
  assert.equal(AMBIENT_ASSIST.day, undefined);
});

test('every preset the assist knows about names both a colour and an intensity', () => {
  for (const [preset, want] of Object.entries(AMBIENT_ASSIST)) {
    assert.match(want.color, /^#[0-9a-f]{6}$/i, preset);
    assert.ok(want.intensity > 0 && want.intensity <= 1, preset);
  }
  // Night keeps more of its darkness than dusk, because a night map that looks
  // like noon has stopped saying anything.
  assert.ok(AMBIENT_ASSIST.night.intensity < AMBIENT_ASSIST.dusk.intensity);
});

test('there is no moment when the light is on and aimed underground', () => {
  // How the clamp was found. `90 - elevation` passes 90 at elevation 0, but the
  // intensity does not reach zero until HORIZON_DEG (-0.833) — so between the
  // two the sun was lit at about 7% and pointing below the ground, which sends
  // every shadow on the campus at the sky. Quarter-hourly, because the window
  // is about four minutes wide twice a day.
  const start = Date.UTC(2025, 0, 1);
  for (let q = 0; q < 365 * 24 * 4; q++) {
    const at = new Date(start + q * 900_000);
    const [, directional] = sunLights(at, HERE);
    if (directional.properties.intensity === 0) continue;
    const polar = directional.properties.direction[1];
    assert.ok(polar < 90, `${at.toISOString()}: lit at ${directional.properties.intensity}, aimed at ${polar}`);
  }
});
