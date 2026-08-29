// The bottom sheet, as a thing you can drag.
//
// Up to now the sheet on a phone was a shape rather than a control: it was the
// height of whatever was in it, it grew when a card opened, and the grabber
// drawn across its top was a signifier for a gesture that did not exist. That
// is the one part of a phone map everybody already knows how to use, and ours
// did not answer a finger.
//
// So this adds the gesture, and it adds the thing that makes the gesture worth
// having — DETENTS. A sheet that follows a finger anywhere is worse than one
// that does not move: every release leaves it at an arbitrary height, and the
// next person to look at the screen has to work out what state it is in. Three
// heights is what Apple's sheet has and what iOS gives you as
// `.medium`/`.large`, and the middle one is the whole point: it is the height
// where you can read a list and still see where you are on the map.
//
//   rest  what is in it. NOT a fixed collapsed height — the sheet is still
//         content-sized at rest, exactly as it was before this file existed,
//         so every measurement the layout was tuned against still holds and a
//         card that opens still grows the sheet on its own.
//   half  half the visible viewport, which is the reading height.
//   full  the viewport less a strip of map, so you never lose your place.
//
// `rest` being content-sized is also why the three are computed on every press
// rather than held: it moves when a card opens, when the chips appear under a
// focused field, and when the keyboard changes how much screen there is. A
// detent table cached at startup would be wrong by the second gesture.
//
// The pure half of this file is `snapTo`, which is where the feel lives and is
// the only part worth testing without a browser: given where the finger let go
// and how fast it was moving, which of the three heights does the sheet belong
// at. See test/sheet.test.js.

/** How far a press has to travel before it is a drag rather than a tap. */
const START = 8;

/**
 * How far a release is carried by its own speed, in milliseconds.
 *
 * A sheet released mid-flight should land where the finger was GOING, not where
 * it happened to stop. 120ms is short enough that a slow drag lands where you
 * put it and long enough that a deliberate throw clears the detent behind it.
 */
const PROJECT_MS = 120;

/**
 * The speed at which a gesture stops being a drag and becomes a flick, in
 * px/ms — about 450 px/s.
 *
 * Below this, a release lands at whichever detent it is nearest. Above it, the
 * gesture commits to the next detent in the direction of travel even if the
 * finger barely moved, because a short fast flick is how people ask for the
 * next state without dragging all the way to it.
 */
const FLICK = 0.45;

/** Two detents closer together than this are one detent. */
const DISTINCT = 24;

/**
 * How much map is never covered, in px.
 *
 * The full detent stops short of the top of the screen rather than reaching it.
 * Partly because the layers button lives up there and a sheet over it would be
 * a control you cannot reach; mostly because a map app whose map is entirely
 * gone has stopped being a map app, and the strip of ground above the sheet is
 * what tells you the thing behind it is still there.
 */
const MAP_STRIP = 96;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Where a released sheet belongs.
 *
 * @param {object} release
 * @param {number} release.height   where the finger let go
 * @param {number} release.velocity px/ms, positive while the sheet is growing
 * @param {number[]} release.detents the heights it may rest at
 * @param {number} release.from     the height the drag started from
 * @returns {number} the height to settle at
 */
export function snapTo({ height, velocity, detents, from }) {
  const stops = [...new Set(detents)].sort((a, b) => a - b);
  const nearest = (h) => stops.reduce(
    (best, stop) => (Math.abs(stop - h) < Math.abs(best - h) ? stop : best),
    stops[0],
  );

  // Where it is going, not where it stopped.
  let target = nearest(height + velocity * PROJECT_MS);

  // A flick always gets you somewhere. Without this, a fast short throw from
  // the middle of a long gap projects only 54px and lands back where it
  // started, which reads as the sheet refusing the gesture.
  if (Math.abs(velocity) >= FLICK && target === from) {
    const next = stops.indexOf(from) + (velocity > 0 ? 1 : -1);
    if (next >= 0 && next < stops.length) target = stops[next];
  }
  return target;
}

/**
 * Make a bottom sheet drivable.
 *
 * @param {object} parts
 * @param {HTMLElement} parts.el    the sheet
 * @param {HTMLElement} parts.grip  the always-draggable strip across its top
 * @param {() => boolean} parts.enabled whether the sheet is a sheet right now
 *                                  (it is a sidebar above the phone breakpoint)
 */
