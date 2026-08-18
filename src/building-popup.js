// The card shown when a building or a pin is tapped.
//
// Built as DOM rather than an HTML string because the buttons need handlers and
// because everything in src/directory.json is third-party text — my campus's own
// department names and descriptions — which has no business being interpolated
// into markup.
//
// These used to be floating cards: each brought its own white background,
// border and shadow, and Mapbox anchored it to the thing it described. They are
// panel *contents* now, written into #place-panel in the left column, so the
// surface belongs to the panel and everything here is set in the same `--g-`
// tokens as the rest of the chrome. That is not tidying — a card that painted
// `bg-white` inside a translucent Apple-skin panel would be an opaque rectangle
// sitting in a blurred one, and its greys were hard-coded past both looks.

import { icon } from './g-icons.js';
import { poiFor, POI_CLASSES } from './poi.js';

const FEET_PER_METRE = 10.7639; // squared: m² -> ft²

/** my campus's descriptions are written for a directory listing and run long. */
const TRIM = 90;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * One labelled fact, in Apple's grouped-list shape: the caption small and grey
 * ABOVE the value rather than beside it.
 *
 * A `dl` row, because that is what this is — every one of them is a term and
 * its definition, and the markup saying so is free. The wrapping div is what
 * lets a row be one flex column; `dt`/`dd` alone cannot be grouped.
 */
function field(label, value) {
  const row = el('div', 'g-place-field');
  row.append(el('dt', 'g-place-field-label', label), el('dd', 'g-place-field-value', value));
  return row;
}

/**
 * A titled section of the card body: a heading, then one inset group.
 *
 * The heading is outside the group and the group is the rounded surface, which
 * is the arrangement rather than a detail of it — it is what makes a run of
 * facts read as one block with hairlines between the rows instead of as a stack
 * of little cards. Returns both so the caller fills the group it was given.
 */
function section(title, tag = 'dl') {
  const wrap = el('section', 'g-place-section');
  wrap.append(el('h3', 'g-place-section-title', title));
  const group = el(tag, 'g-place-group');
  wrap.append(group);
  return { wrap, group };
}

/**
 * The head every card in this panel shares: title, whatever qualifies it, and
 * the one control that closes the whole thing.
 *
 * The close button is the card's rather than the panel shell's because the shell
 * is an empty div — one card wants a subtitle and two lines of facts under the
 * heading, the other wants a single line, and a shell that owned the head would
 * have to be told which.
 */
function head(title, onClose) {
  const row = el('div', 'g-panel-head');
  const text = el('div', 'g-place-head-text');
  text.append(el('h2', 'g-panel-title', title));

  const close = el('button', 'g-icon-btn');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  // Wrapped, the way every close button in index.html is. `icon()` returns an
  // svg sized 100%, so dropped straight into the button it filled all 32px of
  // it — a × half again the size of the identical control on the legend two
  // panels away, which .g-icon holds to 20. It only looked like a bare glyph
  // because the disc behind it was the same width as the mark.
  const glyph = el('span', 'g-icon');
  glyph.innerHTML = icon('close');
  close.append(glyph);
  close.addEventListener('click', onClose);

  row.append(text, close);
  return { row, text };
}

/**
 * The two buttons every card on this map ends with, and their wiring.
 *
 * Tiles rather than a row of text buttons: a glyph in a filled disc with its
 * word underneath, the leading one tinted. That is Apple's place card — see
 * Directions / Call / Website — and the shape is doing something the old row
 * did not. "Start here" and "Go here" are four words that differ by one, and
 * set as two identical pills the only thing telling them apart was reading
 * both. An arrow leaving a point and a walker are different at a glance.
 *
 * Directions leads because it is what the card is usually opened for: you
 * tapped a building to go to it. Start here is the other end of the same
 * journey and is the one you press second, if at all.
 *
 * They move together. Both are hidden by `body.no-routing` when the debug
 * menu's routing switch is off, which is why they are one row and not two
 * buttons the caller places.
 */
function actions(coords, name, { onStart, onEnd }) {
  const row = el('div', 'g-place-actions');

  function tile(glyph, label, primary, onPress) {
    const button = el('button', `g-place-action${primary ? ' g-place-action--primary' : ''}`);
    button.type = 'button';
    const disc = el('span', 'g-place-action-disc');
    disc.innerHTML = icon(glyph);
    button.append(disc, el('span', 'g-place-action-label', label));
    button.addEventListener('click', () => onPress(coords, name));
    return button;
  }

  row.append(
    tile('directions', 'Directions', true, onEnd),
    tile('walk', 'Start here', false, onStart),
  );
  return row;
}

/**
 * What each pictogram is, in words.
 *
 * Not read off amenities.json's `label`, because a category pin has no row
 * there at all — it is a directory entry the chip dropped a disc for — and a
 * card that said nothing for half the pins on the map would be worse than one
 * sentence of duplication.
 */
export const KIND_NAMES = {
  defibrillator: 'Defibrillator',
  health_centre: 'Health & Wellness Center',
  emergency_phone: 'Emergency telephone',
  parking_permit: 'Daily parking permit machine',
  // The same machine, in the disc the Parking row draws it with. It is tappable
  // there like any other pin, so it needs the card title its blue twin has —
  // and the same one, because a lighter disc does not make it a different thing.
  parking_meter: 'Daily parking permit machine',
  restroom: 'All-gender restroom',
  bike_rack: 'Bike rack',
  motorcycle_parking: 'Motorcycle parking',
  drop_off: 'Student drop-off',
  drink_vending: 'Drink vending machine',
  food_vending: 'Food vending machine',
  bus_stop: 'Bus stop',
  parking_badge: 'Parking',
  parking: 'Parking',
  food: 'Food and drink',
  homebase: 'HomeBase',
};

