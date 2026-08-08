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
// Google is the default. Mapbox is still the fallback, and has to be: Google's
// half can fail in a way Mapbox's cannot — a missing key, a disabled Map Tiles
// API, a referrer the key does not allow — and none of those can be detected
// until a session is actually requested. See `revert` below.

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
 * `revert` exists because this control can fail in a way the other two cannot:
 * Google's tiles need a key, an enabled API and a matching referrer
 * restriction, none of which can be checked until a tile is actually asked for.
 * When that request comes back refused, the caller uses this to put the button
 * back where it was, so the label never claims a basemap that is not drawn.
 */
export function createProviderToggle({ button, icon, label, onChange }) {
  let provider = preferredProvider();

  function apply(next, { persist }) {
    provider = next;

    const target = provider === 'google' ? 'mapbox' : 'google';
    icon.innerHTML = ICONS[target];
    label.textContent = LABELS[target];
    button.setAttribute('aria-label', `Switch to the ${LABELS[target]} basemap`);

    if (persist) localStorage.setItem(STORAGE_KEY, provider);
    onChange(provider);
  }

  button.addEventListener('click', () => {
    apply(provider === 'google' ? 'mapbox' : 'google', { persist: true });
  });

  apply(provider, { persist: false });

  return {
    /** Drop back to Mapbox without re-notifying the caller that asked us to. */
    revert() {
      provider = 'mapbox';
      localStorage.setItem(STORAGE_KEY, provider);
      icon.innerHTML = ICONS.google;
      label.textContent = LABELS.google;
      button.setAttribute('aria-label', `Switch to the ${LABELS.google} basemap`);
    },
  };
}