export function createSheet({ el, grip, enabled, onSettle }) {
  /** The name of the detent the sheet is resting at. */
  let detent = 'rest';
  /** The live drag, or null. */
  let drag = null;
  /**
   * The height the sheet is HEADING FOR, or null while it is content-sized.
   *
   * Not the height it has. `apply` writes the inline height and the stylesheet
   * animates towards it over 240ms, so for a quarter of a second after a card
   * opens `getBoundingClientRect()` answers a question nobody asked — where the
   * sheet is passing through. Anything deciding what the sheet is covering
   * needs where it is going: a camera that framed the map around the in-flight
   * height would settle a quarter of a sheet too low. See `top`.
   */
  let settling = null;

  /**
   * The three heights, measured now.
   *
   * `rest` is read off the DOM rather than computed, which is what keeps this
   * file out of the layout's business: whatever the stylesheet and the content
   * between them decide the sheet's natural height is, that is the resting
   * detent — the 62dvh cap included, since a capped sheet is still what the
   * sheet does when nobody is dragging it. Measured with the inline height
   * cleared, so a sheet currently held open at `full` still reports what it
   * would collapse to.
   */
  function measure() {
    const held = el.style.height;
    const at = el.dataset.detent;
    // BOTH of them, and the attribute is the one that is easy to forget. The
    // stylesheet shows things at the open detents that it hides at rest — the
    // shortcut list is the first — so measuring the resting height while the
    // attribute still says `full` measures a sheet with the expanded content
    // in it, and the sheet acquires a resting height that grows every time it
    // is opened.
    if (held) el.style.height = '';
    el.dataset.detent = 'rest';
    const rest = Math.round(el.getBoundingClientRect().height);
    // ...and again in the state whose size is actually in question. The sheet
    // shows MORE at the open detents than at rest — a category grid, a section
    // heading, the shelf — so what `full` has to fit is not the resting content
    // measured a line above. Same reason as the attribute swap: the stylesheet
    // decides what is in there, and it decides differently per detent.
    el.dataset.detent = 'full';
    const content = el.scrollHeight;
    if (at) el.dataset.detent = at; else delete el.dataset.detent;
    el.style.height = held;

    // The VISUAL viewport, so a keyboard shortens the sheet instead of putting
    // its top half behind the keys. The sheet's own `bottom` is already lifted
    // by --g-kb-h; this is the other end of the same measurement.
    const screen = Math.round(window.visualViewport?.height ?? window.innerHeight);
    // NEVER TALLER THAN WHAT IS IN IT. The ceiling is the screen less a strip
    // of map; the sheet only reaches it when there is enough to fill it. Open a
    // sheet holding six rows to 88% of a phone and the bottom third is a field
    // of blank material, which reads as content that failed to load rather than
    // as a sheet that is open.
    const full = clamp(content, rest, screen - MAP_STRIP);
    const half = clamp(Math.round(screen * 0.5), rest, full);
    return { rest, half, full };
  }

  /** The heights above, as a sorted list with the duplicates collapsed. */
  function stops(heights) {
    return Object.values(heights)
      .sort((a, b) => a - b)
      .filter((h, i, all) => i === 0 || h - all[i - 1] >= DISTINCT);
  }

  /** Which name a height belongs to, for the attribute the stylesheet reads. */
  function nameOf(heights, height) {
    return Object.keys(heights).reduce(
      (best, key) => (Math.abs(heights[key] - height) < Math.abs(heights[best] - height)
        ? key : best),
      'rest',
    );
  }

  /**
   * Put the sheet at a detent.
   *
   * At `rest` the inline height is REMOVED rather than set to the measured
   * number. The difference matters: cleared, the sheet is content-sized again
   * and follows whatever opens inside it, which is the behaviour that existed
   * before this file and the one a collapsed sheet should have. Pinned to a
   * number, a card opening underneath would be clipped by a height measured
   * before it arrived.
   */
  function apply(name, heights = measure()) {
    const was = detent;
    detent = name;
    el.dataset.detent = name;
    el.style.height = name === 'rest' ? '' : `${heights[name]}px`;
    // At rest there is nothing to head for: the height is cleared, the sheet is
    // content-sized again, and a cleared height does not animate — `auto` is
    // not an interpolable length, so the box is already its resting size on
    // this frame and measuring it directly is right.
    settling = name === 'rest' ? null : heights[name];
    grip.setAttribute('aria-expanded', String(name !== 'rest'));
    // Only on a real change, so a refit for a rotation that lands on the same
    // detent does not read as the sheet having moved.
    if (name !== was) onSettle?.(name);
  }

  /** The next detent up, wrapping back to rest at the top. See the grabber. */
  function cycle() {
    const heights = measure();
    const order = ['rest', 'half', 'full'].filter(
      (name, i, all) => i === 0 || heights[name] - heights[all[i - 1]] >= DISTINCT,
    );
    const next = order[(order.indexOf(detent) + 1) % order.length] ?? 'rest';
    apply(next, heights);
  }

  function onDown(event) {
    if (!enabled()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const heights = measure();
    drag = {
      id: event.pointerId,
      y0: event.clientY,
      h0: el.getBoundingClientRect().height,
      heights,
      // A press on the grabber is always a sheet gesture. A press anywhere else
      // is a sheet gesture only when the scroller underneath it has nothing to
      // do with it — see onMove.
      fromGrip: grip.contains(event.target),
      scrolled: el.scrollTop,
      room: el.scrollHeight - el.clientHeight,
      last: event.clientY,
      at: event.timeStamp,
      velocity: 0,
      active: false,
    };
  }

  function onMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const dy = event.clientY - drag.y0;

    if (!drag.active) {
      if (Math.abs(dy) < START) return;
      // WHO OWNS THIS GESTURE, and the answer is the scroller unless the
      // scroller has nothing to do with it. Dragging down inside a list that is
      // scrolled is scrolling; dragging down at the top of that list is
      // collapsing the sheet. Dragging up while there is still list below is
      // scrolling; dragging up with the list already at its end — which
      // includes the ordinary case of a sheet holding less than a screenful —
      // is the sheet growing.
      //
      // THE SCROLLER WINS THE TIE, deliberately, and this is where a bottom
      // sheet is usually got wrong in the other direction. Apple's takes an
      // upward drag as "expand first, scroll once expanded", which is lovely
      // and requires the content to be unscrollable below the full detent. Ours
      // caps at 62dvh and has a place card that can be twice that, so making
      // the content unscrollable until the sheet was full would mean a card you
      // have to drag the sheet open before you can read. The grabber is what
      // guarantees the gesture instead: it is never a scroller and always the
      // sheet, whatever is underneath it.
      if (!drag.fromGrip) {
        if (dy > 0 && drag.scrolled > 0) { drag = null; return; }
        if (dy < 0 && drag.scrolled < drag.room - 1) { drag = null; return; }
      }
      drag.active = true;
      el.classList.add('is-dragging');
      // Capture so the sheet keeps the gesture when the finger leaves it, which
      // it does on every drag that reaches the top of the screen. Guarded
      // because it throws NotFoundError for a pointer the browser does not
      // consider active — a synthetic event in a test harness, or a pointer
      // already cancelled — and losing the capture is worth strictly less than
      // losing the drag.
      try { el.setPointerCapture(drag.id); } catch { /* uncaptured is still a drag */ }
    }

    // Speed over the last move rather than over the whole gesture: what decides
    // where a sheet lands is how fast it was going when it was let go, not the
    // average of a drag that may have stopped and started twice.
    const dt = Math.max(1, event.timeStamp - drag.at);
    drag.velocity = (drag.last - event.clientY) / dt;
    drag.last = event.clientY;
    drag.at = event.timeStamp;

    const { rest, full } = drag.heights;
    el.style.height = `${Math.round(clamp(drag.h0 - dy, Math.min(rest, full), full))}px`;
  }

  function onUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const done = drag;
    drag = null;
    el.classList.remove('is-dragging');

    // A press that never became a drag. On the grabber that is a tap, and a tap
    // on a grabber is how you get the next detent without dragging to it —
    // which is the whole reason the grabber is a button. Anywhere else it is
    // somebody pressing what they pressed, and this stays out of the way.
    if (!done.active) {
      if (done.fromGrip) cycle();
      return;
    }

    const height = snapTo({
      height: el.getBoundingClientRect().height,
      velocity: done.velocity,
      detents: stops(done.heights),
      from: done.h0,
    });
    apply(nameOf(done.heights, height), done.heights);
  }

  function onCancel(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const heights = drag.heights;
    drag = null;
    el.classList.remove('is-dragging');
    apply(detent, heights);
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);

  // The grabber is a button, so it already answers Enter and Space by firing a
  // click — which is the same "next detent" the tap gives. The arrows are the
  // part a click cannot express: a sheet has a direction, and somebody driving
  // this from a keyboard should be able to say which way rather than cycling
  // through the top to get back down.
  grip.addEventListener('click', (event) => {
    // The pointer path already handled it; a click after a tap would cycle
    // twice. Only a click with no pointer behind it — keyboard, assistive
    // technology — gets here on its own.
    if (event.detail !== 0) return;
    cycle();
  });
  grip.addEventListener('keydown', (event) => {
    const step = { ArrowUp: 1, ArrowDown: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const heights = measure();
    const order = ['rest', 'half', 'full'].filter(
      (name, i, all) => i === 0 || heights[name] - heights[all[i - 1]] >= DISTINCT,
    );
    const next = order[clamp(order.indexOf(detent) + step, 0, order.length - 1)];
    apply(next, heights);
  });

  /**
   * Re-fit the sheet to a viewport that has changed under it.
   *
   * A rotation, a keyboard arriving, a browser chrome bar collapsing: all of
   * them move `full` and `half`, and a sheet still holding yesterday's number
   * is either floating short of the top or reaching past the bottom.
   */
  function refit() {
    if (!enabled()) {
      // Above the breakpoint this is a sidebar, and a sidebar has no detents.
      // Everything this file writes is removed rather than left inert, so the
      // stylesheet's own rules are the only ones in play there.
      el.style.height = '';
      delete el.dataset.detent;
      settling = null;
      return;
    }
    apply(detent);
  }

  /**
   * Open the sheet at least this far, and never close it further.
   *
   * What a panel arriving asks for. A card that opens while the sheet is
   * collapsed has to be reachable, and a card that opens while the sheet is
   * already full must not knock it back down to half — so this is a floor
   * rather than a set. Measured, not compared by name: `rest` is content-sized
   * and can be TALLER than `half` when the thing that just opened is a long
   * place card, and in that case the right answer is to leave it alone.
   */
  function atLeast(name) {
    if (!enabled()) return;
    const heights = measure();
    if (heights[detent] >= heights[name]) return;
    apply(name, heights);
  }

  /**
   * ...and the other way, which the sheet had no way of being asked.
   *
   * A panel opening asks for `atLeast('half')` so its contents are readable.
   * From `full` that was a no-op, and `full` is the viewport less a strip of
   * map — so a list opened from a fully-drawn-up sheet had 110px of canvas
   * above it, and the camera dutifully fitted five buildings into 110px. The
   * result was a regional view of Sacramento with the answer sitting on top of
   * it. The two calls together mean "settle at the reading height", from
   * whichever side the sheet happens to be on.
   *
   * Guarded the same way `atLeast` is, and for the same reason: at `rest` the
   * sheet is content-sized, so a rest that is already taller than `half` — a
   * long card on a short screen — must not be shrunk into its own contents.
   */
  function atMost(name) {
    if (!enabled()) return;
    const heights = measure();
    if (heights[detent] <= heights[name]) return;
    apply(name, heights);
  }

  /**
   * Where the sheet's top edge is settling, in viewport pixels, or null when
   * this column is a sidebar rather than a sheet.
   *
   * The bottom edge is measured and the top is derived from it, rather than the
   * other way round, because the bottom edge is the one that does not move: the
   * sheet is anchored there — offset by the safe area and by the keyboard — and
   * grows upward. So this answers correctly in the middle of the 240ms the
   * height is animating, which is exactly when it is asked.
   */
  function top() {
    if (!enabled()) return null;
    const box = el.getBoundingClientRect();
    return settling === null ? box.top : box.bottom - settling;
  }

  return {
    refit,
    atLeast,
    atMost,
    apply: (name) => apply(name),
    get detent() { return detent; },
    get top() { return top(); },
  };
}
