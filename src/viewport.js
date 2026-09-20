// How much of the canvas the chrome is standing on, and whether a thing can be
// seen on what is left.
//
// Three functions, all pure, all taking plain rectangles. In startApp() they
// read the DOM directly and called `map.project`, which meant the arithmetic
// could only be exercised by opening the app on a phone and looking — and the
// comments below record three separate occasions when looking is what found the
// bug: the athletics field framed at z11 under a full-height sheet, the campus
// put underneath a bottom sheet whose width was being reserved as if it were a
// sidebar, and three bus stops that counted as "in view" from behind a pane of
// glass.
//
// The DOM half stays in main.js: which elements to measure is its business.
// What the numbers mean is this module's.

/** Breathing room around the campus when it is framed, in px. */
export const FIT_MARGIN = 40;

/**
 * The least of the canvas a framed answer may be squeezed into, as a fraction
 * of its height.
 *
 * Measured on a 402x874 phone with a results panel open: the sheet leaves 39%
 * of the canvas at `half`, 29% at `rest` — where `rest` is content-sized, so it
 * is the taller list that makes it the smaller strip — and 1.9% at `full`.
 */
export const MIN_VIEW = 0.18;

const even = () => ({ top: FIT_MARGIN, bottom: FIT_MARGIN, left: FIT_MARGIN, right: FIT_MARGIN });

/**
 * Reserve the canvas the open cards are standing on.
 *
 * Every card, not one. Three of them stack in the left column and the legend
 * holds the right edge, and each is a strip of canvas the campus can be hidden
 * under — framing a highlight beneath the legend row that asked for it is the
 * one place the camera can put something where it cannot be seen.
 *
 * Mapbox throws if padding exceeds the canvas, so on a screen too narrow to
 * hold both sides, fall back to an even margin and let the chrome overlap.
 *
 * @param {object} canvas  the map canvas's rect: left/right/top/bottom/width/height
 * @param {Array}  boxes   the rects of the cards that are currently open
 */
export function paddingAround({ canvas, boxes }) {
  if (!canvas?.width) return even();

  const open = boxes.filter((box) => box.width);
  if (!open.length) return even();

  // Below 640px the stylesheet turns the column into a bottom sheet spanning
  // the full width, and there what a card costs is height, not width.
  // Reserving its width would exceed the canvas and fall back to an even
  // margin, which puts the campus underneath it. Either card can be the sheet
  // — on a phone the legend replaces the route panel rather than stacking
  // under it — so this asks the boxes, not one named element.
  const sheets = open.filter((box) => box.width >= canvas.width * 0.6);
  if (sheets.length) {
    const bottom = canvas.bottom - Math.min(...sheets.map((box) => box.top)) + FIT_MARGIN;
    return bottom + FIT_MARGIN < canvas.height ? { ...even(), bottom } : even();
  }

  // Both edges now. A card in the right half used to be skipped outright,
  // because until the legend moved over there nothing was ever in it.
  let left = FIT_MARGIN;
  let right = FIT_MARGIN;
  for (const box of open) {
    if (box.left - canvas.left > canvas.width / 2) {
      right = Math.max(right, canvas.right - box.left + FIT_MARGIN);
    } else {
      left = Math.max(left, box.right - canvas.left + FIT_MARGIN);
    }
  }
  if (left + right >= canvas.width) return even();
  return { ...even(), left, right };
}

/**
 * `paddingAround`, told where the sheet is GOING rather than where it is.
 *
 * `paddingAround` measures the cards that are open, which is right for a
 * sidebar — a sidebar's width changes the instant a card arrives — and half a
 * frame late for a sheet. On a phone a card opening does two more things: the
 * stack asks the sheet for at least the half detent, and the stylesheet then
 * animates the height over 240ms. Measure during that and the answer is
 * wherever the top edge happened to be passing, so the camera settles a
 * fraction of a sheet too low and the thing it was framing ends up behind the
 * glass.
 *
 * So the sheet is asked instead of measured. See `top` in src/sheet.js.
 *
 * @param {number|null} sheetTop  where the sheet's top edge will settle, or null
 */
export function padBelowSheet({ pad, sheetTop, canvasBottom, canvasHeight }) {
  if (sheetTop === null || sheetTop === undefined) return pad;

  const bottom = canvasBottom - sheetTop + FIT_MARGIN;
  // A strip has to be big enough to see a campus in, not merely bigger than
  // nothing. The guard here used to be the one paddingAround makes — leave
  // SOME canvas, because Mapbox throws when the padding eats all of it — and
  // it let a sheet at `full` through with 110px to spare, into which fitBounds
  // duly squeezed the whole athletics field: z11, forty miles of the county,
  // and the five buildings you asked about as a smudge under the glass.
  //
  // The sheet is settled at `half` before a panel opens now (see onFront), so
  // this should not be reached by the path that produced it. It stays because
  // it is the floor rather than the fix: a short screen, a rotation, a card
  // that grows after the sheet has settled — any of them can put the top edge
  // somewhere nothing planned for, and the honest answer there is to frame
  // against the whole canvas and let the sheet cover part of the result.
  if (canvasHeight - bottom - pad.top < canvasHeight * MIN_VIEW) return pad;
  return { ...pad, bottom };
}

/**
 * Is this point somewhere it can be read?
 *
 * In SCREEN PIXELS against the padded rectangle, not with
 * map.getBounds().contains(). Bounds are the whole canvas, the strip behind
 * the sheet and the strip behind the sidebar included, so a point can be
 * inside them and behind a pane of glass — which is how the three bus stops
 * at the west edge once counted as visible while nobody could see them.
 */
export function isVisible({ point, width, height, pad }) {
  return point.x >= pad.left && point.x <= width - pad.right
    && point.y >= pad.top && point.y <= height - pad.bottom;
}
