// The legend, the chips, and what each one lights up.
//
// ONE MODULE BECAUSE IT IS ONE STATE MACHINE. Eleven variables that only make
// sense together: which legend row is stuck and which is merely hovered, which
// category is showing and which is being previewed, which building kind is
// being browsed, and the outlines each of those paints. Every one of them is
// read by at least two of the others — `shownRow` and `shownCategory` exist
// precisely to answer "sticky or hover?" in one place — and they were spread
// across four separate regions of startApp() with three hundred lines of
// unrelated layer building between them.
//
// THE HOVER IS THE REASON FOR THE PAIRS. A legend row does two things: pressing
// it sticks, pointing at it previews. Both paint the same outline layer, so the
// painter cannot read a single "selected" variable — it has to know which of
// the two is in force, and that answer has to be the same for the outline, for
// the pin filter and for the list in the panel, or the map disagrees with the
// card describing it.

import { CATEGORIES, CATEGORY_BY_ID, collect } from './categories.js';
import {
  buildAreas, highlightFor, highlightForKind, areaCollection, pointCollection, extentOf,
} from './highlight.js';
import { BUILDING_KINDS, BUILDING_KIND_BY_ID, kindRow, groupBuildings } from './building-kinds.js';
import { poiFor, POI_CLASSES } from './poi.js';
import { pinColour, glyphInk, glyphSvg, textInk } from './map-images.js';
import { paintIcons } from './g-icons.js';
import { niceFeet } from './maneuvers.js';

/** Nothing to draw, in the shape every geojson source expects. */
const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * @param {object} deps
 * @param {object} deps.map
 * @param {Function} deps.litPalette
 * @param {object} deps.elements   the legend's and the category card's nodes
 * @param {Function} deps.isPhone
 * @param {object} deps.data       getters for the overlays, which land late
 * @param {object} deps.camera     createCamera(), for framing an answer
 * @param {Function} deps.feetFrom
 * @param {Function} deps.playSwap
 * @param {Function} deps.playClear
 * @param {Function} deps.openBuilding
 * @param {Function} deps.toggleSheet        open or close a panel
 * @param {object} deps.legendOpen           the button that opens the legend
 * @param {Function} deps.addCategoryLayer
 * @param {Function} deps.setDestination
 * @param {Function} deps.buildingSub        the subtitle a building card shows
 */
