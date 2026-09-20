// The campus footprints standing up, and the light that falls on them.
//
// TWO THINGS THAT CANNOT BE SEPARATED, which is why they share a module.
// `applyLighting` decides whether the extrusions exist at all — the lighting
// bench is allowed to stand them up outside a walk — and `add` ends by calling
// back into `applyLighting`, because a layer created during navigation needs
// the bench's emissive rather than the palette's. Splitting them would mean two
// modules calling each other in a cycle, which is the same tangle with an
// import between the halves.
//
// WHAT IS NOT HERE is the bench itself. Its values belong to the debug menu and
// are read through `bench()`, which answers null whenever the menu is shut —
// the rule the whole back room is built on, and it matters more here than
// anywhere else because these values are PLAUSIBLE. A route GUI switched off is
// obviously a debug state; a campus at dusk just looks like a decision somebody
// made.
//
// The sun is src/sun-lights.js, which is arithmetic and has no map in it.

import { sunLights, assist } from './sun-lights.js';

/**
 * The layer's own emissive strength, and the bench's starting point.
 *
 * One number with one explanation, read from three places rather than written
 * in three: the layer's own paint spec, the bench's starting point, and what
 * the bench is put back to.
 *
 * 0.75 was the number while NOTHING LIT THE SCENE — see src/sun-lights.js for
 * what that turned out to mean. With a real ambient and a real sun on the
 * map, three quarters self-lit is the setting that throws the sun away: a
 * face that is 75% emissive barely darkens when it turns away from the light,
 * so the walls stay the colour of the roof and the shadow the building casts
 * lands next to a building that does not look lit. 0.2 keeps enough self-light
 * that a building is still legible against a dark ground and lets the other
 * 80% be shading.
 */
export const BUILDING_EMISSIVE = 0.2;

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Array}  deps.centre          the campus, for the sun's position
 * @param {Function} deps.litPalette    the palette at the current time of day
 * @param {Function} deps.navigating    whether a walk is running
 * @param {Function} deps.clockPreset   dawn/day/dusk/night from the real sun
 * @param {Function} deps.theme         'light' or 'dark'
 * @param {Function} deps.footprints    the buildings overlay, once it has landed
 * @param {Function} deps.isStyleBuilt  whether there is a style to configure
 * @param {Function} deps.bench         the lighting bench, or null when shut
 * @param {Function} deps.standardLights  the style's own lights, captured on load
 * @param {Function} deps.setConfig     write a Standard config key
 * @param {Function} deps.paintLamps    the lamp layer follows the same preset
 * @param {Function} deps.repaintCampus the campus is emissive and must be redrawn
 */