/**
 * The card a selected pin opens.
 *
 * Deliberately thinner than the building card. A defibrillator has no directory,
 * no floor area and no departments — it is a thing at a place, and the honest
 * card for it is its name, what it is, and the two things you can do about it.
 *
 * @param {object} hit        `{ coords, kind, name, sub }` from the tapped feature
 * @param {object} handlers   { onStart, onEnd, onClose }
 * @param {string} [hit.sub]  the grey line, when the caller knows better than
 *                            KIND_NAMES does — a dropped pin has no kind to
 *                            name and its coordinates are the only thing there
 *                            is to say about it.
 */
export function pinCard({ coords, kind, name, sub }, { onStart, onEnd, onClose }) {
  const card = el('div', 'g-place');

  // The kind is the fallback title, not a subtitle under it: "Bike Rack /
  // bike rack" is the same word printed twice at two sizes.
  const { row, text } = head(name ?? KIND_NAMES[kind] ?? 'Marker', onClose);
  const under = sub
    ?? (name && KIND_NAMES[kind] && KIND_NAMES[kind] !== name ? KIND_NAMES[kind] : null);
  if (under) {
    // The same grey line the building card runs, for the same reason: it is
    // what this thing IS, under what it is called.
    text.append(el('p', 'g-place-cat', under));
  }
  card.append(row);

  card.append(actions(coords, name ?? KIND_NAMES[kind] ?? null, { onStart, onEnd }));
  return card;
}


/**
 * @param {object} props        a feature from src/directory.json
 * @param {object} handlers     { onStart, onEnd, onClose, media }
 * @param {HTMLElement} [handlers.media]  aerial view, for the places that earn one
 */
export function buildingCard(props, { onStart, onEnd, onClose, media }) {
  const {
    name, officialName, parts, area_m2: area, height, contents = [], facilities = [], entrance,
  } = props;

  const card = el('div', 'g-place');

  const { row, text } = head(name, onClose);

  // One grey line under the name, the way Apple runs "University Department ·
  // University of California, Davis" under a place: WHAT it is, then WHOSE it
  // is. The classification comes from the same table that picks the building's
  // disc on the map, so the line and the marker cannot disagree, and my campus
  // name is only worth its half when it says something the heading does not.
  const kind = POI_CLASSES[poiFor(name)];
  const qualifiers = [];
  if (kind) qualifiers.push(kind);
  if (officialName && officialName !== name) qualifiers.push(officialName);
  if (qualifiers.length) text.append(el('p', 'g-place-cat', qualifiers.join(' · ')));

  card.append(row);

  // The aerial view, directly under the name and above everything you can
  // press. That is where Apple puts a place's photographs and it is the right
  // place for the same reason: it is the half of the card that answers "is this
  // the building I meant" without being read, and a picture that has to be
  // scrolled to has been answered too late. Absent for most things on this map
  // — see src/flyover.js for who earns one and why.
  if (media) card.append(media);

  // Above the body rather than at the foot of the card. It was last, under
  // everything, which put the one thing the card is FOR behind a scroll on any
  // building with a directory — you tapped it to walk there.
  //
  // No entrance means no routing node was found near the walls, which would
  // make both buttons lie about what they do.
  if (entrance) card.append(actions(entrance, name, { onStart, onEnd }));

  const body = el('div', 'g-place-body');

  // The facts, as a grouped list rather than the two grey `·`-joined lines they
  // were. Same words, but "12,400 sq ft · 34 ft tall" is a caption you skim and
  // a labelled row is one you can look something up in, and this is the half of
  // the card people actually read a number out of.
  const details = section('Details');
  details.group.append(field('Floor area',
    `${Math.round(area * FEET_PER_METRE).toLocaleString()} sq ft`));
  if (height) details.group.append(field('Height', `${Math.round(height * 3.28084)} ft`));
  // Several footprints folded into one building — the wings my campus numbers
  // separately. Plural label only when it is one.
  if (parts?.length) {
    details.group.append(field(parts.length === 1 ? 'Section' : 'Sections', parts.join(' · ')));
  }
  if (facilities.length) {
    details.group.append(field('Facilities', facilities
      .map((f) => (f.n ? `${f.name} ×${f.n}` : f.name))
      .join(' · ')));
  }
  body.append(details.wrap);

  if (contents.length) {
    // The count is the heading, not a kicker above one: "5 destinations inside"
    // IS the title of this section, and a separate "Inside" over it would be a
    // second heading saying the same thing.
    const inside = section(
      contents.length === 1 ? '1 destination inside' : `${contents.length} destinations inside`,
      'ul',
    );
    for (const entry of contents) {
      const item = el('li', 'g-place-entry');
      item.append(el('span', 'g-place-entry-name', entry.name));
      if (entry.description) {
        const short = entry.description.length > TRIM
          ? `${entry.description.slice(0, TRIM).trimEnd()}…`
          : entry.description;
        item.append(el('span', 'g-place-entry-sub', short));
      }
      inside.group.append(item);
    }
    body.append(inside.wrap);
  }

  card.append(body);
  return card;
}
