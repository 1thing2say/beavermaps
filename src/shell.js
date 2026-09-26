// The sheet, the stack it lives in, and the two observers that keep a phone's
// layout honest.
//
// On a narrow screen the four cards are ONE sheet with a drag handle, and three
// things have to stay in step with it: the CSS custom properties that carry
// each card's height, the visual viewport (which on iOS scrolls without
// resizing when a field takes focus), and the camera, which has to re-reveal
// whatever the card is about once the sheet has settled over it.
//
// WHY THE OBSERVERS AND NOT A RESIZE HANDLER. A card's height changes when its
// content changes, not when the window does — a search with three results and
// a search with eight are different heights on the same screen — so the thing
// to watch is the element, not the viewport. There is no feedback loop: the
// property these publish is read by `bottom`, and moving a box does not change
// how tall it is.

import { createSheet } from './sheet.js';
import { createSheetStack } from './sheet-stack.js';

/**
 * Map left showing between the pinned controls and a fully drawn-up sheet, in
 * px. The gap the rest of the chrome keeps between neighbours (--g-gap), so the
 * sheet stops short of locate the way everything else does.
 */
const TOP_CLEARANCE = 10;

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {object} deps.panels    the four cards, by name
 * @param {Function} deps.isPhone
 * @param {Function} deps.onSettle  what to re-reveal once the sheet has landed
 * @param {object} deps.dismiss   how to close each card, by name
 */
