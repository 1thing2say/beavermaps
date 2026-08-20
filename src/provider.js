// Who draws the ground: Mapbox, or Google.
//
// A third axis rather than a third value on the basemap toggle, because it is
// genuinely independent of the other two. Both providers offer a road map and
// imagery, and both are readable in either theme, so the three controls
// multiply out cleanly: provider x basemap x theme, and every combination
// means something.
//
// Everything drawn *on* the ground — the network, the campus sheet, the labels,
// the route, the pins — is ours in both cases, and does not change.
//
// Google is the default, and Mapbox is the fallback, because only one of them
// can be checked before it is needed: Google's ground cannot be requested at
// all until a session has been minted, so a missing key, a disabled Map Tiles
// API or a referrer the key does not allow all surface as one rejected promise
// with a reason in it. See `revert` below.
//
// That is a difference in HOW the two fail, not in WHETHER. This comment used
// to say Mapbox's half could not fail this way, and a phone on the LAN proved
// otherwise inside a minute — a Mapbox token carries URL restrictions of its
// own, and refuses a new origin exactly as Google's key does. What Mapbox has
// no way to do is say so once: the refusal arrives per tile, forever. See
// src/basemap-problem.js. Falling back to a provider that is refusing tiles
// would be a switch to nothing, so `revert` is still worth having and is still
// only reachable from Google's side.

import { spin } from './spinner.js';

const STORAGE_KEY = 'mapper-provider';

const ICON_ATTRS =
  'viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  // Stacked sheets, for the vector style package.
  mapbox: `<svg ${ICON_ATTRS}><path d="m12 3 9 5-9 5-9-5 9-5z"/>` +
    '<path d="m3 13 9 5 9-5"/></svg>',
  // The teardrop pin, which is Google's own shorthand for itself.
  google: `<svg ${ICON_ATTRS}><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/>` +
    '<circle cx="12" cy="10" r="2.5"/></svg>',
};

const LABELS = { mapbox: 'Mapbox', google: 'Google' };

/**
 * Google draws the ground unless the user has said otherwise.
 *
 * Tested against the stored value being 'mapbox' rather than 'google', so an
 * empty localStorage falls through to Google. The asymmetry is deliberate:
 * `revert()` below writes 'mapbox' when a tile request comes back refused, and
 * that write is what has to survive a reload. Defaulting to Google while
 * treating an absent key as "no preference" would put every visitor through the
 * same failed session request on every page load.
 */
export function preferredProvider() {
  return localStorage.getItem(STORAGE_KEY) === 'mapbox' ? 'mapbox' : 'google';
}

/**
 * Wire up the toggle. Like the theme and basemap controls, the button
 * advertises the provider it will switch *to*, not the one on screen.
 *
 * `surfaces` is a list because this control is reachable from two places — the
 * layers menu and the rail — and there is exactly one piece of state behind
 * them. Every surface is redrawn from it on every change, so neither can drift:
 * neither holds anything. Same arrangement, and the same reasoning, as the
 * appearance control in theme.js.
 *
 * `revert` exists because this control can fail in a way the other two cannot:
 * Google's tiles need a key, an enabled API and a matching referrer
 * restriction, none of which can be checked until a tile is actually asked for.
 * When that request comes back refused, the caller uses this to put the buttons
 * back where they were, so no label claims a basemap that is not drawn.
 */
export function createProviderToggle({ surfaces, onChange }) {
  let provider = preferredProvider();

  /** Every surface says what pressing it will DO, not what is on screen. */
  function paint() {
    // Published the way the theme and the skin are, and for a reason the other
    // two do not have: under Google the Mapbox style is BLANK — no sources, no
    // layers, nothing of theirs drawn — so the wordmark their control pins to
    // the corner is crediting data that is not on the map, next to Google's own
    // required copyright line for the data that is. The stylesheet hides it on
    // this attribute. See the note beside that rule before changing either.
    document.documentElement.dataset.provider = provider;

    const target = provider === 'google' ? 'mapbox' : 'google';
    for (const { button, icon, label } of surfaces) {
      icon.innerHTML = ICONS[target];
      label.textContent = LABELS[target];
      button.setAttribute('aria-label', `Switch to the ${LABELS[target]} basemap`);
    }
  }

  function apply(next, { persist }) {
    provider = next;
    paint();
    if (persist) localStorage.setItem(STORAGE_KEY, provider);
    onChange(provider);
  }

  for (const { button } of surfaces) {
    button.addEventListener('click', () => {
      apply(provider === 'google' ? 'mapbox' : 'google', { persist: true });
    });
  }

  apply(provider, { persist: false });

  /** Spinner stoppers, one per surface, while a session is being minted. */
  let stops = [];

  return {
    /**
     * Say that the ground is on its way.
     *
     * This is the one toggle in the app whose effect is not immediate. The
     * theme and the skin repaint on the next frame; Google's ground cannot be
     * asked for until a session token has been minted, which is a round trip to
     * tile.googleapis.com before the first tile can even be requested. Until it
     * lands the map keeps drawing whatever was underneath, so a press on this
     * button looks like a press that did nothing — and the honest reading of
     * that is to press it again.
     *
     * The spinner goes in the icon slot rather than beside the label because
     * that slot is already the right size and is already the thing that changes
     * when the provider does. `paint()` puts the icon back, which makes the
     * restore path the same one every other change goes through.
     */
    busy(on) {
      for (const stop of stops) stop();
      stops = [];
      if (!on) { paint(); return; }
      for (const { icon } of surfaces) {
        icon.innerHTML = '';
        // `currentColor`, so it inherits whichever of the two surfaces it is
        // on — the rail's ink and the layers menu's are not the same.
        stops.push(spin(icon, { size: 'sm', color: 'currentColor' }));
      }
    },

    /** Drop back to Mapbox without re-notifying the caller that asked us to. */
    revert() {
      provider = 'mapbox';
      localStorage.setItem(STORAGE_KEY, provider);
      paint();
    },
  };
}
