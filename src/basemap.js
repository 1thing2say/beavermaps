const STORAGE_KEY = 'mapper-basemap';

const ICON_ATTRS =
  'viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  // Folded paper map.
  map: `<svg ${ICON_ATTRS}><path d="M9 3 3 5.5v15L9 18l6 3 6-2.5v-15L15 6 9 3z"/>` +
    '<path d="M9 3v15M15 6v15"/></svg>',
  // Globe with an orbit, for imagery.
  satellite: `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="8"/>` +
    '<path d="M4 12h16M12 4a13 13 0 0 1 0 16a13 13 0 0 1 0-16z"/></svg>',
};

/**
 * The basemap is deliberately independent of the light/dark theme: imagery has
 * its own fixed brightness, so pairing it with a theme would mean four
 * combinations where only two are meaningful.
 */
export function preferredBasemap() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'satellite' ? 'satellite' : 'map';
}

/**
 * Wire up the toggle. Like the theme control, the button advertises the basemap
 * it will switch *to*, not the one currently shown.
 */
export function createBasemapToggle({ button, icon, label, onChange }) {
  let basemap = preferredBasemap();

  function apply(next, { persist }) {
    basemap = next;

    const target = basemap === 'satellite' ? 'map' : 'satellite';
    icon.innerHTML = ICONS[target];
    label.textContent = target === 'satellite' ? 'Satellite' : 'Map';
    button.setAttribute('aria-label', `Switch to ${target} basemap`);

    if (persist) localStorage.setItem(STORAGE_KEY, basemap);
    onChange(basemap);
  }

  button.addEventListener('click', () => {
    apply(basemap === 'satellite' ? 'map' : 'satellite', { persist: true });
  });

  apply(basemap, { persist: false });
}
