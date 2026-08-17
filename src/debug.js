// A back room for the person building this map.
//
// Three kinds of thing live in here, and it is worth being clear about which is
// which, because they justify themselves differently.
//
//   GATHERED CONTROLS — map type, provider, look, legend. Every one of these
//   already exists in the layers menu and is a setting a visitor is meant to
//   have. Nothing is reimplemented: each is registered as a second SURFACE on
//   the control that already owns the state, the same way the rail and the
//   layers menu already share the provider and the skin. Two buttons, one piece
//   of state, both redrawn from it on every change, so neither can drift —
//   because neither holds anything. What this panel buys is the four axes in
//   one place, which matters when the job is sweeping them.
//
//   LIES — the route GUI switch and the virtual location. These have no
//   business in the app proper. They exist so a piece of interface can be
//   looked at without arranging the world that produces it: you should not have
//   to walk onto the campus to see what the blue dot does.
//
//   READOUTS — the buildings directory at the foot of the card. It changes
//   nothing; it is src/directory.json rendered as a list, so a building that
//   fell out of the file is a row that is not there. It held the sidebar until
//   it was moved here, which is why it is a full list with the map's own rows
//   rather than a debug-shaped dump — the markup came with it. Nothing in this
//   module touches it; main.js fills it when the file lands.
//
// ONE RULE, AND IT IS THE WHOLE DESIGN: with the menu closed, the app is
// exactly the app. Every lie is gated on the menu being open, so a flag left
// set cannot outlive it. That is what makes "off by default" safe for the route
// GUI — a visitor who never opens this panel keeps their directions, and
// somebody who turns the panel off gets them back in the same gesture, without
// having to remember which switch they flipped. A debug mode you can get
// stranded inside is a bug with a nice name.

const STORAGE_KEY = 'mapper-debug';

/**
 * The lies, and what each says when it is on — plus `fps`, which is not one.
 *
 * A readout rather than a lie: it changes nothing about what the app does, it
 * only draws what the app is already doing on top of it. It is a flag here
 * because it is a switch and this is where the switches live, but it belongs
 * under its own heading in the markup rather than under "Pretend".
 */
export const DEBUG_FLAGS = ['routing', 'gps', 'fps'];

const CLOSED = {
  open: false,
  ...Object.fromEntries(DEBUG_FLAGS.map((flag) => [flag, false])),
};

/**
 * What was stored, sanitised.
 *
 * Every field is read as a boolean rather than trusted, because this key is
 * hand-editable and a malformed one should open the app, not break it.
 */
function stored() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return { ...CLOSED };
    const state = { open: saved.open === true };
    for (const flag of DEBUG_FLAGS) state[flag] = saved[flag] === true;
    return state;
  } catch {
    return { ...CLOSED };
  }
}

/**
 * Whether the URL is asking for the back room.
 *
 * Both `?debug` and `#debug`, because which one you reach for depends on
 * whether you are editing an address bar or pasting a link, and neither is
 * worth getting wrong. Checked as a substring of the query keys rather than the
 * whole URL so a campus named `debug` in a search parameter could not open it.
 */
function urlAsks() {
  const { search, hash } = window.location;
  return new URLSearchParams(search).has('debug') || hash.replace('#', '') === 'debug';
}

/** True when the keystroke is a chord and not somebody typing the letter D. */
function isChord(event) {
  if (event.key?.toLowerCase() !== 'd' || !event.shiftKey) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  const el = event.target;
  return !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el?.isContentEditable);
}

/**
 * Wire up the debug menu.
 *
 * `panel` is the card, `close` its dismiss button, and `switches` maps each
 * flag name to its checkbox. `onChange` is handed the whole state on every
 * change including the first, so the caller applies one function to one object
 * and never has to work out which field moved.
 *
 * Opened by `?debug`, by `#debug`, or by Ctrl/Cmd+Shift+D — three ways in
 * because the two URL forms cost a line each and the chord is the one you use
 * when the app is already loaded. It is remembered across reloads, which it has
 * to be: half of what this panel is for is checking that a setting survives one.
 */
export function createDebugMenu({ panel, close, switches, onChange }) {
  const state = stored();
  if (urlAsks()) state.open = true;

  function publish({ persist = true } = {}) {
    panel.classList.toggle('hidden', !state.open);
    panel.setAttribute('aria-hidden', String(!state.open));
    for (const [flag, input] of Object.entries(switches)) {
      input.checked = state[flag];
      // The switches only mean anything while the panel is up, and a disabled
      // control that still shows its position is the honest way to say so.
      input.disabled = !state.open;
    }
    if (persist) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // A copy, not the object. The caller reads flags out of this on every
    // change; handing it the live one would let a stray write become state that
    // was never stored.
    onChange({ ...state });
  }

  function setOpen(open) {
    if (state.open === open) return;
    state.open = open;
    publish();
  }

  for (const [flag, input] of Object.entries(switches)) {
    input.addEventListener('change', () => {
      state[flag] = input.checked;
      publish();
    });
  }

  close.addEventListener('click', () => setOpen(false));

  document.addEventListener('keydown', (event) => {
    if (!isChord(event)) return;
    // Claimed, so the browser's own Ctrl+Shift+D — bookmark-all-tabs in
    // Chrome — does not fire underneath it.
    event.preventDefault();
    setOpen(!state.open);
  });

  // Persisted on the way in as well as on every change, so an app opened with
  // `?debug` stays in debug after the parameter is gone from the address bar.
  publish();

  return {
    /** For the console, which is where somebody will look for it. */
    toggle: () => setOpen(!state.open),
    get state() {
      return { ...state };
    },
  };
}
