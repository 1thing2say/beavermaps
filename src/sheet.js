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
// at. See test/sheet.test.js. `claims` is the other half of the same idea — who
// the gesture belongs to — and is tested the same way.
//
// AND THE THING THAT MAKES ANY OF IT REACH A FINGER. Pointer events are how the
// drag is driven, and on a touch screen they are not enough on their own: the
// sheet is a scroller, a scroller claims a vertical drag at the compositor, and
// the moment it does the browser sends `pointercancel` and stops sending
// moves. Measured on an emulated phone before `onTouchMove` below existed, on
// every drag that did not start on the grabber:
//
//   pointerdown → pointermove → pointercancel          (and nothing after)
//
// One move, which is under START, so `onMove` had not yet decided anything —
// every rule it holds about who owns the gesture was unreachable, and the sheet
// answered a finger nowhere except the 26px grabber, which is the one strip
// with `touch-action: none` on it. Dragging a full sheet down over its own list
// to close it, which is the gesture this file is mostly for, did nothing at
// all.
//
// So the ownership question is now ANSWERED TO THE BROWSER as well as to us,
// on the first touchmove of the sequence, while a preventDefault can still stop
// the scroll from starting. `claims` is that answer and `onMove` reads the same
// function, so the two cannot drift apart. What is deliberately NOT done here
// is `touch-action: none` on the sheet itself: that would take the gesture back
// from the scroller in both directions and leave this file owing the list a
// scroll implementation, momentum and all, which is a worse sheet than a
// browser's own.

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
  //
  // WHICH STOP THE DRAG BEGAN AT, rather than the raw number it began at, and
  // that distinction is the whole of the rescue rather than a tidy-up. `from`
  // is read straight off getBoundingClientRect() and comes back fractional —
  // 523.28 on a 390x844 phone — while the detents arrive rounded, because that
  // is what `measure` hands out. So `target === from` compared 523 against
  // 523.28 and was false, the branch was never entered at all, and on the one
  // occasion it was, `indexOf(523.28)` answered -1 and a step of +1 made that
  // index 0: the LOWEST stop, rather than the next one up.
  //
  // Both spellings of the same mistake, and the same symptom out of either —
  // drag the sheet open, throw it, watch it settle back shut.
  const origin = nearest(from);
  if (Math.abs(velocity) >= FLICK && target === origin) {
    const next = stops.indexOf(origin) + (velocity > 0 ? 1 : -1);
    if (next >= 0 && next < stops.length) target = stops[next];
  }
  return target;
}

/**
 * WHO OWNS THIS GESTURE, and the answer is the scroller unless the scroller has
 * nothing to do with it.
 *
 * Dragging down inside a list that is scrolled is scrolling; dragging down at
 * the top of that list is collapsing the sheet. Dragging up while there is
 * still list below is scrolling; dragging up with the list already at its end —
 * which includes the ordinary case of a sheet holding less than a screenful —
 * is the sheet growing.
 *
 * THE SCROLLER WINS THE TIE, deliberately, and this is where a bottom sheet is
 * usually got wrong in the other direction. Apple's takes an upward drag as
 * "expand first, scroll once expanded", which is lovely and requires the
 * content to be unscrollable below the full detent. Ours caps at 62dvh and has
 * a place card that can be twice that, so making the content unscrollable until
 * the sheet was full would mean a card you have to drag the sheet open before
 * you can read. The grabber is what guarantees the gesture instead: it is never
 * a scroller and always the sheet, whatever is underneath it.
 *
 * SIDEWAYS IS NEVER THE SHEET'S, and that is not a detail — the shortcut shelf
 * across the sheet's head is a horizontal scroller, and a flick along it has to
 * reach the browser or the chips stop moving. Compared rather than thresholded
 * because this is asked on the FIRST move of a gesture, where both numbers are
 * a pixel or two and only their ratio means anything yet.
 *
 * @param {object} gesture
 * @param {boolean} gesture.fromGrip did the press land on the grabber
 * @param {number} gesture.scrolled  the scroller's position when it started
 * @param {number} gesture.room      how far the scroller can travel in total
 * @param {number} gesture.dx        how far the finger has gone sideways
 * @param {number} gesture.dy        ...and down; negative is up
 * @returns {boolean} true when the sheet should take it
 */
