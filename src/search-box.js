// The destination field, its results list, the shelf of shortcuts under it, and
// the two endpoint fields in the route panel.
//
// Over places.json, which is the college's own directory rather than anything
// derived — 120 rows, names and descriptions as they publish them. Their
// descriptions enumerate what is inside each building ("This building consists
// of Board Room, Cafeteria…"), so searching "cafeteria" has to find Student
// Center; that is why descriptions are in the haystack and not just the names.
//
// Every row is bound to routing nodes, so a chosen destination is already a
// graph vertex and needs no snapping.
//
// WHAT IT RANKS is src/search-rank.js, which is pure and tested. What is here
// is the DOM half: the list, the keyboard cursor, the shelf, and the rule that
// the two route-panel fields behave the same way as the main one without being
// a second copy of it.

import roomsData from './rooms.json';
import { buildRoomIndex, lookupRoom } from './rooms.js';
import { popularity, recordVisit } from './popular.js';
import {
  MAX_RESULTS, normalise, buildPlaceIndex, search, popularEntries,
} from './search-rank.js';
import { point } from '@turf/helpers';
import { distance } from '@turf/distance';

/**
 * @param {object} deps
 * @param {Function} deps.places      the places overlay, once it has landed
 * @param {Function} deps.directory   the building directory overlay
 * @param {Function} deps.afterExit   run something once a list has animated out
 * @param {Function} deps.setDestination
 * @param {Function} deps.directoryRow
 * @param {Function} deps.buildingSub
 * @param {Function} deps.measureFrom  where distances are measured from
 * @param {Function} deps.setStatus
 */
