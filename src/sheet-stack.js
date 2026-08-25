// One thing at a time, on a phone.
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
    if (front() !== before) onFront?.(front()?.el ?? null);
  }

  function paint() {
    // Above the breakpoint this is a sidebar and the whole idea is off: every
    // open panel shows, which is what a sidebar is for. Everything written here
    // is removed rather than left inert, so the stylesheet's own rules are the
    // only ones in play there.
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
     * Not used by a control yet — each panel's own dismiss button is the back
     * button, which is the point of the arrangement. It is here for the paths
     * that need to unwind the sheet without knowing what is in it: a hardware
     * back gesture, or a swipe-down on a sheet that is already collapsed.
     */
    back() {
      front()?.dismiss();
    },
    /** Re-decide after the breakpoint has been crossed. */
    refit: paint,
    get depth() { return order.length; },
  };
}