export function createShell({ map, panels, isPhone, onSettle, dismiss }) {
  const { placePanel, categoryPanel, sidePanel, legendPanel } = panels;

  /**
   * Publish two measured heights to the stylesheet.
   *
   * CSS cannot measure one element from another, and the phone layout needs
   * exactly that twice over: the credit line and Mapbox's control stack both
   * ride directly above the bottom sheet, and the stack additionally has to
   * know how tall it is itself before it can work out how far it is allowed to
   * rise. Those are the only two numbers in this layout that the stylesheet
   * cannot state, so they are written in from here and everything downstream of
   * them stays in CSS.
   *
   * An observer rather than a call at each open: the sheet changes height for
   * reasons that are not panel changes at all — a flyover arriving is the
   * obvious one — and a credit that only moved when a card opened would be left
   * lying over the card it had already got out of the way of.
   *
   * No feedback loop: `bottom` is what reads these, and moving a box does not
   * change how tall it is.
   */
  const measured = new ResizeObserver((entries) => {
    for (const entry of entries) {
      // THE BORDER BOX, not the content box, and the two are not the same box
      // here. Tailwind's preflight puts `box-sizing: border-box` on everything,
      // so `contentRect` is the element less its padding — and the sheet's
      // padding is where the phone layout keeps the 1px overshoot that covers
      // the seam at the bottom of the screen, plus the home indicator's inset
      // under it. What reads this is `bottom` on Mapbox's control stack, which
      // lifts the stack by exactly this number to sit on top of the sheet: a
      // number short by the padding is a stack sitting that far INSIDE it.
      //
      // One pixel of that was already happening and was invisible. The inset is
      // the part that is not — about 34px on a notched iPhone once
      // `viewport-fit=cover` makes `env()` answer with anything, which it now
      // does. `contentRect` was right when the sheet had no padding to lose.
      //
      // Fallback for the property rather than the box: `borderBoxSize` is
      // everywhere that matters, and an older engine reporting only the older
      // shape should still get a number rather than `undefined` px.
      const box = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      document.documentElement.style.setProperty(
        entry.target.dataset.heightVar, `${Math.round(box)}px`,
      );
    }
  });
  for (const [el, prop] of [
    [document.getElementById('top-left'), '--g-sheet-h'],
    [document.querySelector('.mapboxgl-ctrl-bottom-right'), '--g-ctrl-stack-h'],
  ]) {
    if (!el) continue;
    el.dataset.heightVar = prop;
    measured.observe(el);
  }

  /**
   * And one more the stylesheet cannot see: where the bottom of the screen
   * actually is while a keyboard is up.
   *
   * iOS does not resize the layout viewport for the keyboard — it lays the
   * keyboard OVER the page and leaves every `bottom` in the document pointing
   * at the same place it always did. So a bottom sheet — which on a phone is
   * the search field, its suggestions and whatever card is open, all in one —
   * sits underneath the keyboard the moment you touch the thing you type into.
   * Lifting it off this is what keeps the field and its list above the keys.
   *
   * `window.innerHeight - height - offsetTop` rather than the height alone,
   * because the visual viewport also moves: a pinch-zoomed or scrolled page
   * offsets it, and only the difference between the two is the part that is
   * covered. Clamped at zero so the pull-to-refresh rubber band, which briefly
   * makes that difference negative, cannot push the sheet off the bottom.
   *
   * `scroll` as well as `resize`, because on iOS focusing a field scrolls the
   * visual viewport without resizing it, and the sheet has to follow.
   */
  const viewport = window.visualViewport;
  if (viewport) {
    const publishKeyboard = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      document.documentElement.style.setProperty(
        '--g-kb-h', `${Math.max(0, Math.round(covered))}px`,
      );
    };
    /*
     * ...and tell the map its box may have moved under it.
     *
     * Mapbox sizes its canvas from the container and watches the container, and
     * that is not the same thing as watching the VIEWPORT: on iOS a keyboard
     * can change the layout viewport without the container's own box changing
     * in a way the observer reports on the same frame. A canvas that has not
     * caught up is drawn at the old size and the difference shows as a band of
     * page background under the map — which is exactly the white strip
     * photographed under the sheet with a keyboard up.
     *
     * Only on `resize`. `scroll` fires continuously while the visual viewport
     * moves and a resize per frame would be a re-layout per frame; the box does
     * not change on a scroll anyway.
     */
    const settle = () => { publishKeyboard(); map.resize(); };
    viewport.addEventListener('resize', settle);
    viewport.addEventListener('scroll', publishKeyboard);
    publishKeyboard();
  }

  /**
   * ...and make the sheet answer a finger.
   *
   * Everything above measures the sheet. This lets somebody move it: three
   * detents, a drag off the grabber, a flick, and a tap for the next height.
   * See src/sheet.js, which holds the whole gesture — nothing about it reaches
   * back into this file, because a sheet that has to be told what is inside it
   * is a sheet that has to be told again the next time a panel is added.
   *
   * `enabled` rather than a construct-on-demand, because the breakpoint can be
   * crossed by turning a phone over. Above it the column is a sidebar with no
   * detents, and `refit` is what takes the inline height back off so the
   * stylesheet's own rules are the only ones in play there.
   *
   * Refitted on both viewports. The layout one moves on a rotation, the visual
   * one on a keyboard — and the full detent is measured off the visual
   * viewport, so a sheet held open while the keyboard arrives has to be
   * re-clamped or its top ends up behind the keys.
   */
  const sheet = createSheet({
    el: document.getElementById('top-left'),
    grip: document.getElementById('sheet-grip'),
    enabled: () => isPhone(),
    // A sheet dragged up covers more map, and what it covers first is the
    // middle-bottom of the screen — which is exactly where a reveal has just
    // put the thing the card is about. So the point asks for itself back
    // whenever the sheet changes what there is to see.
    //
    // No zoom on this path: the finger is adjusting the sheet, not choosing
    // anything, and a scale change nobody asked for reads as the map lurching.
    // Collapsing moves nothing either — the visible rectangle only grows, so
    // the point is still inside it and revealPoint leaves the camera alone.
    onSettle,
    // Where the controls pinned to the top of a phone end, so the full detent
    // stops under them rather than over them. Measured, not stated: both are
    // placed by the stylesheet off the safe-area inset, which is 0 in a Safari
    // tab and 47–59px on a notched iPhone once the app is on the home screen,
    // and neither number is something this file should be restating.
    //
    // Only controls in the top half count. The stylesheet pins them up there
    // on a phone, and a control anywhere lower is not one this sheet could
    // reach without covering most of the screen anyway.
    reserve: () => {
      let bottom = 0;
      // The button rather than `.mapboxgl-ctrl-group:has(...)`: this runs on
      // every press, and a selector an older engine cannot parse would throw
      // here and take the drag down with it.
      for (const el of document.querySelectorAll('.g-layers-btn, .mapboxgl-ctrl-geolocate')) {
        const box = el.getBoundingClientRect();
        if (box.height && box.top < window.innerHeight / 2) bottom = Math.max(bottom, box.bottom);
      }
      return bottom ? bottom + TOP_CLEARANCE : 0;
    },
  });
  sheet.refit();

  /**
   * ...and make it show one thing at a time, at every width.
   *
   * The column's children are a list of panels, and all of them up at once is
   * a pile with three close buttons in it and no way to tell which one the
   * column is about. See src/sheet-stack.js — it keeps the order they were
   * opened in and shows the last, so each panel's own dismiss is also the way
   * back to the one underneath it.
   *
   * THIS WAS PHONE-ONLY, on the reasoning that a sidebar has room for
   * everything. It does, and that was the problem: the same three presses —
   * Food & drink, a vending machine, Directions — left a phone showing the
   * route with × going back to the list, and a desktop showing the list
   * squeezed into 290px over a route panel over the legend, with × on each.
   * Two apps. Apple's sidebar and Google's are both one panel with a way back,
   * because that is what makes "where am I in this" answerable, and it is
   * the same answer on both of them whatever the width.
   *
   * The closes are named here rather than found in the DOM because they are not
   * interchangeable: clearing a category repaints a highlight and closes an
   * animation, and closing a place card releases the flyover's WebGL canvas. A
   * stack that synthesised a click on whatever button it found in the head
   * would be guessing at both.
   */
  const sheetStack = createSheetStack({
    el: document.getElementById('top-left'),
    enabled: () => true,
    panels: [
      { el: placePanel, dismiss: dismiss.place },
      { el: categoryPanel, dismiss: dismiss.category },
      { el: sidePanel, dismiss: dismiss.route },
      { el: legendPanel, dismiss: dismiss.legend },
    ],
    // A panel that arrives while the sheet is collapsed is a panel nobody can
    // read. A floor rather than a set, so one opening over a sheet already
    // pulled to full does not knock it back down.
    // SETTLE AT THE READING HEIGHT, from either side.
    //
    // This was `atLeast` alone, which is only half an instruction: it raised a
    // resting sheet so the panel could be read and did nothing at all to one
    // that was already at `full`. `full` is the viewport less a strip of map,
    // so opening a list from the fully drawn-up front page left about 110px of
    // canvas — and the camera, told to frame five buildings inside it, flew out
    // to z11 and showed the interstate. Both grids on the front page did it,
    // and it looked like the map had lost the campus.
    onFront: (panel) => {
      if (!panel) return;
      sheet.atLeast('half');
      sheet.atMost('half');
    },
  });

  const refitSheet = () => { sheet.refit(); sheetStack.refit(); };
  return { sheet, stack: sheetStack, refit: refitSheet, viewport };
}
