/**
 * The bay dividers, redrawn as lines instead of as the bars they are.
 *
 * my campus's sheet paints 1,004 parking bays as filled rectangles, 0.99 by 7.90 m
 * each, and on their printed map those combs are one of the loudest things on
 * the page — 18% of the campus is car park and every square metre of it is
 * ruled. On ours they were invisible until you were nearly on top of a single
 * building, and the reason is arithmetic rather than taste: 0.99 m is 0.53 of a
 * pixel at z16 and 0.46 at the zoom the campus first fits the screen. A fill
 * that thin does not render as a thin line, it renders as a partially covered
 * pixel — so a rank of them beats against the pixel grid and the car park comes
 * out as a smear of light and dark. They were held back to z17 for exactly that
 * reason, which fixed the smear by removing the information.
 *
 * A LINE has the one thing a fill has not: a minimum width. Drawn along its own
 * long axis at its own 0.99 m, with a floor of just over a pixel, a divider is
 * the true bar whenever the true bar is more than a pixel wide and a crisp
 * hairline whenever it would be less. Same geometry, same width, no beating —
 * and the rake is on the map at every zoom the car park is.
 *
 * Derived on the way in rather than in the build script, for the same reason
 * the POI discs and the campus clip are: src/basemap.json stays a record of
 * what my campus drew, and how to draw a sub-pixel bar is a decision about rendering.
 */

import { M_PER_LON, M_PER_LAT } from './campus-clip.js';

const KIND = 'parking_stripe';

const exteriors = (geometry) => (
  geometry.type === 'Polygon' ? [geometry.coordinates[0]]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates.map((rings) => rings[0])
      : []);

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const span = (a, b) => Math.hypot((a[0] - b[0]) * M_PER_LON, (a[1] - b[1]) * M_PER_LAT);

/**
 * The long axis of a four-cornered bar, and how wide it is.
 *
 * A rectangle's long axis joins the midpoints of its two SHORT sides, so the
 * whole job is deciding which pair of opposite edges is the short one. Taken as
 * a pair rather than edge by edge because the sheet's bars are drawn at every
 * angle and a couple are very slightly out of square; averaging the pair means
 * one edge a few centimetres off cannot flip the answer.
 *
 * Null for anything that is not four corners. Nothing in this layer is —
 * all 1,004 arrive as a closed five-position ring — and a bar that stopped
 * being one should disappear from the rake rather than be guessed at.
 */
function spine(ring) {
  const c = ring.slice(0, -1);
  if (c.length !== 4) return null;
  const ends = span(c[0], c[1]) + span(c[2], c[3]) < span(c[1], c[2]) + span(c[3], c[0])
    ? [[c[0], c[1]], [c[2], c[3]]]
    : [[c[1], c[2]], [c[3], c[0]]];
  return {
    coordinates: ends.map(([a, b]) => mid(a, b)),
    width: +((span(...ends[0]) + span(...ends[1])) / 2).toFixed(2),
  };
}

/**
 * Every bay divider in the sheet as a LineString carrying its own width in
 * ground metres, which is what `SHEET_WIDTH` in src/main.js reads.
 *
 * `i` is carried across so the rake sorts into the same draw order as the sheet
 * it came out of, and so a divider can still be traced back to the element my campus
 * drew it as.
 */
export function bayRake(sheet) {
  const features = [];
  for (const feature of sheet.features) {
    if (feature.properties.kind !== KIND) continue;
    for (const ring of exteriors(feature.geometry)) {
      const line = spine(ring);
      if (!line) continue;
      features.push({
        type: 'Feature',
        properties: { i: feature.properties.i, kind: KIND, width: line.width },
        geometry: { type: 'LineString', coordinates: line.coordinates },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