export function createLegend({
  map,
  litPalette,
  elements,
  isPhone,
  data,
  camera,
  feetFrom,
  playSwap,
  playClear,
  openBuilding,
  toggleSheet,
  legendOpen,
  addCategoryLayer,
  setDestination,
  buildingSub,
}) {
  const { legendList, browseGrid, kindsGrid, legendPanel, categoryPanel } = elements;

  // -------------------------------------------------------------------------

  /** Everything the legend can outline. Empty until the overlays land. */
  let legendAreas = [];
  /** category id -> { indices, points, counts }, computed once per load. */
  const legendHighlights = new Map();
  /** The pressed category's outline, and the row the pointer is over. */
  let stickyRow = null;
  let hoverRow = null;
  /** False until a file a category can be collected from has landed. */
  let legendReady = false;

  /**
   * Which row the outline belongs to — and a hover is no longer one of them.
   *
   * Hovering used to outline whatever it pointed at. It does not any more: a
   * hover now previews the row's PINS, which arrive over a cleared campus (see
   * previewLegendRow). Tinting ground purple underneath them said two things
   * about one question, and the outline was the half nobody had asked for —
   * "where are the defibrillators" is answered by six discs, not by shading the
   * buildings they hang in.
   *
   * Parking is not the exception it looks like it should be. It is the one row
   * that names a class of the printed sheet, so it is the one row whose ground
   * IS an answer — but its pins say the same thing better, because a lot you
   * can read the name of beats a lot you can only see the shape of, and the
   * permit machines have no shape on the sheet at all. Its outline survives on
   * the PRESS, where there is room for context under a committed answer.
   *
   * So a hover takes the outline off rather than replacing it, which is what
   * keeps the two answers off the map at the same time. Still undoable, which
   * is why there were two variables to begin with: a hover never writes
   * stickyRow, so leaving the row hands the outline straight back to the
   * selection without the selection ever having been touched.
   *
   * Pointing at the row that is ALREADY selected is not a preview, though —
   * there is nothing for it to preview that is not on screen — so that case
   * keeps the outline rather than suppressing it. Without the second half of
   * this test, pressing a row would hide its own outline until the pointer
   * happened to leave, which reads as the press having half-failed.
   */
  const shownRow = () => (hoverRow && hoverRow !== stickyRow ? null : stickyRow);

  function paintHighlight() {
    const shown = shownRow();
    const highlight = shown ? legendHighlights.get(shown) : null;

    map.getSource('highlight-areas')?.setData(
      highlight ? areaCollection(legendAreas, highlight.indices) : EMPTY,
    );
    map.getSource('highlight-points')?.setData(
      highlight ? pointCollection(highlight.points) : EMPTY,
    );
  }

  /**
   * Three layers over two sources, added together and taken down never.
   *
   * They sit between the printed sheet and the road ribbon, which is where a
   * ground annotation belongs: over my campus's own tarmac and lawn, under the white
   * paths and under the route, so lighting up every car park on campus cannot
   * bury the directions someone is following. Insertion order does it — the
   * network layers are added after this in addNetworkLayers, and within a slot
   * Mapbox honours the order it was given.
   */
  function addHighlightLayers() {
    const colors = litPalette();

    if (map.getLayer('highlight-fill')) {
      for (const [id, property] of [
        ['highlight-fill', 'fill-color'],
        ['highlight-line', 'line-color'],
        ['highlight-points', 'circle-color'],
        ['highlight-points', 'circle-stroke-color'],
      ]) {
        map.setPaintProperty(id, property, colors.highlight);
      }
      return;
    }

    if (!map.getSource('highlight-areas')) {
      map.addSource('highlight-areas', { type: 'geojson', data: EMPTY });
    }
    if (!map.getSource('highlight-points')) {
      map.addSource('highlight-points', { type: 'geojson', data: EMPTY });
    }

    map.addLayer({
      id: 'highlight-fill',
      type: 'fill',
      source: 'highlight-areas',
      slot: 'middle',
      paint: {
        'fill-color': colors.highlight,
        // A car park is fifty times the area of a building and the same wash
        // over both reads as two different strengths of answer. Weaker on the
        // large shape is what makes them look like one highlight.
        'fill-opacity': ['match', ['get', 'kind'], 'zone', 0.16, 0.26],
        'fill-emissive-strength': 1,
      },
    });
    map.addLayer({
      id: 'highlight-line',
      type: 'line',
      source: 'highlight-areas',
      slot: 'middle',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': colors.highlight,
        'line-width': 2.5,
        'line-emissive-strength': 1,
      },
    });
    // The ones with no shape to outline: the bike racks bolted to a path, the
    // three bus stops out on the perimeter. A ring on the ground under the pin
    // that is already there, rather than a second pin competing with it.
    map.addLayer({
      id: 'highlight-points',
      type: 'circle',
      source: 'highlight-points',
      slot: 'middle',
      paint: {
        'circle-color': colors.highlight,
        'circle-opacity': 0.3,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4, 19, 12],
        'circle-stroke-color': colors.highlight,
        'circle-stroke-width': 2,
        'circle-emissive-strength': 1,
      },
    });

    // A style swap drops the layers with a row still selected, so what the
    // legend thinks is showing has to be pushed back at the new ones.
    paintHighlight();
  }

  // -------------------------------------------------------------------------

  // categoryPanel is declared up with the route panel — campusPadding measures it.
  const categoryTitle = document.getElementById('category-title');
  const categoryCount = document.getElementById('category-count');
  const categoryList = document.getElementById('category-list');
  const categoryClose = document.getElementById('category-close');
  categoryClose.addEventListener('click', () => clearResults());

  /** The selected category's id, or null when the map is showing everything. */
  let activeCategory = null;
  let categoryHits = [];

  /**
   * ...and the same pair for the building-type grid, which is the other thing
   * the results panel can be showing.
   *
   * Deliberately NOT folded into activeCategory. The two answer with different
   * machinery — a legend row drops pins and filters the amenity layer, a
   * building class outlines ground and touches no layer at all — and the one
   * thing they have to agree about is that only one of them can be on screen,
   * which is a line of code in each rather than a shared variable that would
   * have to carry a tag saying which kind of thing it held.
   */
  let activeKind = null;
  let kindHits = [];
  /** Every directory building, grouped by class. Rebuilt when the file lands. */
  let kindGroups = new Map();

  /**
   * The hovered row's category, which the map draws in place of the selection
   * for exactly as long as the pointer is on the row.
   *
   * Separate from activeCategory for the same reason hoverRow is separate from
   * stickyRow: a preview has to be undoable. Hovering never writes the
   * selection, so leaving the row puts back the pressed category's pins — or
   * the whole campus, if nothing was pressed.
   */
  let hoverCategory = null;
  let hoverHits = [];

  /**
   * What the pin layer is actually drawing, which is the preview if there is
   * one and the selection otherwise.
   *
   * Every read that is about WHAT IS ON THE MAP goes through these; the reads
   * that are about what the user has committed to — the results list, the
   * camera, which row shows as pressed — keep reading activeCategory directly.
   * That split is the whole difference between a preview and a selection.
   */
  const shownCategory = () => hoverCategory ?? activeCategory;
  const shownHits = () => (hoverCategory ? hoverHits : categoryHits);

  function renderCategoryList(category) {
    categoryTitle.textContent = category.label;
    categoryCount.textContent = categoryHits.length
      ? `${categoryHits.length} on campus · ${category.legend}`
      : `Nothing found · ${category.legend}`;

    categoryList.replaceChildren(...categoryHits.map((hit) => {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'g-row';

      const disc = document.createElement('span');
      disc.className = 'g-row-disc';
      disc.dataset.icon = category.glyph;
      row.append(disc);

      const text = document.createElement('span');
      text.className = 'g-row-text';
      const name = document.createElement('span');
      name.className = 'g-row-name';
      name.textContent = hit.name;
      text.append(name);
      if (hit.sub) {
        const sub = document.createElement('span');
        sub.className = 'g-row-sub';
        sub.textContent = hit.sub;
        text.append(sub);
      }
      row.append(text);

      const dist = document.createElement('span');
      dist.className = 'g-row-dist';
      dist.textContent = niceFeet(hit.feet);
      row.append(dist);

      row.addEventListener('click', () => setDestination(hit.coords, hit.name));
      li.append(row);
      return li;
    }));
    paintIcons(categoryList);
    categoryPanel.classList.remove('hidden');
  }

  /**
   * Frame the hits, unless they are already in front of you — Google does not
   * move the map when what you asked for is already on screen, and a gratuitous
   * flyTo throws away wherever the user had panned to.
   *
   * "On screen" means where somebody can see it rather than where the canvas
   * ends — see `inView`, and the three bus stops it was written for.
   */
  /**
   * The buildings of one class, in the panel a legend row uses.
   *
   * The same panel on purpose: there is one place on this screen where "here is
   * what you asked for" appears, and a second one would be a second thing to
   * dismiss. It is also why selecting either kind of row clears the other.
   *
   * A row opens the BUILDING CARD rather than setting a destination, which is
   * where this list differs from the category one above it. A defibrillator is
   * a point you walk to and nothing else; a building has a card with what is
   * inside it, an aerial view and its own Directions button — offering only
   * "route me there" would be answering a narrower question than the one a
   * browse grid was pressed to ask.
   */
  function renderKindList(kind) {
    categoryTitle.textContent = kind.label;
    const held = POI_CLASSES[kind.id];
    categoryCount.textContent = kindHits.length
      ? `${kindHits.length} building${kindHits.length === 1 ? '' : 's'} · ${held}`
      : `Nothing found · ${held}`;

    const tint = pinColour(kind.id);
    categoryList.replaceChildren(...kindHits.map(({ props, feet }) => {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'g-row';

      // The class's own pictogram, in the class's own hue — the same drawing
      // that is on the map over each of these footprints. Every row in this
      // list is the same class, so the disc is saying what the LIST is rather
      // than telling the rows apart, which is exactly what the category list
      // above does with its own glyph.
      const disc = document.createElement('span');
      disc.className = 'g-row-disc';
      disc.style.color = tint;
      disc.style.background = `color-mix(in srgb, ${tint} 18%, transparent)`;
      disc.innerHTML = glyphSvg(kind.id);
      row.append(disc);

      const text = document.createElement('span');
      text.className = 'g-row-text';
      const name = document.createElement('span');
      name.className = 'g-row-name';
      name.textContent = props.name;
      const sub = document.createElement('span');
      sub.className = 'g-row-sub';
      sub.textContent = buildingSub(props);
      text.append(name, sub);
      row.append(text);

      const dist = document.createElement('span');
      dist.className = 'g-row-dist';
      dist.textContent = niceFeet(feet);
      row.append(dist);

      row.addEventListener('click', () => openBuilding(props));
      li.append(row);
      return li;
    }));
    categoryPanel.classList.remove('hidden');
  }

  /**
   * A category's pins, nearest first.
   *
   * Shared by the press and the hover preview, so the two cannot disagree about
   * what a row means. The preview IS the answer, arriving early.
   */
  function hitsFor(category) {
    return collect(category, { amenities: data.amenities(), places: data.places() })
      .map((hit) => ({ ...hit, feet: feetFrom(hit.coords) }))
      .sort((a, b) => a.feet - b.feet);
  }

  function selectCategory(id) {
    const category = CATEGORY_BY_ID.get(id);
    if (!category) return;

    // Pressing the pressed chip is how you get back to the whole map.
    if (activeCategory === id) { clearCategory(); return; }

    // One answer at a time. The results panel below is shared and the outline
    // is a single source, so a legend row arriving while a building class is
    // up has to take both off it first.
    if (activeKind) clearKind();

    activeCategory = id;

    // The hover that led here is being promoted to a selection, so the preview
    // state goes now. Nothing changes on screen — these are the same pins, and
    // shownCategory falls straight through to activeCategory — but leaving it
    // set would arm the mouseleave that is about to happen to tear down the
    // selection it had just become.
    hoverCategory = null;
    hoverHits = [];

    // EVERY pin gets its name, including the six that all read "All-gender
    // restroom". This used to print a name only where it identified one pin
    // among the others — "Myrtle Parking Lot East" yes, six copies of one phrase
    // no — on the grounds that repeating the icon's own meaning in type is
    // noise.
    //
    // It is noise on a map you are reading and it is the answer on a map you
    // have just questioned. Having pressed Defibrillators, the six discs are the
    // result and the word under each is what says so; leaving them bare made the
    // category read as a pictogram you still had to know. The names are also the
    // point of the entrance — they arrive with the pins — and an entrance where
    // most of the pins bring nothing looks half-finished.
    //
    // Collision still has the last word, because `text-optional` is set on the
    // layer: names that cannot fit are dropped and their discs stay. That is the
    // right place for the decision, since it depends on the zoom rather than on
    // the wording.
    categoryHits = hitsFor(category);

    // On a phone the legend is a full-width sheet over the map, so leaving it
    // up would mean answering "where are the restrooms" with a card covering
    // the restrooms. The pins and the results list are the answer; the list you
    // asked from has done its job.
    // Plain toggleSheet, not toggleLegendPanel: frameCategory a few lines below
    // is about to move the camera anyway, and it reads campusPadding after this
    // has run, so the sheet is already out of the reckoning.
    if (isPhone()) toggleSheet(legendPanel, legendOpen, false);

    // The pressed row, and the outline that goes with it. A category press now
    // answers both halves of the question it was split across: the pins say
    // where the things are, the outline says which buildings hold them.
    stickyRow = id;
    paintHighlight();
    syncLegendRows();

    renderCategoryList(category);
    // The camera and the pins move together. Framing first and animating after
    // would read as two separate events, and the fly is 700 ms of the 1324 the
    // pins take anyway.
    //
    // The pins own the camera, not the outline: the pins ARE the answer and the
    // outlined ground is context for it, and two fitBounds in one gesture is a
    // flight that lands somewhere neither of them asked for.
    //
    // Next frame, for the reason showPlaceCard states: renderCategoryList has
    // just shown the results panel, and on a phone that panel is a sheet whose
    // height nothing has decided yet — the stack is told by a MutationObserver
    // and observers do not run until this task ends. Framing now frames the map
    // around the sheet as it was, and the nearest few pins — the ones the list
    // is sorted to put first — land underneath it.
    requestAnimationFrame(() => camera.frameCategory());
    playSwap();
  }

  function clearCategory() {
    activeCategory = null;
    categoryHits = [];
    stickyRow = null;
    paintHighlight();
    syncLegendRows();
    categoryPanel.classList.add('hidden');
    categoryList.replaceChildren();
    playClear();
  }

  /**
   * The buildings of one class, outlined and listed.
   *
   * Deliberately thinner than selectCategory. That one has pins to drop, a pin
   * layer to filter and a swap animation to run between two sets of markers;
   * this has none of those, because the buildings it is about are ALREADY on
   * the map with their own discs on them. Adding a second marker over each
   * would be the same answer printed twice, in two shapes. What the press adds
   * is the outline — which of the shapes down there are the ones you asked
   * about — and the list.
   */
  function selectKind(id) {
    const kind = BUILDING_KIND_BY_ID.get(id);
    if (!kind || !data.directory()) return;

    if (activeKind === id) { clearKind(); return; }
    if (activeCategory) clearCategory();

    activeKind = id;
    kindHits = (kindGroups.get(id) ?? [])
      // `anchor` is the pole of inaccessibility, which is where the label sits
      // and is a better middle than an entrance node hanging off one edge. Same
      // point showBuildingCard flies to, so the distance printed on a row and
      // the place the row takes you are the same place.
      .map((props) => ({ props, feet: feetFrom(props.anchor ?? props.entrance) }))
      .sort((a, b) => a.feet - b.feet);

    // Same reason the legend row has it: on a phone the sheet this was pressed
    // from covers the campus it is about.
    if (isPhone()) toggleSheet(legendPanel, legendOpen, false);

    stickyRow = kindRow(id);
    paintHighlight();
    syncLegendRows();

    renderKindList(kind);
    // Next frame, for the reason frameCategory is: the panel that just opened
    // is a sheet on a phone and nothing has measured it yet.
    requestAnimationFrame(frameKind);
  }

  function clearKind() {
    activeKind = null;
    kindHits = [];
    stickyRow = null;
    paintHighlight();
    syncLegendRows();
    categoryPanel.classList.add('hidden');
    categoryList.replaceChildren();
  }

  /**
   * The extent of what is outlined, rather than of a set of points.
   *
   * frameCategory frames the PINS because the pins are that answer; here the
   * ground is, so it frames the same rectangle the outline covers. maxZoom
   * matches the legend row's for the same reason — one building on its own
   * would otherwise fill the screen at z20 and lose the campus around it.
   */
  function frameKind() {
    const highlight = legendHighlights.get(kindRow(activeKind));
    if (highlight?.indices.length) camera.frame(extentOf(legendAreas, highlight), { maxZoom: 17 });
  }

  /** Whichever of the two the results panel is showing. */
  function clearResults() {
    if (activeKind) clearKind();
    if (activeCategory) clearCategory();
  }

  /** "6 buildings", "1 building · 22 zones · 5 outdoors", or nothing at all. */
  function countText(counts) {
    const parts = [];
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (counts.buildings) parts.push(plural(counts.buildings, 'building'));
    if (counts.zones) parts.push(plural(counts.zones, 'zone'));
    // Named rather than counted with the rest: these are the ones the outline
    // cannot speak for, and rolling them into "15 things" would hide that.
    if (counts.outside) parts.push(`${counts.outside} outdoors`);
    return parts.join(' · ');
  }

  function renderLegend() {
    legendList.replaceChildren(...CATEGORIES.map((category) => {
      const highlight = legendHighlights.get(category.id);
      const li = document.createElement('li');

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'g-legend-row';
      row.dataset.id = category.id;
      // A toggle, not a radio: the pressed row is a thing you turn off again,
      // and there is no fourth state for "none of them" to occupy.
      row.setAttribute('aria-pressed', String(activeCategory === category.id));
      // Both data files are still in flight at this point, and a row that
      // silently reports "Nothing found" reads as broken rather than as early.
      row.disabled = !legendReady;

      const glyph = document.createElement('span');
      glyph.className = 'g-icon g-legend-glyph';
      glyph.dataset.icon = category.glyph;

      const text = document.createElement('span');
      text.className = 'g-legend-text';
      const name = document.createElement('span');
      name.className = 'g-legend-name';
      // The category's own short label rather than the printed wording. This
      // row is a control now — the thing you press to find restrooms — and
      // "Restrooms" is what a control is called; the sheet's full phrasing
      // ("All-gender restroom") is the title, where it reads as a gloss.
      name.textContent = category.label;
      text.append(name);
      row.title = category.legend;

      // What the outline will do, printed before you ask for it. Absent until
      // the join has run, which is the only thing `highlight` being missing
      // ever means.
      if (highlight) {
        const count = document.createElement('span');
        count.className = 'g-legend-count';
        count.textContent = countText(highlight.counts);
        text.append(count);
      }

      row.append(glyph, text);
      row.addEventListener('click', () => selectCategory(category.id));
      // Focus counts as hover, so the whole thing works from the keyboard.
      row.addEventListener('mouseenter', () => previewLegendRow(category.id));
      row.addEventListener('focus', () => previewLegendRow(category.id));
      row.addEventListener('mouseleave', () => previewLegendRow(null));
      row.addEventListener('blur', () => previewLegendRow(null));

      li.append(row);
      return li;
    }));
    paintIcons(legendList);
    // One call site for both shapes of the same list, so a category cannot be
    // live in the sidebar and dead in the sheet.
    renderBrowse();
  }

  /**
   * The same eleven, as the grid the phone sheet opens onto.
   *
   * WHY A SECOND RENDERER for one list. The legend is a column of rows with a
   * count under each name — "6 buildings · 22 zones" — which is what it is for:
   * a key you read down. Pulled open on a phone the sheet is not a key, it is
   * the front page, and a front page asks a different question. Apple's is a
   * grid of coloured discs and one word each, and that shape is the reason you
   * can find Coffee on it without reading anything.
   *
   * So: same data, same press, same pressed state, different shape. Not a
   * variant of `renderLegend` behind a flag — the two disagree about almost
   * every element they build, and the one thing they must agree on is what a
   * press does, which is `selectCategory` in both.
   *
   * THE DISC WEARS THE PIN'S OWN COLOUR. `pinColour` is what map-images.js
   * paints the markers this row drops with, so pressing Restrooms puts teal
   * pins on the map from a teal tile, and Emergency phones yellow ones from a
   * yellow tile. Read from there rather than restated here, because a second
   * table of eleven hues is a second table to drift.
   */
  function renderBrowse() {
    if (!browseGrid) return;
    browseGrid.replaceChildren(...CATEGORIES.map((category) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'g-browse-tile';
      tile.dataset.id = category.id;
      tile.setAttribute('aria-pressed', String(activeCategory === category.id));
      // Same reason the legend's rows are: both files are still in flight when
      // this first runs, and a tile that answers "Nothing found" reads as
      // broken rather than as early.
      tile.disabled = !legendReady;
      tile.title = category.legend;

      const disc = document.createElement('span');
      disc.className = 'g-browse-disc';
      // `icon` is the disc a category with no pictogram draws its own pins
      // with; `kinds[0]` is the pictogram for one that has them. Every category
      // has at least one of the two — see src/categories.js — and pinColour
      // falls back to the family blue for anything that somehow has neither.
      const tint = pinColour(category.icon ?? category.kinds?.[0]);
      disc.style.setProperty('--tint', tint);
      // White on most of them and near-black on the yellow, decided by contrast
      // rather than by eye — the same call map-images.js makes for the glyph
      // inside the pin, from the same function, so a tile and the pins it drops
      // cannot end up with different ink on the same hue.
      disc.style.color = glyphInk(tint);

      const glyph = document.createElement('span');
      glyph.className = 'g-icon g-browse-glyph';
      glyph.dataset.icon = category.glyph;
      disc.append(glyph);

      const name = document.createElement('span');
      name.className = 'g-browse-name';
      name.textContent = category.label;

      tile.append(disc, name);
      tile.addEventListener('click', () => selectCategory(category.id));
      return tile;
    }));
    paintIcons(browseGrid);
  }

  /**
   * The building-type grid: ten blocks of colour, two to a row.
   *
   * THE TILE IS THE COLOUR. The Find Nearby tile above it is a grey card with a
   * coloured disc on it, and that is right for what it is — pressing it drops
   * pins, and the disc is one of those pins shown early. This grid drops
   * nothing. It is the classification itself, so there is no marker for a small
   * shape to stand in for and no reason to spend two thirds of the tile on grey.
   *
   * The count is not decoration either. Four of these classes hold exactly one
   * building on this campus, and a tile that says so is a tile somebody can
   * decide about before pressing it — "Bookstore · 1 building" is an answer
   * already, and the press is only for where it is.
   *
   * Written from src/building-kinds.js, coloured by pinColour and drawn with
   * map-images.js's own pictogram for the class, which is the same drawing on
   * the same footprints out on the map.
   */
  function renderKinds() {
    if (!kindsGrid) return;
    kindsGrid.replaceChildren(...BUILDING_KINDS.map((kind) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'g-kind';
      tile.dataset.id = kind.id;
      tile.setAttribute('aria-pressed', String(activeKind === kind.id));
      // Same gate as the row above: the directory is what the counts and the
      // outlines are read from, and a tile that answers "Nothing found" before
      // it has landed reads as broken rather than as early.
      tile.disabled = !data.directory();
      tile.title = POI_CLASSES[kind.id];

      const tint = pinColour(kind.id);
      tile.style.setProperty('--tint', tint);
      // textInk, not glyphInk. A marker on the map carries a pictogram and
      // WCAG's bar for one of those is 3:1; a tile carries a WORD, and the bar
      // for that is 4.5. Three of these hues sit between the two — food, sport
      // and arts all give white about 3.1 — so the pictogram rule would have
      // put "Sport" in white on green and called it legible. The glyph takes
      // the same ink as the label rather than its own: two inks on one tile
      // reads as a bug, and at 4.96 the darker one is fine for both.
      tile.style.color = textInk(tint);

      const glyph = document.createElement('span');
      glyph.className = 'g-kind-glyph';
      glyph.innerHTML = glyphSvg(kind.id);

      const text = document.createElement('span');
      text.className = 'g-kind-text';
      const name = document.createElement('span');
      name.className = 'g-kind-name';
      name.textContent = kind.label;
      const count = document.createElement('span');
      count.className = 'g-kind-count';
      const n = kindGroups.get(kind.id)?.length ?? 0;
      count.textContent = data.directory() ? `${n} building${n === 1 ? '' : 's'}` : '…';
      text.append(name, count);

      tile.append(glyph, text);
      tile.addEventListener('click', () => selectKind(kind.id));
      return tile;
    }));
  }

  /** The pressed state alone, for the paths that already redrew everything else. */
  function syncLegendRows() {
    for (const li of legendList.children) {
      const row = li.firstElementChild;
      row?.setAttribute('aria-pressed', String(row.dataset.id === activeCategory));
    }
    for (const tile of browseGrid?.children ?? []) {
      tile.setAttribute('aria-pressed', String(tile.dataset.id === activeCategory));
    }
    // The building grid is synced from HERE rather than from its own selection
    // path, so every route that already redrew the pressed state — clearing a
    // category, dismissing the panel, pressing a legend row — un-presses a
    // building tile too without having to learn that it exists.
    for (const tile of kindsGrid?.children ?? []) {
      tile.setAttribute('aria-pressed', String(tile.dataset.id === activeKind));
    }
  }

  /** Called once the overlays a category reads from have actually arrived. */
  function enableLegend() {
    legendReady = true;
    renderLegend();
  }

  /**
   * The categories go live on the first of the two files they read.
   *
   * A chip reads amenities.json, places.json or both, so a category over the
   * surviving file is still a working category and there is no reason to make
   * the legend wait for the second one. Called from both arrivals rather than
   * once after them; addCategoryLayer and enableLegend are both written to be
   * re-entered — the first checks for its own layer and recolours it, the
   * second sets a flag and re-renders — so the second call is a no-op with a
   * repaint on the end of it.
   */
  function enableCategories() {
    addCategoryLayer();
    enableLegend();
  }

  /**
   * Point at a row and its answer arrives on the map.
   *
   * This used to outline ground in purple. It now does what pressing does, less
   * the parts that commit: the campus empties, the row's pins arrive on the
   * lift's spring with their names, and the whole thing is undone the moment the
   * pointer leaves. No results list, no camera move — a preview that flew the
   * map somewhere would make running an eye down eleven rows unusable, and the
   * pins land wherever they are, in view or not.
   *
   * Every row behaves this way, parking included. Its 22 outlined car parks were
   * a real answer, but its pins are a better one — a lot you can read the name
   * of beats a lot you can only see the shape of — and the permit machines that
   * belong to the same question have no shape on the sheet to outline at all.
   *
   * The reversal is the reason this is cheap enough to fire on mouseenter:
   * `choreography` cancels whatever is mid-flight and `fadeFrom` picks up the
   * opacity where the cancelled run left it, so dragging the pointer down the
   * column dissolves one set into the next instead of restarting eleven times.
   */
  function previewLegendRow(id) {
    if (hoverRow === id) return;
    hoverRow = id;
    // The outline goes with the pointer arriving, not with the pins landing:
    // shownRow drops it for the whole time a hover is up. See shownRow.
    paintHighlight();

    const category = id ? CATEGORY_BY_ID.get(id) : null;
    if (hoverCategory === (category?.id ?? null)) return;

    hoverCategory = category?.id ?? null;
    hoverHits = category ? hitsFor(category) : [];

    // Whichever direction this is: onto a row, off a row, or straight from one
    // row to the next. `shownCategory` has already been updated, so the only
    // question left is whether anything should be on the map when this settles.
    if (shownCategory()) playSwap();
    else playClear();
  }

  /** Every half of the state, for the places the legend itself goes away. */
  function clearLegendHighlight() {
    // Through previewLegendRow rather than by nulling hoverRow, because a hover
    // now owns pins as well as the outline and the panel can close with the
    // pointer still on a row — a closing legend that left a preview behind would
    // strand a category on the map with nothing on screen naming it. Returns
    // immediately when there was no hover, so this costs nothing in the common
    // case and never plays a spurious animation.
    previewLegendRow(null);
    if (activeCategory) clearCategory();
    else { stickyRow = null; paintHighlight(); }
  }

  /**
   * Do the join, once, when the overlays that feed it have arrived.
   *
   * Every row is resolved up front rather than on first hover: the answer is
   * what the row prints under its caption, so it has to exist before anything
   * is pointed at, and eleven categories over 90 areas is a few milliseconds.
   */
  function buildLegendIndex() {
    legendAreas = buildAreas({
      directory: data.directory(),
      buildings: data.buildings(),
      basemap: data.sheet(),
      zoneKinds: CATEGORIES.map((category) => category.zones).filter(Boolean),
    });
    legendHighlights.clear();
    for (const category of CATEGORIES) {
      legendHighlights.set(category.id, highlightFor(category, {
        areas: legendAreas,
        amenities: data.amenities(),
        places: data.places(),
      }));
    }
    // The building classes, into the same table under namespaced keys — see
    // kindRow, and the `parking` collision it exists for. One table because
    // paintHighlight reads one variable: whatever stickyRow names is what is
    // outlined, and it should not have to know which family the row came from.
    for (const kind of BUILDING_KINDS) {
      legendHighlights.set(kindRow(kind.id), highlightForKind(kind.id, {
        areas: legendAreas,
        classify: poiFor,
      }));
    }
    kindGroups = groupBuildings(data.directory(), poiFor);
    renderLegend();
    renderKinds();
  }
  return {
    shownCategory,
    shownHits,
    shownRow,
    /** What the chip that is up found, for the camera to frame. */
    hits: () => categoryHits,
    /** The ground that chip outlines, or null when it lights nothing. */
    extent: () => {
      const highlight = legendHighlights.get(activeCategory);
      return highlight ? extentOf(legendAreas, highlight) : null;
    },
    /** Whether a chip is stuck, and the way back. */
    isActive: () => Boolean(activeCategory),
    clearCategory,
    renderKinds,
    paintHighlight,
    addHighlightLayers,
    clearResults,
    clearHighlight: clearLegendHighlight,
    buildIndex: buildLegendIndex,
    renderLegend,
    enableLegend,
    enableCategories,
    syncRows: syncLegendRows,
    previewRow: previewLegendRow,
    selectCategory,
    selectKind,
  };
}
