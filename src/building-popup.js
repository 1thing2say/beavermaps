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
  close.innerHTML = icon('close');
  close.addEventListener('click', onClose);

  row.append(text, close);
  return { row, text };
}

/** The two buttons every card on this map ends with, and their wiring. */
function actions(coords, name, { onStart, onEnd }) {
  const row = el('div', 'g-place-actions');

  const start = el('button', 'g-btn g-btn--ghost', 'Start here');
  start.type = 'button';
  start.addEventListener('click', () => onStart(coords, name));

  const go = el('button', 'g-btn g-btn--primary', 'Go here');
  go.type = 'button';
  go.addEventListener('click', () => onEnd(coords, name));

  row.append(start, go);
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
 * @param {object} hit        `{ coords, kind, name }` from the tapped feature
 * @param {object} handlers   { onStart, onEnd, onClose }
 */
export function pinCard({ coords, kind, name }, { onStart, onEnd, onClose }) {
  const card = el('div', 'g-place');

  // The kind is the fallback title, not a subtitle under it: "Bike Rack /
  // bike rack" is the same word printed twice at two sizes.
  const { row, text } = head(name ?? KIND_NAMES[kind] ?? 'Marker', onClose);
  if (name && KIND_NAMES[kind] && KIND_NAMES[kind] !== name) {
    text.append(el('p', 'g-panel-sub', KIND_NAMES[kind]));
  }
  card.append(row);

  card.append(actions(coords, name ?? KIND_NAMES[kind] ?? null, { onStart, onEnd }));
  return card;
}


/**
 * @param {object} props        a feature from src/directory.json
 * @param {object} handlers     { onStart, onEnd, onClose }
 */
export function buildingCard(props, { onStart, onEnd, onClose }) {
  const {
    name, officialName, parts, area_m2: area, height, contents = [], facilities = [], entrance,
  } = props;

  const card = el('div', 'g-place');

  const { row, text } = head(name, onClose);

  // Only worth showing when it says something the heading does not.
  if (officialName && officialName !== name) text.append(el('p', 'g-panel-sub', officialName));

  const facts = [`${Math.round(area * FEET_PER_METRE).toLocaleString()} sq ft`];
  if (height) facts.push(`${Math.round(height * 3.28084)} ft tall`);
  text.append(el('p', 'g-place-facts', facts.join(' · ')));

  if (parts?.length) text.append(el('p', 'g-place-facts', parts.join(' · ')));
  card.append(row);

  if (contents.length) {
    const body = el('div', 'g-place-body');
    body.append(el('p', 'g-place-kicker',
      contents.length === 1 ? '1 destination inside' : `${contents.length} destinations inside`));

    const list = el('ul', 'g-place-list');
    for (const entry of contents) {
      // No class of its own: the two spans below are blocks in a gapped flex
      // column, which is the whole of what a row here needs to be.
      const item = el('li');
      item.append(el('span', 'g-place-item-name', entry.name));
      if (entry.description) {
        const short = entry.description.length > TRIM
          ? `${entry.description.slice(0, TRIM).trimEnd()}…`
          : entry.description;
        item.append(el('span', 'g-place-item-sub', short));
      }
      list.append(item);
    }
    body.append(list);
    card.append(body);
  }

  if (facilities.length) {
    card.append(el('p', 'g-place-facilities', facilities
      .map((f) => (f.n ? `${f.name} ×${f.n}` : f.name))
      .join(' · ')));
  }

  // No entrance means no routing node was found near the walls, which would
  // make both buttons lie about what they do.
  if (entrance) card.append(actions(entrance, name, { onStart, onEnd }));

  return card;
}