export function claims({ fromGrip, scrolled, room, dx, dy }) {
  if (Math.abs(dx) > Math.abs(dy)) return false;
  if (fromGrip) return true;
  if (dy > 0 && scrolled > 0) return false;
  if (dy < 0 && scrolled < room - 1) return false;
  return true;
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
    // ONE FINGER OWNS THE SHEET AT A TIME, and the one that got here first
    // keeps it. Without this a second finger landing anywhere on the sheet
    // overwrote `drag` wholesale, and since every handler below is keyed on
    // `drag.id`, the moves still arriving from the finger actually doing the
    // dragging were then dropped as somebody else's. Measured: the sheet froze
    // mid-gesture at 287px, the release never reached `snapTo`, and what was
    // left was an inline height matching no detent under a `data-detent` that
    // still named the old one — which is the arbitrary height the detents at
    // the top of this file exist to prevent, arrived at from the other side.
    //
    // Bracing a phone with a second thumb is enough to do it, so this is not an
    // edge case; it is how the thing is held.
    //
    // `isPrimary` rather than `if (drag) return`, which is the obvious spelling
    // and gives up something worth keeping: a drag whose release never arrived
    // — a capture that could not be taken, a finger lifted off the edge of the
    // screen — would then block every gesture after it, for good. The first
    // finger of a sequence is the primary one, so a stale drag is still
    // replaced by the next real press while the extra fingers of a live one are
    // turned away. Compared against `false` because only a browser that has
    // actually answered the question gets to refuse anything; a synthetic event
    // with no such property is a press like any other.
    if (event.isPrimary === false) return;
    const heights = measure();
    drag = {
      id: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      h0: el.getBoundingClientRect().height,
      heights,
      // A press on the grabber is always a sheet gesture. A press anywhere else
      // is a sheet gesture only when the scroller underneath it has nothing to
      // do with it — see `claims`.
      fromGrip: grip.contains(event.target),
      scrolled: el.scrollTop,
      room: el.scrollHeight - el.clientHeight,
      last: event.clientY,
      at: event.timeStamp,
      velocity: 0,
      active: false,
      // What `onTouchMove` decided, so it is decided once per gesture: null
      // until the finger has moved at all, then true while the sheet is holding
      // the browser off and false once the scroller has been given it.
      owner: null,
    };
  }

  /**
   * Tell the BROWSER who owns the gesture, while telling it still means
   * something.
   *
   * Non-passive, and the `preventDefault` is the whole point: a scroller claims
   * a vertical drag at the compositor on the first move, and after that no
   * amount of handling stops it — the page gets `pointercancel` and the drag is
   * over before `onMove` has seen enough travel to have an opinion. So the
   * question is asked here, one move earlier, off the state captured at
   * pointerdown. Pointer events fire ahead of touch events for the same finger
   * (`pointerdown`, `touchstart`, `pointermove`, `touchmove`), so `drag` is
   * already populated by the time this runs.
   *
   * Under the threshold on purpose. START is about when the sheet starts
   * MOVING, which is a question about intent; this is about who the browser
   * should let move it, which has to be settled before the first frame of
   * scrolling or not at all.
   *
   * Two fingers are nobody's: that is a pinch, and the page is still
   * zoomable.
   */
  function onTouchMove(event) {
    if (!drag || event.touches.length !== 1) return;
    if (drag.owner === false) return;
    if (drag.owner === true) { event.preventDefault(); return; }

    const touch = event.touches[0];
    const dx = touch.clientX - drag.x0;
    const dy = touch.clientY - drag.y0;
    // A move that has not moved says nothing about direction yet; wait for one
    // that has rather than guessing and being stuck with it.
    if (dx === 0 && dy === 0) return;

    drag.owner = claims({ ...drag, dx, dy });
    if (drag.owner) event.preventDefault();
  }

  function onMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x0;
    const dy = event.clientY - drag.y0;

    if (!drag.active) {
      if (Math.abs(dy) < START) return;
      // See `claims` for the rules, and `onTouchMove` for why a finger has
      // already been asked this one move earlier. Read through `drag.owner`
      // when there is one so a gesture cannot be answered two different ways
      // over its own length: the browser was told something on the first move
      // and has been acting on it ever since.
      if (!(drag.owner ?? claims({ ...drag, dx, dy }))) { drag = null; return; }
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
    // WHERE THE FINGER LET GO, READ BEFORE THE CLASS COMES OFF.
    //
    // `is-dragging` carries `max-height: none` — see the note beside it for the
    // cap it is lifting and why a drag has to be out from under it — so taking
    // the class away puts a 62dvh ceiling back on the element in this same
    // frame. Measure after that and a sheet dragged to 703px answers 523.27,
    // which is not where the finger is, and `snapTo` is then asked which detent
    // a sheet that never moved belongs at. It says the one it started from, and
    // the gesture reads as the sheet refusing to open.
    //
    // Two lines in the wrong order, and nothing about it was visible while the
    // cap applied during the drag as well: the box answered 523 either way,
    // wrongly but consistently.
    const released = el.getBoundingClientRect().height;
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
      height: released,
      velocity: done.velocity,
      detents: stops(done.heights),
      from: done.h0,
    });
    apply(nameOf(done.heights, height), done.heights);
  }

  function onCancel(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const heights = drag.heights;
    const moved = drag.active;
    drag = null;
    el.classList.remove('is-dragging');
    // A cancel on a gesture that never moved the sheet is the SCROLLER being
    // handed the drag, which is the ordinary way a touch gesture ends here now
    // — `onTouchMove` declined it and the browser took it. Nothing moved, so
    // there is nothing to put back, and writing the detent's height here would
    // be a layout in the middle of somebody else's scroll.
    //
    // A cancel mid-drag is the other thing entirely: the system took the
    // gesture away (an edge swipe, a call arriving) and the sheet is sitting at
    // whatever height the last move left it at. That one does have to be put
    // back on a detent.
    if (moved) apply(detent, heights);
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  // `passive: false` spelled out, because a listener that cannot preventDefault
  // is exactly the listener this must not be — and the default for touchmove is
  // only passive on the document and the body, which is close enough to bite.
  el.addEventListener('touchmove', onTouchMove, { passive: false });

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