export function createSearchBox({
  places,
  directory,
  afterExit,
  setDestination,
  directoryRow,
  buildingSub,
  measureFrom,
  setStatus,
}) {
  // -------------------------------------------------------------------------

  const searchInput = document.getElementById('place-search');
  const searchResults = document.getElementById('place-results');
  const searchClear = document.getElementById('place-clear');
  const placeShortcuts = document.getElementById('place-shortcuts');

  // Built once from the committed artifact, which is static — unlike the place
  // index below, which waits on a fetch.
  const roomIndex = buildRoomIndex(roomsData);

  /**
   * How much each place is worth being offered first. See src/popular.js.
   *
   * Held rather than computed per query, because it reads localStorage and
   * walks the directory and neither of those changes between the letters of one
   * word. Rebuilt on exactly the two events that can move it: the directory
   * landing, and somebody choosing somewhere.
   */
  let popularBonus = popularity();
  function refreshPopularity() {
    popularBonus = popularity({ directory: directory() });
    renderShortcuts();
  }

  /**
   * The row of places the sheet offers when it is offering nothing else.
   *
   * FULL NAMES AT THEIR OWN WIDTH, and the row scrolls.
   *
   * The first draft of this fixed three chips across the phone, on the
   * reasoning that a shortcut nobody can see is not a shortcut. Then I measured
   * the names it would be holding: the three this campus actually ranks first
   * are "Welcome and Support Center", "Student Center" and "Evangelisti
   * Culinary Arts Center", and three of those in 390px is 114px each. Every
   * chip would have read "Welcome and Su…". A row of truncated building names
   * is not a faster way to pick a building, it is a quiz.
   *
   * So they take the width they need and the row scrolls sideways, which costs
   * the second and third chip some visibility and costs the first one nothing.
   * Four rather than three, since the ones past the edge are now free.
   *
   * The same ranking the suggestion list opens with, which is deliberate: a
   * person who taps the field expects to see what was already on the shelf, and
   * two orderings of the same places would be two things to keep in step. And
   * the same handler on a press, so a shortcut and its row cannot disagree
   * about what picking it means.
   *
   * Re-rendered from refreshPopularity, so walking somewhere reorders the shelf
   * for next time without anything else having to know that it should.
   */
  function renderShortcuts() {
    if (!placeShortcuts) return;
    const hits = popularHits().slice(0, 4);
    placeShortcuts.replaceChildren(...hits.map((entry) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'g-shortcut';
      chip.textContent = entry.name;
      // The full name for anyone who cannot see how far the label was cut.
      chip.title = entry.name;
      chip.setAttribute('aria-label', `Go to ${entry.name}`);
      chip.addEventListener('click', () => chooseDestination(entry));
      return chip;
    }));
    // Never on screen at the same time as the list that holds the same places.
    // This can run while the list is open — walking somewhere reorders the
    // shelf — and unhiding it there would put the same three names on screen
    // twice.
    placeShortcuts.classList.toggle(
      'hidden', !hits.length || !searchResults.classList.contains('hidden'),
    );
  }
  let searchIndex = [];
  let searchHits = [];
  let activeHit = -1;

  function buildSearchIndex() {
    searchIndex = buildPlaceIndex(places().features);
    // The field is disabled in the markup and opened here, so nobody types into
    // a box that has nothing to search yet.
    searchInput.disabled = false;
  }

  function runSearch(query) {
    return search({
      index: searchIndex,
      query,
      rooms: lookupRoom(query, roomIndex).slice(0, MAX_RESULTS - 2),
      bonus: popularBonus,
    });
  }

  /**
   * The list an empty field shows: where you have been, then where there is
   * most to do. See `popularNames`.
   *
   * An empty field is exactly the state somebody is in when they have not
   * decided what to type yet, and on a phone it is now the state the app BOOTS
   * in — the field holds the bottom of the screen under a thumb. Answering it
   * with nothing is a keyboard and a blank rectangle.
   *
   * Filtered against the index rather than trusted: these names come from
   * my campus's building directory and the index is built from its places file, and
   * a building the two spell differently is a row that would go nowhere.
   */
  function popularHits() {
    return popularEntries({
      index: searchIndex,
      directory: directory(),
      limit: MAX_RESULTS - 2,
    });
  }

  function closeResults() {
    searchResults.classList.add('hidden');
    afterExit(searchResults, () => searchResults.replaceChildren());
    // ...and the shelf comes back, unless there is nothing on it.
    if (placeShortcuts?.childElementCount) placeShortcuts.classList.remove('hidden');
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
    searchHits = [];
    activeHit = -1;
  }

  function highlight(index) {
    activeHit = index;
    [...searchResults.children].forEach((li, i) => {
      // `aria-selected` alone: the stylesheet draws the highlight off it, so
      // the accessible state and the visible one cannot disagree.
      li.setAttribute('aria-selected', String(i === index));
    });
    if (index >= 0) {
      searchInput.setAttribute('aria-activedescendant', `place-result-${index}`);
      searchResults.children[index]?.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderResults(hits) {
    searchHits = hits;
    if (!hits.length) { closeResults(); return; }
    searchResults.replaceChildren(...hits.map((entry, i) => {
      const li = document.createElement('li');
      li.id = `place-result-${i}`;
      li.setAttribute('role', 'option');
      const name = document.createElement('div');
      name.className = 'g-result-name';
      name.textContent = entry.name;
      li.append(name);
      /*
       * Only worth a second line when it says something the name did not — and
       * my campus's own prose does not.
       *
       * `entry.description` is the sentence the college publishes, and it is
       * written as a sentence: "This building consists of Welcome and Support
       * Center, Access Card Station, CalWORKs, Career & Pathways...". Under a
       * row that already says "Welcome and Support Center" that is five words
       * of boilerplate, then the row's own name repeated back to it, then a
       * list cut off mid-clause — and every row in the list starts with the
       * same five words, so a phone showed four paragraphs that rhymed. It
       * needed two lines to do it, which is what made each row 74px tall and
       * the whole list nearly half the screen.
       *
       * buildingSub is what the place card puts under the same name, so a row
       * and the card it opens now say the same thing about the same building
       * rather than two different things in two different registers. It is one
       * short line by construction: what is inside, or the name my campus files it
       * under, or its footprint.
       *
       * The description is still the fallback, because a room is not a
       * directory row and has nothing else to offer.
       */
      const row = entry.points.length > 1 ? null : directoryRow(entry.name);
      const hint = entry.points.length > 1
        ? `${entry.points.length} locations`
        : (row ? buildingSub(row) : entry.description);
      if (hint) {
        const sub = document.createElement('div');
        sub.className = 'g-result-sub';
        sub.textContent = hint;
        li.append(sub);
      }
      li.addEventListener('mousedown', (event) => {
        // mousedown, not click: blur would close the list first.
        event.preventDefault();
        chooseDestination(entry);
      });
      return li;
    }));
    searchResults.classList.remove('hidden');
    // The shelf is what the sheet shows INSTEAD of a list, not above one:
    // both hold the same places in the same order, and a phone showing the
    // three most likely answers twice, 40px apart, would just be asking which
    // of the two to trust.
    placeShortcuts?.classList.add('hidden');
    // A new list has not been navigated yet, whatever the last one had been.
    searchResults.classList.remove('is-navigating');
    searchInput.setAttribute('aria-expanded', 'true');
    highlight(0);
  }

  /** The instance of a multi-location entry nearest whatever we can measure from. */
  function nearestInstance(entry) {
    if (entry.points.length === 1) return entry.points[0];
    const from = measureFrom();
    return entry.points.reduce((best, candidate) => (
      distance(point(candidate), point(from)) < distance(point(best), point(from))
        ? candidate : best
    ));
  }

  async function chooseDestination(entry) {
    // A row with nowhere to go: a class at the Natomas centre, or outdoor PE,
    // which the sheet draws as four separate fields. Both are real answers and
    // both are shown; neither can be routed to, so the panel says why instead
    // of dropping a pin somewhere defensible-looking.
    if (!entry.points.length) {
      searchInput.value = entry.name;
      searchClear.classList.remove('hidden');
      closeResults();
      setStatus(entry.spread
        ? `${entry.name} is ${entry.spread} — no single place to route to.`
        : `${entry.name} is at ${entry.place}, which is not on this campus.`, true);
      return;
    }
    const coords = nearestInstance(entry);
    // Remembered here rather than in `setDestination`, which is also how a tap
    // on the map arrives: this is the one path that means somebody LOOKED
    // something up, which is the thing "most searched" is a claim about.
    recordVisit(entry.name);
    refreshPopularity();
    searchInput.value = entry.name;
    searchClear.classList.remove('hidden');
    closeResults();
    searchInput.blur();
    await setDestination(coords, entry.name);
  }

  searchInput.addEventListener('input', () => {
    searchClear.classList.toggle('hidden', !searchInput.value);
    renderResults(searchInput.value ? runSearch(searchInput.value) : popularHits());
  });

  // -------------------------------------------------------------------------
  // The two endpoint fields
  //
  // Same index, same scoring, same shape of list as the search box above —
  // deliberately, because "what can I type here" should have one answer
  // wherever it is asked. What differs is only what a pick MEANS: in the search
  // box it is always a destination, and here it is whichever end of the route
  // you are typing into.
  //
  // The start also offers "Your location", which is the answer most of the time
  // and is the one thing in the list that is not a place and cannot be spelt.
  // It is offered on an empty field rather than only on a matching query, since
  // an empty field is exactly the state somebody is in when they have not
  // decided what to type yet.
  // -------------------------------------------------------------------------

  const HERE = { here: true, name: 'Your location' };

  /** Whatever `runSearch` would say, with Your location in front where it fits. */
  function endpointSuggestions(query, offerHere) {
    const hits = runSearch(query);
    if (!offerHere) return hits;
    const q = normalise(query);
    const wantsHere = !q || 'your location here me current'.includes(q) || q.startsWith('you');
    return wantsHere ? [HERE, ...hits].slice(0, MAX_RESULTS) : hits;
  }

  /**
   * Give a field a listbox over the campus index.
   *
   * Rendered with the same `.g-results` markup the search box uses so the two
   * lists cannot drift apart visually, and closed on `blur` through a timeout
   * rather than immediately — a click on a row IS a blur on the field, and
   * closing first would remove the row before its own handler ran. `mousedown`
   * with preventDefault is the other half of that, and is what the search box
   * already does for the same reason.
   */
  function wireEndpointField({ input, list, offerHere, onPick }) {
    let hits = [];
    let active = -1;

    const close = () => {
      list.classList.add('hidden');
      list.replaceChildren();
      input.setAttribute('aria-expanded', 'false');
      hits = [];
      active = -1;
    };

    const mark = (index) => {
      active = index;
      [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
    };

    const render = (found) => {
      hits = found;
      if (!found.length) { close(); return; }
      list.replaceChildren(...found.map((entry, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        const name = document.createElement('div');
        name.className = 'g-result-name';
        name.textContent = entry.name;
        li.append(name);
        const hint = entry.here ? 'Where your phone says you are'
          : (entry.points?.length > 1 ? `${entry.points.length} locations` : entry.description);
        if (hint) {
          const sub = document.createElement('div');
          sub.className = 'g-result-sub';
          sub.textContent = hint;
          li.append(sub);
        }
        li.addEventListener('mousedown', (event) => {
          event.preventDefault();
          pick(i);
        });
        return li;
      }));
      list.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
      mark(0);
    };

    async function pick(index) {
      const entry = hits[index];
      if (!entry) return;
      close();
      input.blur();
      if (entry.here) { input.value = 'Your location'; await onPick(null, null, true); return; }
      // A row with nowhere to go — a class at the Natomas centre, outdoor PE.
      // The search box says so rather than dropping a pin somewhere
      // defensible-looking, and so does this.
      if (!entry.points?.length) {
        setStatus(entry.spread
          ? `${entry.name} is ${entry.spread} — no single place to route to.`
          : `${entry.name} is at ${entry.place}, which is not on this campus.`, true);
        return;
      }
      input.value = entry.name;
      await onPick(nearestInstance(entry), entry.name, false);
    }

    input.addEventListener('input', () => render(endpointSuggestions(input.value, offerHere)));
    input.addEventListener('focus', () => render(endpointSuggestions(input.value, offerHere)));
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { close(); return; }
      if (!hits.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); mark((active + 1) % hits.length); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); mark((active - 1 + hits.length) % hits.length); }
      else if (event.key === 'Enter') { event.preventDefault(); pick(active < 0 ? 0 : active); }
    });
  }
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeResults(); return; }
    if (!searchHits.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      // A keyboard cursor exists from the first arrow press and not before.
      // The highlight is drawn off this class on a phone, where there is no
      // pointer to have moved and a row shaded before anything was pressed
      // reads as a row that is already chosen. See .g-results.is-navigating.
      searchResults.classList.add('is-navigating');
      highlight((activeHit + 1) % searchHits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      searchResults.classList.add('is-navigating');
      highlight((activeHit - 1 + searchHits.length) % searchHits.length);
    } else if (event.key === 'Enter' && activeHit >= 0) {
      event.preventDefault();
      chooseDestination(searchHits[activeHit]);
    }
  });

  searchInput.addEventListener('focus', () => {
    renderResults(searchInput.value ? runSearch(searchInput.value) : popularHits());
  });
  searchInput.addEventListener('blur', () => setTimeout(closeResults, 0));

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.add('hidden');
    // Back to the empty-field list rather than to nothing. Clearing is a step
    // towards typing something else, and the list you started from is the most
    // useful thing to land on.
    renderResults(popularHits());
    searchInput.focus();
  });
  return {
    input: searchInput,
    clear: searchClear,
    results: searchResults,
    closeResults,
    buildIndex: buildSearchIndex,
    refreshPopularity,
    renderShortcuts,
    wireEndpointField,
    runSearch,
    popularHits,
    renderResults,
  };
}