export function createBuildingsLighting({
  map,
  centre,
  litPalette,
  navigating,
  clockPreset,
  theme,
  footprints,
  isStyleBuilt,
  bench,
  standardLights,
  setConfig,
  paintLamps,
  repaintCampus,
}) {
  /**
   * Which preset the campus was last REPAINTED for.
   *
   * The campus linework is emissive, so it cannot be relit — it has to be drawn
   * again. This is what stops that happening on every builder pass.
   */
  let paintedFor = null;

  /** Whether the bench currently has the camera tilted. */
  let benchTilt = false;


  /**
   * Extrude the campus footprints traced out of my campus basemap SVG by
   * scripts/build-buildings.mjs. These replace the basemap's own `composite`
   * building tiles, which do not cover this campus in any useful detail.
   *
   * Heights are placeholders, not survey data — see the generator. `min_height`
   * is absent from every feature, so the base coalesces to 0.
   */
  function add() {
    const colors = litPalette();

    // The theme toggle no longer rebuilds the style, so an existing layer has
    // to be recoloured in place rather than left on the old palette.
    if (map.getLayer('campus-buildings')) {
      map.setPaintProperty('campus-buildings', 'fill-extrusion-color', colors.building);
      return;
    }
    if (!footprints()) return; // still in flight; addNetworkLayers re-runs

    if (!map.getSource('campus-buildings')) {
      map.addSource('campus-buildings', { type: 'geojson', data: footprints() });
    }
    map.addLayer({
      id: 'campus-buildings',
      source: 'campus-buildings',
      type: 'fill-extrusion',
      slot: 'middle',
      // Extrusion is genuinely expensive to fill. Never draw it zoomed out.
      minzoom: 15,
      // Only what has mass. The pool is a footprint with a height of zero —
      // it is a hole in the ground, and src/landcover.json already draws the
      // water in it — so extruding it would put a slab of building colour over
      // the thing the footprint exists to name. It stays in the source, where
      // the directory, the card and the flyover all still find it.
      filter: ['>', ['get', 'height'], 0],
      paint: {
        'fill-extrusion-color': colors.building,
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
        // SOLID, where it was 0.85. A translucent building is a building you
        // can see the pavement through, which was survivable while these were
        // unlit slabs and is not now: the shadow one casts lands on ground that
        // is also showing through the thing casting it.
        'fill-extrusion-opacity': 1,
        // The point of the whole exercise, stated rather than left to the
        // default so that turning it off is a deliberate act. See sunLights.
        'fill-extrusion-cast-shadows': true,
        // ...and the contact shadow, which is what stops a building looking
        // like it is hovering a foot above its own footprint. Cheap, local, and
        // the one lighting cue that survives an overcast sky with no sun to
        // cast anything.
        'fill-extrusion-ambient-occlusion-intensity': 0.35,
        'fill-extrusion-ambient-occlusion-radius': 3,
        // The same opt-out every other layer here carries, and this was the one
        // that missed it. Standard lights extrusions through its own model, and
        // under the night preset that drove an authored #2f3336 to roughly
        // #0c0d0d — the campus turned into pitch-black blocks the moment
        // navigation started, and stayed that way.
        //
        // Not the flat 1 the other layers use, though. They are ground planes
        // and want their colour rendered exactly as written; this one is the
        // only thing on the map that is genuinely three-dimensional, and at 1
        // every face renders identically and a building reads as a sticker.
        // 0.75 is where the night preset stops swallowing them while the roof
        // still sits visibly lighter than the walls.
        //
        // It is a compromise and it is named so the bench can question it: this
        // number is the app's answer to "can Standard light these", and the
        // lighting section of the debug menu exists to find out whether a
        // better answer is reachable from `setLights` instead. See
        // src/lighting.js.
        'fill-extrusion-emissive-strength': BUILDING_EMISSIVE,
      },
    }, 'route-casing');

    // A layer that did not exist a moment ago has the palette's emissive
    // strength on it, not the bench's. Nothing else re-runs after this.
    applyLighting();
  }


  // The sun itself is src/sun-lights.js — a date and a place in, a light array
  // out, and no map anywhere in it.

  /**
   * Push the lighting bench onto the map, or take it back off.
   *
   * Everything here is gated on the debug menu being OPEN. That is the rule the
   * back room is built on — with the menu shut the app is exactly the app — and
   * it matters more for this section than for the flags it sits above, because
   * these values are plausible. A route GUI switched off is obviously a debug
   * state; a campus at dusk just looks like a decision somebody made.
   *
   * Called from addNetworkLayers rather than only from the control, because
   * every path that rebuilds the basemap — a theme change, a provider swap, a
   * full setStyle — re-runs the builders and would otherwise put Standard's own
   * lighting back while the bench still showed the override.
   */
  function applyLighting() {
    if (!isStyleBuilt()) return;

    const colors = litPalette();
    const active = bench();

    // The extrusions are navigation-only — see removeBuildingsLayer — and the
    // question this bench asks is entirely about the extrusions, so it is
    // allowed to stand them up outside a walk. `!navigating()` on the way down is
    // what keeps that from reaching into a real one: during navigation they are
    // the app's, and switching the bench off must not take them.
    //
    // addBuildingsLayer ends by calling back here, which is how a layer created
    // during a walk gets the bench's emissive rather than the palette's. That
    // bounce terminates at one level: the `getLayer` guard below is false on
    // the way in and true on the way back, so the second pass paints and stops.
    if (active?.buildings) {
      if (!map.getLayer('campus-buildings')) add();
    } else if (!navigating()) {
      remove();
    }

    // The camera, and only when the bench actually moved it. applyLighting runs
    // on every builder pass, and an easeTo per pass is a map that drifts while
    // you are trying to look at it. Never during navigation, which is pitched
    // to 60 and following somebody — that camera is not the bench's to take.
    const tilt = Boolean(active?.tilt);
    if (!navigating() && tilt !== benchTilt) {
      benchTilt = tilt;
      map.easeTo({ pitch: tilt ? 60 : 0, duration: 500 });
    }

    // Ours, and present under every provider, so this half runs even when there
    // is no Standard style underneath to configure.
    if (map.getLayer('campus-buildings')) {
      map.setPaintProperty(
        'campus-buildings',
        'fill-extrusion-emissive-strength',
        active ? active.emissive : BUILDING_EMISSIVE,
      );
    }

    // Google's ground is a raster under a blank style: no `basemap` import to
    // name, no lights to override. `lightPreset: null` is how palette.js says
    // so. Skipped outright rather than left to setConfig's warning, because a
    // bench pointed at a style that has no lighting should be quiet, not noisy.
    paintLamps();

    // The campus is emissive and cannot be relit; it has to be repainted. See
    // `paintedFor`. Read here rather than at the point of use because the lights
    // below need the same answer.
    const wanted = active && active.preset !== 'auto' ? active.preset : clockPreset();
    if (wanted !== paintedFor) {
      paintedFor = wanted;
      repaintCampus();
    }

    // NOT A RETURN, and it used to be one — `if (colors.lightPreset === null)
    // return;` stood here, and it is the whole reason "Stand the buildings up"
    // produced flat slabs with no shadows.
    //
    // The reasoning was sound for the two setConfig calls it guards: Google's
    // ground is a raster under BLANK_STYLE, there is no `basemap` import to
    // name, and a bench pointed at a style with no config should be quiet
    // rather than noisy. But it returned from the WHOLE function, and the
    // lights below are not config. `setLights` works on any style including a
    // blank one, and a blank one is precisely the case with no lighting of its
    // own to fall back on — so under the default provider the scene was lit by
    // nothing at all. `getLights()` answered `[{ id: 'flat', type: 'flat' }]`,
    // and every extrusion was a correctly-rendered unlit box.
    if (colors.lightPreset !== null) {

    // THE SKY, NOT THE INTERFACE. `colors.lightPreset` is the theme's opinion —
    // light means day, dark means night — which is a statement about the chrome
    // and not about the world, and it left the map in broad daylight at eleven
    // at night. The clock's answer comes from the sun's actual elevation over
    // this campus; see src/daylight.js for why that is arithmetic rather than a
    // table of hours.
    //
    // The theme is still whatever the device or the visitor says. These are two
    // different questions — what the interface should look like, and what the
    // ground outside looks like — and only the second one has a right answer.
    setConfig('lightPreset', active && active.preset !== 'auto' ? active.preset : clockPreset());
    // `default` is Standard's own default and the value the app runs at — the
    // app never sets this key, so `auto` means putting it back rather than
    // leaving it alone.
    setConfig('theme', active && active.theme !== 'auto' ? active.theme : 'default');
    }

    // WHICH LIGHTS, and there are two answers now.
    //
    // With the buildings standing the app supplies its own sun — see sunLights
    // — because that is the only case where the lighting has to do work rather
    // than just look right, and because under the default provider there is
    // otherwise no light in the scene whatsoever. Flat on the ground, the
    // captured style lighting is put back and left alone.
    //
    // A clone every time, not the captured array: setLights takes ownership of
    // what it is handed, and giving away the only copy of the style's own
    // lighting means the next revert has nothing to revert to.
    const standing = Boolean(map.getLayer('campus-buildings'));
    let lights = standing
      ? sunLights(new Date(), centre)
      : (standardLights() ? assist(structuredClone(standardLights()), wanted, theme()) : null);
    if (!lights) return;
    if (!active?.lights) {
      map.setLights(lights);
      return;
    }
    for (const light of lights) {
      // Standard writes both intensities as expressions over `lightPreset` and
      // `theme` — that is the whole reason this override exists, since a preset
      // is not separable from the number it implies. Replacing one property
      // with a literal collapses that expression for the light being questioned
      // and leaves its colour and direction still following the preset, which
      // is the comparison worth seeing.
      if (light.id === 'ambient') {
        // Colour as well as intensity, and the colour is the one that matters:
        // Standard's night ambient is hsl(217,100%,11%), so scaling it by any
        // intensity leaves it black and the extrusions stay swallowed. Measured
        // — ambient 0.5 to 1.0 at night moves a roof by about 1 L*.
        light.properties = {
          ...light.properties,
          intensity: active.ambient,
          color: active.ambientColor,
        };
      }
      if (light.id === 'directional') {
        light.properties = { ...light.properties, intensity: active.directional };
      }
    }
    map.setLights(lights);
  }

  /**
   * Extrusion is for navigation only.
   *
   * Everywhere else in this file the layer is guarded by `navigating()`, but
   * nothing ever took it down again — so ending a walk left the footprints
   * standing, which on the dark theme is a campus full of black blocks over a
   * map that is supposed to be flat.
   */
  function remove() {
    if (map.getLayer('campus-buildings')) map.removeLayer('campus-buildings');
  }
  return { add, remove, applyLighting };
}

