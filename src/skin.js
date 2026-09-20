// Which design language the whole app wears.
//
// A fourth axis, and the widest one: provider decides who draws the ground,
// basemap decides road-map or imagery, theme decides light or dark — this
// decides what the map and the chrome are *modelled on*. Both looks answer the
// same questions and neither is a subset of the other, so it multiplies out
// with the other three rather than replacing any of them.
//
//   classic — the Google Maps conventions this app was built to. Opaque white
//             cards, 8px corners, Roboto, a hairline rule under every heading,
//             and a ground palette that spreads hue (mint greens, blue water,
//             cream buildings) while keeping saturation low.
//   apple   — measured off a macOS Maps capture, not recalled. Translucent
//             materials over the map, continuous 14px corners, one hue family
//             for the whole ground with chroma carrying the meaning, and
//             capsule controls.
//
// Everything either look changes is a token or a palette entry. There is no
// second set of components, no `if (skin === 'apple')` in a layer builder, and
// no third look waiting to be special-cased — the two are the same app with two
// value tables, which is the only arrangement that stays true as the app grows.
//
// Apple is the default. The switch exists to go back.

import { readText, writeText } from './storage.js';

const STORAGE_KEY = 'mapper-skin';

export const SKINS = ['apple', 'classic'];

const ICON_ATTRS =
  'viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

// The corner radius IS the difference, so the icons are the same two stacked
// cards drawn at the two radii. Nothing else distinguishes them, which is
// honest: a glyph promising more than a restyle would be overclaiming.
const ICONS = {
  classic: `<svg ${ICON_ATTRS}><rect x="3" y="3" width="13" height="13" rx="1"/>` +
    '<path d="M8 21h13V8"/></svg>',
  apple: `<svg ${ICON_ATTRS}><rect x="3" y="3" width="13" height="13" rx="5"/>` +
    '<path d="M8 21h8a5 5 0 0 0 5-5V8"/></svg>',
};

const LABELS = { classic: 'Classic', apple: 'Apple' };

/**
 * Apple unless the user has said otherwise.
 *
 * Tested against 'classic' rather than for 'apple', so an empty localStorage
 * falls through to Apple — the same asymmetry, for the same reason, as
 * `preferredProvider`: the stored value only ever means "I went back".
 */
export function preferredSkin() {
  return readText(STORAGE_KEY) === 'classic' ? 'classic' : 'apple';
}

/**
 * Publish the skin to the stylesheet.
 *
 * Called once before the map is constructed as well as on every change, because
 * the chrome is painted from these tokens on the first frame — set it late and
 * the app opens as Google Maps and becomes Apple Maps a moment later, which
 * reads as a bug even to someone who wanted Apple all along.
 */
export function applySkinAttribute(skin) {
  document.documentElement.dataset.skin = skin;
}

/**
 * Wire up the toggle. Like the theme, basemap and provider controls, a button
 * advertises the look it will switch *to*, not the one on screen.
 *
 * `surfaces` is a list for the same reason it is on the provider control: this
 * setting is reachable from the rail and from the layers menu, there is exactly
 * one piece of state behind both, and every surface is redrawn from it on every
 * change — so neither can drift, because neither holds anything.
 */
export function createSkinControl({ surfaces, onChange }) {
  let skin = preferredSkin();

  function paint() {
    const target = skin === 'apple' ? 'classic' : 'apple';
    for (const { button, icon, label } of surfaces) {
      icon.innerHTML = ICONS[target];
      label.textContent = LABELS[target];
      button.setAttribute('aria-label', `Switch to the ${LABELS[target]} look`);
    }
  }

  function apply(next, { persist }) {
    skin = next;
    applySkinAttribute(skin);
    paint();
    if (persist) writeText(STORAGE_KEY, skin);
    onChange(skin);
  }

  for (const { button } of surfaces) {
    button.addEventListener('click', () => {
      apply(skin === 'apple' ? 'classic' : 'apple', { persist: true });
    });
  }

  apply(skin, { persist: false });
}
