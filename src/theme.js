const STORAGE_KEY = 'mapper-theme';

const ICON_ATTRS =
  'viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  dark: `<svg ${ICON_ATTRS}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
  light:
    `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="4"/>` +
    '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4' +
    'M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
};

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** Saved choice wins; otherwise fall back to whatever the OS is set to. */
export function preferredTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return darkQuery.matches ? 'dark' : 'light';
}

export function applyThemeAttribute(theme) {
  document.documentElement.dataset.theme = theme;
}

/**
 * Wire up the toggle. The control advertises the theme it will switch *to*,
 * which is the convention people already read these buttons by.
 */
export function createThemeToggle({ button, icon, label, onChange }) {
  let theme = preferredTheme();

  function apply(next, { persist }) {
    theme = next;
    applyThemeAttribute(theme);

    const target = theme === 'dark' ? 'light' : 'dark';
    icon.innerHTML = ICONS[target];
    label.textContent = target === 'dark' ? 'Dark' : 'Light';
    button.setAttribute('aria-label', `Switch to ${target} mode`);

    if (persist) localStorage.setItem(STORAGE_KEY, theme);
    onChange(theme);
  }

  button.addEventListener('click', () => {
    apply(theme === 'dark' ? 'light' : 'dark', { persist: true });
  });

  // Track the OS only until the user has expressed a preference of their own.
  darkQuery.addEventListener('change', (event) => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    apply(event.matches ? 'dark' : 'light', { persist: false });
  });

  apply(theme, { persist: false });
}
