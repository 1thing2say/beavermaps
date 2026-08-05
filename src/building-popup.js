// The card shown when a building is tapped.
//
// Built as DOM rather than an HTML string because the two buttons need handlers
// and because everything in src/directory.json is third-party text — my campus's own
// department names and descriptions — which has no business being interpolated
// into markup.

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
 * @param {object} props        a feature from src/directory.json
 * @param {object} handlers     { onStart, onEnd } — given the entrance coords
 */
export function buildingCard(props, { onStart, onEnd }) {
  const {
    name, officialName, parts, area_m2: area, height, contents = [], facilities = [], entrance,
  } = props;

  const card = el('div', 'campus-card w-72 max-w-full rounded-lg overflow-hidden '
    + 'bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 shadow-xl');

  const head = el('div', 'px-4 pt-3 pb-2');
  head.append(el('div', 'font-bold text-base leading-tight text-gray-900 dark:text-gray-50', name));

  // Only worth showing when it says something the heading does not.
  if (officialName && officialName !== name) {
    head.append(el('div', 'text-xs text-gray-500 dark:text-gray-400 mt-0.5', officialName));
  }

  const facts = [`${Math.round(area * FEET_PER_METRE).toLocaleString()} sq ft`];
  if (height) facts.push(`${Math.round(height * 3.28084)} ft tall`);
  head.append(el('div', 'text-xs text-gray-400 dark:text-gray-500 mt-1', facts.join(' · ')));

  if (parts?.length) {
    head.append(el('div', 'text-xs text-gray-500 dark:text-gray-400 mt-1', parts.join(' · ')));
  }
  card.append(head);

  if (contents.length) {
    const body = el('div', 'px-4 pb-2 max-h-44 overflow-y-auto border-t '
      + 'border-gray-100 dark:border-neutral-700 pt-2');
    body.append(el('div', 'text-[10px] uppercase tracking-wider font-semibold '
      + 'text-gray-400 dark:text-gray-500 mb-1',
    contents.length === 1 ? '1 destination inside' : `${contents.length} destinations inside`));

    const list = el('ul', 'space-y-1');
    for (const entry of contents) {
      const item = el('li', 'text-sm text-gray-700 dark:text-gray-300 leading-snug');
      item.append(el('span', 'font-medium', entry.name));
      if (entry.description) {
        const short = entry.description.length > TRIM
          ? `${entry.description.slice(0, TRIM).trimEnd()}…`
          : entry.description;
        item.append(el('div', 'text-xs text-gray-500 dark:text-gray-400', short));
      }
      list.append(item);
    }
    body.append(list);
    card.append(body);
  }

  if (facilities.length) {
    const strip = el('div', 'px-4 py-2 border-t border-gray-100 dark:border-neutral-700 '
      + 'text-xs text-gray-500 dark:text-gray-400');
    strip.textContent = facilities
      .map((f) => (f.n ? `${f.name} ×${f.n}` : f.name))
      .join(' · ');
    card.append(strip);
  }

  // No entrance means no routing node was found near the walls, which would
  // make both buttons lie about what they do.
  if (entrance) {
    const actions = el('div', 'flex gap-2 px-4 py-3 bg-gray-50 dark:bg-neutral-900/60 '
      + 'border-t border-gray-100 dark:border-neutral-700');

    const start = el('button', 'flex-1 text-sm font-semibold py-2 rounded-md '
      + 'bg-white dark:bg-neutral-800 text-gray-700 dark:text-gray-200 '
      + 'border border-gray-300 dark:border-neutral-600 '
      + 'hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors', 'Start here');
    start.type = 'button';
    start.addEventListener('click', () => onStart(entrance, name));

    const go = el('button', 'flex-1 text-sm font-semibold py-2 rounded-md text-white '
      + 'bg-emerald-600 hover:bg-emerald-500 transition-colors', 'Go here');
    go.type = 'button';
    go.addEventListener('click', () => onEnd(entrance, name));

    actions.append(start, go);
    card.append(actions);
  }

  return card;
}
