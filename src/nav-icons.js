// Maneuver arrows drawn as strokes rather than unicode glyphs, so they stay
// crisp at banner size and inherit colour from the parent.

const SHAPES = {
  straight: '<path d="M12 21V5"/><path d="M6 11l6-6 6 6"/>',
  depart: '<path d="M12 21V5"/><path d="M6 11l6-6 6 6"/>',
  right: '<path d="M7 21v-8a4 4 0 0 1 4-4h7"/><path d="M14 5l4 4-4 4"/>',
  left: '<path d="M17 21v-8a4 4 0 0 0-4-4H6"/><path d="M10 5L6 9l4 4"/>',
  'slight-right': '<path d="M8 21v-6l8-8"/><path d="M11 7h5v5"/>',
  'slight-left': '<path d="M16 21v-6L8 7"/><path d="M13 7H8v5"/>',
  uturn: '<path d="M8 21V11a4 4 0 0 1 8 0v4"/><path d="M12 11l4 4 4-4"/>',
};

const ARRIVE =
  '<path d="M12 21s7-7.6 7-12a7 7 0 1 0-14 0c0 4.4 7 12 7 12z"/>' +
  '<circle cx="12" cy="9" r="2.5"/>';

export function maneuverIcon(type) {
  const shape = type === 'arrive' ? ARRIVE : (SHAPES[type] ?? SHAPES.straight);
  return (
    '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" ' +
    'stroke="currentColor" stroke-width="2.6" stroke-linecap="round" ' +
    `stroke-linejoin="round">${shape}</svg>`
  );
}
