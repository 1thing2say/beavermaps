// One thing at a time — on a phone, and in the sidebar above it.
//
// THE BUG THIS EXISTS TO FIX. The sheet's children are a column: the search
// head, then a place card, then a category's results, then the route panel,
// then the legend — every one of them appended in DOM order and every one of
// them visible at once. In a 400px sidebar that is right and it is what a
// sidebar is: four things you can see at the same time, because there is room.
//
// Full width on a phone it is a pile. Pick Restrooms off the grid and the sheet
// holds the four shortcuts you were not looking at, then the restroom list, then
// a directions form, with two close buttons on screen and no way to tell which
// of the three the sheet is currently ABOUT. Scrolling past a panel you have
// finished with to reach the one you just opened is not a layout problem, it is
// the app having no idea what you are doing.
//
// WHAT EVERY PHONE MAP DOES INSTEAD is treat the sheet as a navigation stack.
// Apple's shows exactly one card: search results, then the place you tapped in
// place of them, then the route in place of that, and the card's own dismiss
// walks back up. Google's is the same arrangement. The sheet is a view onto one
// context, and the context has a history.
//
// So this keeps the order the panels were opened in and shows the last one. It
// does NOT add a back button: every panel already has a dismiss in its head, and
// with the stack underneath it that dismiss already IS back — close the place
// card and the list you picked it from is there again. A second control that
// did the same thing would be a second control to explain.
//
// THE SIDEBAR GETS IT TOO, which it did not at first. "In a 400px sidebar
// that is right", above, was the reasoning, and the room was real — what it
// bought was the pile this file was written against, one breakpoint up: three
// panels and three dismisses stacked down the left edge of a desktop, with the
// list you were reading squeezed to fit between the other two. See src/shell.js
// for the measurement. The rule is the same at every width now, so the question
// "what does × do" has one answer rather than one per screen size.
//
// It watches rather than being told. Four panels are opened from six places in
// src/main.js — some through `toggleSheet`, some by writing the class directly
// — and threading a push and a pop through all of them is six chances to forget
// one, forever. The panels' own `hidden` class is already the single source of
// truth for whether a panel is up; this reads it.

/**
 * @param {object} parts
 * @param {HTMLElement} parts.el       the sheet
 * @param {{el: HTMLElement, dismiss: () => void}[]} parts.panels
 *        every panel that can appear in it, with the app's own close for each —
 *        named rather than found in the DOM, because closing a category clears
 *        a highlight and closing a place card releases a WebGL canvas, and a
 *        stack that synthesised a click would be guessing at both
 * @param {() => boolean} parts.enabled whether the sheet is a sheet right now
 * @param {(front: HTMLElement | null) => void} [parts.onFront]
 */
export function createSheetStack({ el, panels, enabled, onFront }) {
  /** Panels in the order they were opened, most recent last. */
  let order = [];
  /** What each panel's visibility was at the last read, to spot the edges. */
  const was = new Map(panels.map((panel) => [panel, false]));

  const isOpen = (panel) => !panel.el.classList.contains('hidden');
  const front = () => order[order.length - 1] ?? null;

  /**
   * How far down the column was scrolled under each panel, and under `null`
   * for the front page with nothing open.
   *
   * THE WAY BACK GOES BACK TO WHERE YOU WERE. Scroll down the front page to
   * Browse buildings, open Library, close it: the grid you pressed should be
   * under your thumb, not the search field. And the other way — a card opened
   * from a scrolled page is read from its title, so a panel arriving starts at
   * the top rather than wherever the page it replaced had been left.
   *
   * RECORDED AS IT SCROLLS rather than read when the front changes, because by
   * then it is often already gone: the front page hides itself the moment a
   * panel is un-hidden (a `:has()` rule, see src/input.css), the place card
   * forces a layout straight after it un-hides, and a column that has just
   * lost most of its content clamps its scroll to fit before this ever runs.
   * The browser fires the scroll event for that clamp on the next frame,
   * after the front has changed here, so it is filed under the new panel and
   * cannot overwrite the old one's.
   */
  const scrolledTo = new Map();
  el.addEventListener('scroll', () => scrolledTo.set(front(), el.scrollTop), { passive: true });

  function refresh() {
    const before = front();
    for (const panel of panels) {
      const open = isOpen(panel);
      if (open === was.get(panel)) continue;
      was.set(panel, open);
      // Re-opening a panel that is already in the stack moves it to the top
      // rather than adding it twice: tapping a second building while a place
      // card is up replaces the card, it does not deepen anything.
      order = order.filter((other) => other !== panel);
      if (open) order.push(panel);
    }
    paint();
    const after = front();
    if (after === before) return;
    // A panel that has closed is forgotten, so opening it again starts fresh.
    for (const panel of scrolledTo.keys()) {
      if (panel && !order.includes(panel)) scrolledTo.delete(panel);
    }
    el.scrollTop = scrolledTo.get(after) ?? 0;
    onFront?.(after?.el ?? null);
  }

  function paint() {
    // `enabled` is always true in the app now — see src/shell.js — and is kept
    // as a switch so the arrangement can be turned off whole: everything
    // written here is removed rather than left inert, and with it gone every
    // open panel shows, which is how the column behaved before this existed.
    const on = enabled();
    const top = on ? front() : null;
    for (const panel of panels) {
      if (panel === top) panel.el.dataset.front = '';
      else delete panel.el.dataset.front;
    }
    if (on) el.dataset.depth = String(order.length);
    else delete el.dataset.depth;
  }

  // `class` only, and on the panels themselves rather than the whole subtree:
  // these boxes are full of rows and cards whose classes change constantly, and
  // the one attribute this cares about is on four elements.
  const watch = new MutationObserver(refresh);
  for (const panel of panels) {
    watch.observe(panel.el, { attributes: true, attributeFilter: ['class'] });
  }
  refresh();

  return {
    /**
     * Dismiss whatever is on top, through the app's own close for it.
     *
     * Each panel's own dismiss button is the back button, which is the point
     * of the arrangement; this is for the paths that need to unwind the column
     * without knowing what is in it. Escape is the first — see main.js — and a
     * hardware back gesture would be the next.
     */
    back() {
      front()?.dismiss();
    },
    /** Re-decide after the breakpoint has been crossed. */
    refit: paint,
    get depth() { return order.length; },
  };
}
