// The sun over this campus, as Mapbox states a light — and the help the light
// theme gets after dark.
//
// WHY THIS HAD TO EXIST. "Stand the buildings up" extruded the footprints and
// produced flat slabs with no shadows, and the reason turned out to be that
// there was no light in the scene at all: `map.getLights()` answered
// `[{ id: 'flat', type: 'flat' }]`. Google is the default provider, its style is
// BLANK_STYLE, and a blank style has no lighting model — so the campus was being
// asked to cast shadows in a world with no sun. Under Mapbox Standard there IS a
// sun, but the extrusions were opted three quarters out of it.
//
// So the app brings its own, and it points where the real one does. The azimuth
// and elevation come from the same NOAA solve that already decides whether it is
// dawn or dusk — see src/daylight.js — which means the shadows on the campus
// fall the way the shadows on the campus fall, and swing round over the course
// of a day rather than sitting at a fixed art-directed angle.
//
// ITS OWN MODULE BECAUSE IT IS ARITHMETIC. Two functions, no map, no DOM, no
// palette: a date and a place go in and a light array comes out. Inside
// startApp() that was unaskable, and the one question that matters here —
// "does this ever point a light upwards" — is a loop over a day.

import { sunAt, HORIZON_DEG } from './daylight.js';
import { toward } from './palette.js';

/**
 * BELOW THE HORIZON THERE IS NO SUN, and this refuses to invent one. `up` fades
 * the directional light out over the last twelve degrees of the sky and reaches
 * zero at sunset, because a directional light with the sun underneath the
 * ground is a light shining upwards and every shadow in the scene points at the
 * sky. What is left at night is ambient alone, lifted by the floor below so the
 * buildings stay solid rather than becoming silhouettes.
 */
export const AMBIENT_FLOOR = 0.45;
export const AMBIENT_SUN = 0.35;
export const SUN_INTENSITY = 0.9;
/** How far above the horizon the sun has to climb to be at full strength. */
export const SUN_RAMP_DEG = 12;
/**
 * The lowest the light source may sit, in degrees from straight up.
 *
 * Just under the horizontal. At 90 the light is edge-on and past it, underneath.
 */
export const MAX_POLAR_DEG = 89;

/** How far up the sky the sun is, 0 at the horizon and 1 at full strength. */
export const sunHeight = (elevation) =>
  Math.max(0, Math.min(1, (elevation - HORIZON_DEG) / SUN_RAMP_DEG));

export function sunLights(at, [lon, lat]) {
  const { elevation, azimuth } = sunAt(at, lon, lat);
  const up = sunHeight(elevation);
  // Warm at the horizon and white overhead, which is the one piece of this
  // that is a colour decision rather than an astronomical one — but it is the
  // decision every photograph of a low sun makes, and without it a dawn with
  // long shadows is lit like noon.
  const warm = toward('#ffffff', '#ffd2a0', 1 - up);
  return [
    {
      id: 'ambient',
      type: 'ambient',
      // The sky rather than the sun: cool, because it is scattered light, and
      // it never goes out.
      properties: {
        color: toward('#ffffff', '#cdd9ee', 1 - up),
        intensity: AMBIENT_FLOOR + AMBIENT_SUN * up,
      },
    },
    {
      id: 'directional',
      type: 'directional',
      properties: {
        color: warm,
        intensity: SUN_INTENSITY * up,
        // [azimuthal, polar], both degrees, describing where the light SOURCE
        // is: clockwise from due north, and away from straight up. So a sun
        // 70 degrees high is a polar angle of 20 and short shadows; a sun 5
        // degrees up is 85, and the shadows run right across the campus.
        //
        // CLAMPED AT BOTH ENDS, and the upper one is not decoration. `90 -
        // elevation` passes 90 as soon as the sun is below the horizon, and a
        // polar angle past 90 is a light source UNDER THE GROUND — every shadow
        // in the scene pointing at the sky, which is the exact thing the
        // paragraph above says this refuses to do. At night it did not show,
        // because the intensity is zero by then. But `up` reaches zero at
        // HORIZON_DEG (-0.833) and the polar angle passes 90 at elevation 0, so
        // between those two there is a real window where the light is ON and
        // aimed underground: measured at 6.9% intensity and 90.0007 degrees on
        // 26 December. Small, lit, and wrong, which is the kind that survives.
        direction: [azimuth, Math.max(1, Math.min(MAX_POLAR_DEG, 90 - elevation))],
        'cast-shadows': true,
        'shadow-intensity': up,
      },
    },
  ];
}

/**
 * A little more ambient after dark, on the light theme only.
 *
 * The same trade the app already makes everywhere else, that a map is a
 * document to be read before it is a picture of a time of day. Night keeps more
 * of its darkness than dusk because a night map that looks like noon has
 * stopped saying anything.
 *
 * Only in the LIGHT theme. Somebody who has chosen dark has asked for a dark
 * map and should be given one.
 */
export const AMBIENT_ASSIST = {
  dawn: { intensity: 0.85, color: '#fff1dd' },
  dusk: { intensity: 0.85, color: '#ffeed6' },
  night: { intensity: 0.62, color: '#c9d6ea' },
};

/** Mutates and returns `lights`; the caller owns the clone. */
export function assist(lights, preset, theme) {
  const want = theme === 'light' ? AMBIENT_ASSIST[preset] : null;
  if (!want) return lights;
  for (const light of lights) {
    // Ambient is the one that matters. Standard's night ambient is
    // hsl(217,100%,11%) — very nearly black — and scaling a black light by any
    // intensity leaves it black, which is why the colour is replaced and not
    // only the number. Measured on the bench: ambient 0.5 to 1.0 at night
    // moves a roof by about one L* until the colour moves too.
    if (light.id !== 'ambient') continue;
    light.properties = { ...light.properties, intensity: want.intensity, color: want.color };
  }
  return lights;
}
