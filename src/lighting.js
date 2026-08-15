// The lighting bench.
//
// Not a setting, and not a lie either — the two kinds of thing the debug menu
// held until now. This is a bench for one question, and the question is whether
// Mapbox Standard's own lighting model can be made to carry the campus
// buildings.
//
// THE QUESTION. `campus-buildings` is drawn with
// `fill-extrusion-emissive-strength: 0.75`, which opts the extrusions three
// quarters of the way out of Standard's lighting. The note on that property in
// main.js says why: under the `night` preset an authored #2f3336 came back as
// roughly #0c0d0d, and the campus turned into black blocks the moment
// navigation started. Emissive strength was the fix that was reachable from
// inside the layer, and it costs the thing extrusion is for — at 0.75 the roof
// and the walls are nearly the same value, so a building reads as a sticker
// rather than a solid.
//
// The fix that was NOT reachable from the layer is `setLights`. Standard's
// ambient light drops to intensity 0.5 at night against 0.8 by day, and its
// directional light is a zoom interpolation that lands at 0.5 by night and 0.2
// by day. Those numbers are Mapbox's judgement about a city at night, not
// physics, and a campus wayfinding map at z16 is not the case they tuned them
// for. If lifting the ambient makes unlit buildings legible without wrecking
// everything else Standard lights, the emissive opt-out can go and the
// extrusions get shading, ambient occlusion and cast shadows back.
//
// So: five presets crossed with four colour themes, and three numbers you can
// pull while looking at the answer. The grid is the point — the interaction
// between a preset and a theme is not predictable from either one, because
// Standard's light expressions branch on BOTH (`monochrome` at night takes the
// ambient to 0, which no other cell does).
//
// WHAT IS NOT HERE. `theme: custom`, which is how the demo on mapbox.com gets
// Ocean, Warm and Vivid. Those are not preset names — Standard's schema stops
// at default/faded/monochrome/custom, and custom reads `theme-data`, a colour
// lookup table encoded as a 1024x32 RGB PNG. That is a grading pipeline, not a
// value to pick from a row, and it is a separate piece of work.
//
// The bench setting is remembered across reloads, because half of sweeping a
// grid like this is reloading into the cell you left off in. It is NOT app
// state: main.js gates every value here on the menu being open, so a bench left
// at Dusk cannot follow you out of the back room. See the rule at the top of
// debug.js — this file is the reason that rule needed writing down twice.

const STORAGE_KEY = 'mapper-lighting';

/** Standard's `lightPreset`, plus the one that means "whatever the theme says". */
export const PRESETS = ['auto', 'dawn', 'day', 'dusk', 'night'];

/** Standard's `theme`. `custom` is a LUT and is not reachable from a button. */
export const THEMES = ['auto', 'default', 'faded', 'monochrome'];

/**
 * Where the bench sits when nothing has been stored.
 *
 * Both selectors start at `auto`, which is what makes an untouched bench a
 * no-op: the app's own palette decides, exactly as it does with the menu shut.
 * `emissive` has no `auto` because it does not need one — main.js hands in the
 * layer's own value, so the slider starts on the number the app already uses
 * and moving it is the only way to change anything.
 *
 * The light intensities are the values Standard itself uses at night, so
 * switching the override on while the map is dark changes nothing visible and
 * the sliders start from the state being questioned rather than beside it.
 */
const DEFAULTS = {
  preset: 'auto',
  theme: 'auto',
  buildings: false,
  tilt: false,
  emissive: 0.75,
  lights: false,
  ambient: 0.5,
  directional: 0.5,
  // Standard's own ambient colour under the `night` preset, hsl(217,100%,11%)
  // written as the hex a colour input can hold. It is worth knowing what this
  // number is before touching it: it is very nearly black, which means ambient
  // INTENSITY is close to a no-op at night — scaling a black light leaves it
  // black. That is the trap this control exists to make visible, and it is the
  // reason the intensity slider above it is not the answer it looks like.
  ambientColor: '#001538',
};

/** The switches, which are all read the same way and all default to off. */
const FLAGS = ['buildings', 'tilt', 'lights'];

/** A number if it is one and it is in range, otherwise the fallback. */
function num(value, fallback) {
  return typeof value === 'number' && value >= 0 && value <= 2 ? value : fallback;
}

/**
 * What was stored, sanitised.
 *
 * Same posture as debug.js: this key is hand-editable, and a malformed one
 * should give you a working bench rather than a stack trace. Every field is
 * checked against what it is allowed to be rather than trusted.
 */
