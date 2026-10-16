// The keyboard cursor in a results list, for every field that has one.
//
// The search box and the two route-panel fields each draw a `.g-results`
// listbox under a combobox input, and the cursor in each has four things to
// keep in step: which row says it is selected, which row the input tells a
// screen reader is active, that the row is scrolled into view, and whether
// the list has been navigated at all — a phone only paints the selected row
// once it has (see `.g-results.is-navigating` in input.css).
//
// The search box did all four. The route fields did the first only, so on a
// narrow window the arrows moved a cursor nobody could see, and a screen
// reader announced nothing as it moved and then picked a row on Enter that
// had never been read out. One helper for both, so they cannot drift again.

/**
 * Put the cursor on row `index` of `list`, or take it off with -1.
 *
 * Rows need ids for `aria-activedescendant` to point at; the callers give
 * each one `${list.id}-${i}` (or their own scheme) when they render.
 */
export function markOption({ input, list, index }) {
  const rows = [...list.children];
  rows.forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
  const row = rows[index];
  if (row?.id) {
    input.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView?.({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

/**
 * Move the cursor one row for an arrow key, wrapping at either end, and say
 * the list is being navigated. Returns the new index, or null for any other
 * key so the caller can go on to handle it.
 */
export function stepOption({ input, list, key, from, count }) {
  const by = { ArrowDown: 1, ArrowUp: -1 }[key];
  if (!by || !count) return null;
  // A keyboard cursor exists from the first arrow press and not before. The
  // highlight is drawn off this class on a phone, where there is no pointer to
  // have moved and a row shaded before anything was pressed reads as a row
  // that is already chosen.
  list.classList.add('is-navigating');
  const index = from < 0 && by < 0 ? count - 1 : (from + by + count) % count;
  markOption({ input, list, index });
  return index;
}
