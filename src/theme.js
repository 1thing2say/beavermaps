// Light, dark, or whatever the machine is set to.
//
// Three states rather than two, and the third one is the reason this is not a
// toggle. "Auto" is not a colour — it is the *absence* of a choice, the app
// deferring to `prefers-color-scheme`. A two-state switch can express dark and
// light but has nowhere to put "go back to following the system", so the moment
// a visitor touched it they were pinned to whatever they picked, for good. That
// is also Google's own vocabulary for this control: Light, Dark, System.
//
// Stored as the MODE, not the resolved theme. Persisting "dark" when the user
// picked Auto on a dark machine would silently pin them the first time they
// opened the app at night.

import { icon } from './g-icons.js';

const STORAGE_KEY = 'mapper-theme';
const MODES = ['light', 'dark', 'auto'];

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** What the user chose: 'light', 'dark' or 'auto'. */
export function preferredThemeMode() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return MODES.includes(saved) ? saved : 'auto';
}

/** The mode, turned into a theme the stylesheet and the palette understand. */
export function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return darkQuery.matches ? 'dark' : 'light';
}

/** The theme to paint right now. */
export function preferredTheme() {
  return resolveTheme(preferredThemeMode());
}

export function applyThemeAttribute(theme) {
  document.documentElement.dataset.theme = theme;
}

const LABEL = { light: 'Light', dark: 'Dark', auto: 'Auto' };

/**
 * Wire up the appearance control, in both the places it appears.
 *
 * `group` holds one button per mode, marked with `data-theme-mode`. They carry
 * radio semantics rather than three independent pressed states, because that is
 * what they are — picking one un-picks the others, and a screen reader should
 * say so.
 *
 * `cycle` is the optional rail button: one glyph, advancing through the three in
 * order. Two controls for one setting is a synchronisation bug waiting to
 * happen, so there is only one piece of state here and both are redrawn from it
 * on every change — neither can drift, because neither holds anything.
 */
export function createThemeControl({ group, cycle, onChange }) {
  const buttons = [...group.querySelectorAll('[data-theme-mode]')];
  let mode = preferredThemeMode();

  function apply(next, { persist }) {
    mode = next;
    const theme = resolveTheme(mode);
    applyThemeAttribute(theme);
    for (const button of buttons) {
      button.setAttribute('aria-checked', String(button.dataset.themeMode === mode));
    }
    if (cycle) {
      cycle.icon.innerHTML = icon(mode);
      cycle.text.textContent = LABEL[mode];
      // Says where you are and where the press will take you, because a
      // one-button cycle is otherwise a guess.
      cycle.button.setAttribute(
        'aria-label',
        `Appearance: ${LABEL[mode]}. Switch to ${LABEL[MODES[(MODES.indexOf(mode) + 1) % MODES.length]]}`,
      );
    }
    if (persist) localStorage.setItem(STORAGE_KEY, mode);
    onChange(theme);
  }

  for (const button of buttons) {
    button.addEventListener('click', () => apply(button.dataset.themeMode, { persist: true }));
  }

  cycle?.button.addEventListener('click', () => {
    apply(MODES[(MODES.indexOf(mode) + 1) % MODES.length], { persist: true });
  });

  // Follow the machine, but only while the visitor has actually asked us to.
  darkQuery.addEventListener('change', () => {
    if (mode === 'auto') apply('auto', { persist: false });
  });

  apply(mode, { persist: false });
}