function stored(defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return { ...defaults };
    const state = {
      preset: PRESETS.includes(saved.preset) ? saved.preset : defaults.preset,
      theme: THEMES.includes(saved.theme) ? saved.theme : defaults.theme,
      emissive: num(saved.emissive, defaults.emissive),
      ambient: num(saved.ambient, defaults.ambient),
      directional: num(saved.directional, defaults.directional),
      ambientColor: /^#[0-9a-f]{6}$/i.test(saved.ambientColor)
        ? saved.ambientColor
        : defaults.ambientColor,
    };
    for (const flag of FLAGS) state[flag] = saved[flag] === true;
    return state;
  } catch {
    return { ...defaults };
  }
}

/**
 * Wire up the bench.
 *
 * `root` is the section in the debug panel; everything is found inside it, so
 * this module names one element and the markup owns the rest. `emissive` is the
 * layer's own emissive strength, handed in rather than repeated here — the
 * number lives with the comment that explains it, in main.js, and this file
 * only needs to know where the slider starts.
 *
 * `onChange` gets the whole bench on every change including the first, for the
 * reason debug.js hands over its whole state: the caller applies one function
 * to one object and never has to work out which field moved.
 */
export function createLightingControl({ root, emissive, onChange }) {
  const defaults = { ...DEFAULTS, emissive };
  const state = stored(defaults);

  const presetButtons = [...root.querySelectorAll('[data-light-preset]')];
  const themeButtons = [...root.querySelectorAll('[data-light-theme]')];
  const sliders = {
    emissive: root.querySelector('#debug-emissive'),
    ambient: root.querySelector('#debug-ambient'),
    directional: root.querySelector('#debug-directional'),
  };
  const outputs = {
    emissive: root.querySelector('#debug-emissive-out'),
    ambient: root.querySelector('#debug-ambient-out'),
    directional: root.querySelector('#debug-directional-out'),
  };
  const switches = Object.fromEntries(
    FLAGS.map((flag) => [flag, root.querySelector(`#debug-${flag}`)]),
  );
  const ambientColor = root.querySelector('#debug-ambient-color');
  const reset = root.querySelector('#debug-lighting-reset');

  function publish({ persist = true } = {}) {
    for (const button of presetButtons) {
      button.setAttribute('aria-checked', String(button.dataset.lightPreset === state.preset));
    }
    for (const button of themeButtons) {
      button.setAttribute('aria-checked', String(button.dataset.lightTheme === state.theme));
    }
    for (const [key, input] of Object.entries(sliders)) {
      input.value = String(state[key]);
      outputs[key].textContent = state[key].toFixed(2);
    }
    for (const [flag, input] of Object.entries(switches)) input.checked = state[flag];
    // The two intensities mean nothing until the override is on, and a disabled
    // control that still shows its position is the honest way to say so — the
    // same choice the flag switches make while the menu is shut.
    //
    // Emissive is NOT disabled alongside the buildings switch, though it looks
    // like the same case. It is not: the extrusions also stand up on their own
    // during a walk, and greying out the one number this bench is really about
    // whenever the bench did not personally raise them would be a lie told by
    // an interface that is otherwise careful not to.
    sliders.ambient.disabled = !state.lights;
    sliders.directional.disabled = !state.lights;
    ambientColor.value = state.ambientColor;
    ambientColor.disabled = !state.lights;

    if (persist) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    onChange({ ...state });
  }

  for (const button of presetButtons) {
    button.addEventListener('click', () => {
      state.preset = button.dataset.lightPreset;
      publish();
    });
  }

  for (const button of themeButtons) {
    button.addEventListener('click', () => {
      state.theme = button.dataset.lightTheme;
      publish();
    });
  }

  for (const [key, input] of Object.entries(sliders)) {
    // `input` rather than `change`, because the whole value of a slider here is
    // watching the map move under your thumb. Every builder this reaches is a
    // property set on an existing layer, not a rebuild, so a drag is cheap.
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      publish();
    });
  }

  for (const [flag, input] of Object.entries(switches)) {
    input.addEventListener('change', () => {
      state[flag] = input.checked;
      publish();
    });
  }

  ambientColor.addEventListener('input', () => {
    state.ambientColor = ambientColor.value;
    publish();
  });

  reset?.addEventListener('click', () => {
    Object.assign(state, defaults);
    publish();
  });

  publish({ persist: false });
}
