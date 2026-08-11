// The chrome's icon set: one 24x24 grid, one visual weight, filled shapes.
//
// Separate from map-images.js on purpose. That file draws *map* pictograms —
// coloured discs rasterised into the GL canvas as symbol images. These are DOM
// icons for buttons and chips, monochrome, taking their colour from
// `currentColor` so one definition works on a white chip, a dark panel and a
// blue primary button alike.
//
// Drawn rather than pulled from an icon package because the app already ships
// two hand-drawn icon sets (nav-icons.js, map-images.js) and a third dependency
// for ten glyphs would be the only one of the three with a supply chain.

/** name -> inner SVG markup on a 24x24 viewBox, filled with currentColor. */
const PATHS = {
  // A hamburger lived here, and it was the left rail's collapse button. The rail
  // is gone and the route panel now collapses from the directions button in the
  // top bar, which has its own glyph, so nothing draws three stacked lines any
  // more. Removed rather than left in reach: every other name in this table is
  // referenced by something, and the one exception is the one nobody notices has
  // gone stale.
  close:
    '<path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3 10.6 10.6 16.9 4.3z"'
    + ' transform="translate(2.4 0)"/>',
  search:
    '<path d="M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.7 4.8-1.4 1.4-4.8-4.7A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/>',
  directions:
    '<path d="M12.7 2.3a1 1 0 0 0-1.4 0L2.3 11.3a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM13 15v-2.5h-3V15H8v-3.5a1 1 0 0 1 1-1h4V8l3.2 3z"/>',
  chevronLeft: '<path d="M15.4 5.4 8.8 12l6.6 6.6-1.4 1.4L6 12l8-8z"/>',
  chevronRight: '<path d="M8.6 5.4 15.2 12l-6.6 6.6 1.4 1.4L18 12l-8-8z"/>',
  layers:
    '<path d="M12 3.2 22 9l-10 5.8L2 9zm7.5 9.1 2.5 1.4-10 5.8-10-5.8 2.5-1.4L12 16.2z"/>',
  legend:
    '<path d="M4 5h4v4H4zm6 .8h10v2.4H10zM4 11h4v4H4zm6 .8h10v2.4H10zM4 17h4v4H4zm6 .8h10v2.4H10z"/>',
  walk:
    '<path d="M13.6 2.6a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8zM10.2 8.1 13 7a3 3 0 0 1 3.3.8l1.3 1.5 2.3 1-.8 1.9-2.8-1.2-1-1.1-.9 4 2.5 2.4 1.4 5.1-2 .6-1.2-4.3-3.4-3.1-1 4.3-2.5 4.6-1.8-1 2.3-4.2 1.5-6.8-1.7.9-1 2.9-1.9-.7 1.2-3.4z"/>',
  navigate: '<path d="M2.6 11.1 21.4 3.2 13.5 22l-2.3-8.6z"/>',

  // --- the appearance control ------------------------------------------------
  // Sun, moon, and a disc split down the middle for "follow the machine" — the
  // half-and-half mark every OS uses for this, so it needs no label to be read.
  light:
    '<path d="M12 7.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2zM11 2h2v3.2h-2zm0 16.8h2V22h-2z'
    + 'M2 11h3.2v2H2zm16.8 0H22v2h-3.2zM4.2 5.6 5.6 4.2l2.3 2.3-1.4 1.4zm11.9 11.9 1.4-1.4 2.3 2.3'
    + '-1.4 1.4zM4.2 18.4l2.3-2.3 1.4 1.4-2.3 2.3zM16.1 6.5l2.3-2.3 1.4 1.4-2.3 2.3z"/>',
  dark:
    '<path d="M21.4 13.4A9.4 9.4 0 1 1 10.6 2.6a7.4 7.4 0 0 0 10.8 10.8z"/>',
  auto:
    '<path fill-rule="evenodd" d="M12 2.4a9.6 9.6 0 1 1 0 19.2 9.6 9.6 0 0 1 0-19.2zm0 2v15.2'
    + 'a7.6 7.6 0 0 0 0-15.2z"/>',
  // --- category glyphs, all from my campus's printed legend ------------------------
  restroom:
    '<path d="M7.6 2.4a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zM5.4 6.9h4.4l1.7 6.1h-2v8.6H5.7V13H3.7zM16.4 2.4a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zm-2.6 4.5h5.2l1.7 7h-1.9v7.7h-4.8V13.9h-1.9z"/>',
  parking:
    '<path d="M4.6 3h6.8a5.8 5.8 0 0 1 0 11.6H9v6.4H4.6zm4.4 3.6v4.4h2.4a2.2 2.2 0 0 0 0-4.4z"/>'
    + '<path d="M15.6 15.4h4.8v5.6h-4.8z" opacity=".0"/>',
  bike_rack:
    '<path d="M6.3 12.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2zm0 2a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zm11.4-2a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2zm0 2a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zM14.3 3h3.4v2h-2.2l1 2.4H12l-3 3.9-1.6-1.2 3.2-4.2h3.6z"/>'
    + '<path d="M9.4 8.3h5.9l2 8.2-1.9.5-1.7-6.7h-4.3z"/>',
  emergency_phone:
    '<path d="M7.6 3.3a1.6 1.6 0 0 1 2.2.5l1.8 2.8a1.6 1.6 0 0 1-.4 2.2l-1.5 1a12.4 12.4 0 0 0 5 5l1-1.5a1.6 1.6 0 0 1 2.2-.4l2.8 1.8a1.6 1.6 0 0 1 .5 2.2l-1.3 2a2.7 2.7 0 0 1-3 1.1C11.7 18.3 5.7 12.3 4.5 5.6a2.7 2.7 0 0 1 1.1-3z"/>',
  defibrillator: '<path d="M14.2 2 6 13.6h4.4L9.4 22l8.2-11.6h-4.4z"/>',
  health_centre: '<path d="M9.6 2.6h4.8v5.2h5.2v4.8h-5.2v5.2H9.6v-5.2H4.4V7.8h5.2z"/>',
  drop_off:
    '<path d="M4.4 13.6 6 9.2a2.6 2.6 0 0 1 2.5-1.7h7a2.6 2.6 0 0 1 2.5 1.7l1.6 4.4V20h-2.8v-1.8H7.2V20H4.4zm3-1.2h9.2l-1.1-3H8.5zM7.4 15a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zm9.2 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z"/>',
  motorcycle_parking:
    '<path d="M5.2 13.4a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6zm0 2a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6zm13.6-2a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6zm0 2a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6zM12.4 4h4l2 5.2h2.2v2h-3.6l-1.4-3.6h-1.4l-2.6 3.8h-4v-2h2.9l2.3-3.4H12.4z"/>'
    + '<path d="M5.2 15.4h5.6l2.4-2h3.2v2h-2.4l-2.4 2H5.2z"/>',
  vending:
    '<path d="M5.4 2.6h13.2a1.6 1.6 0 0 1 1.6 1.6v15.6a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6V4.2a1.6 1.6 0 0 1 1.6-1.6zm.4 2.4v9.4h6V5zm7.8 0v2.2h4.6V5zm0 3.7v2.2h4.6V8.7zm0 3.7v2.2h4.6v-2.2zM5.8 16.6v2.8h6v-2.8zm8 .4v2.4h4.6V17z"/>',
  homebase:
    '<path d="M12 2.6 22 11h-3v9.4h-5.4v-5.6h-3.2v5.6H5V11H2z"/>',
  bus:
    '<path d="M6 2.6h12a2.4 2.4 0 0 1 2.4 2.4v11.4a2.4 2.4 0 0 1-1.4 2.2v1.8a1 1 0 0 1-1 1h-1.4a1 1 0 0 1-1-1v-1.6H8.4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-1.8a2.4 2.4 0 0 1-1.4-2.2V5A2.4 2.4 0 0 1 6 2.6zm-.4 3v6.6h12.8V5.6zm2 8.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zm8.8 0a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z"/>',
};

/** Every glyph this module can draw. Exported so the tests can check the join
 *  between a category's `glyph` name and something that actually exists. */
export const ICON_NAMES = Object.keys(PATHS);

/** The markup for one icon, sized to fill whatever box it is dropped into. */
export function icon(name) {
  const body = PATHS[name];
  if (!body) return '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" '
    + `fill="currentColor" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * Fill every `[data-icon]` under `root` with its glyph.
 *
 * Markup carries the *name* and this puts the drawing in, rather than the HTML
 * carrying 20 lines of path data per button. Idempotent, so it is safe to call
 * again after rendering more chrome.
 */
export function paintIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.dataset.icon;
    if (el.firstElementChild || !PATHS[name]) continue;
    el.innerHTML = icon(name);
  }
}
