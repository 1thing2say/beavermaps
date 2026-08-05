/**
 * SVG (my campus basemap) -> WGS84, and the metre scales that go with it.
 *
 * my campus's client hardcodes its own constants in getSvgCoordsFromGpsCoords
 * (campus-data/wayfind/.../wayfind.js:361) under a `// TODO: computerize these.`
 * comment, and they are wrong. Checked against OpenStreetMap buildings on this
 * campus they place the map a median of 66 m off, biased east — their latitude
 * scale is fine but their longitude scale is ~3% too large and their origin is
 * about 50 m out.
 *
 * These constants are a least-squares refit. Control points pair my campus's own
 * hand-authored `Touchable` regions — whose geometry is bound to a LocationID,
 * so the name-to-shape link is authoritative — against OSM buildings matched by
 * name. Of 20 candidate pairs, 6 were rejected by iterated 2-sigma trimming,
 * mostly name-match failures ("Technical Education West" vs OSM "Tech Ed.",
 * "Kinesiology and Athletics Division" vs "Physical Education Building"), and
 * 14 remain.
 *
 * Accuracy against those 14, leave-one-out cross-validated:
 *
 *   my campus's published constants   median 65.8 m
 *   scale+offset (4p, used)     median  1.93 m   mean 2.34 m   max 7.72 m
 *   similarity   (4p)           median  2.00 m
 *   affine       (6p)           median  2.13 m
 *
 * The model is scale+offset per axis, the same algebraic form my campus used. Neither
 * rotation nor shear earns its parameters: a similarity fit puts the rotation at
 * +0.0028 degrees, i.e. none, and the affine fit generalises worse than the
 * simpler model. The x and y scales land 0.23% apart, which is the sanity check
 * that matters — a plan projection of a real place should be isotropic.
 *
 * THE CONSTANTS ABOVE SUPERSEDE THAT FIT. The name-matched control points are
 * all buildings, and buildings on this campus cluster in the core, so they
 * constrain the scale poorly. Adding perimeter features — the pool, the stadium
 * field and the stadium lot, matched against OSM leisure/parking polygons —
 * extended the control set to 500 m from centre and revealed a real north-south
 * scale error that the core-only sets could not see. The shipped fit is a robust
 * L1 (IRLS) fit over 56 control points with *nothing discarded*, chosen over
 * least squares because OSM-vs-my campus centroid noise is heavy-tailed and over
 * trimming because any residual-based trim preferentially deletes the outer
 * points that carry the scale signal.
 *
 * Change from my campus-refit-v1: x scale +0.236%, y scale +0.427%, origin 0.35 m west
 * and 2.02 m north. Median error by distance from campus centre:
 *
 *     0-150 m   n=12   2.73 m -> 2.41 m
 *   150-300 m   n=38   2.31 m -> 1.82 m
 *   300-700 m   n= 6   5.80 m -> 4.40 m
 *
 * Every ring improves, the outer edge most. Leave-one-out CV prefers the refit
 * (2.14 m vs 2.46 m), and the y-scale correction is unanimous across all 56
 * leave-one-out fits (+0.385%..+0.455%). The anisotropy lands at 0.07%, i.e.
 * the projection is isotropic to within a millimetre per unit — the sanity check
 * that matters, since a plan projection of a real place must be.
 *
 * What is NOT worth doing: a rubber-sheet warp. Twenty inverse-distance-weighted
 * configurations were leave-one-out cross-validated and every one lost to the
 * plain global transform. The mean cosine between two buildings' error vectors
 * is |cos| <= 0.08 in every separation band, including 0-50 m — buildings 30 m
 * apart are drawn wrong in unrelated directions, so there is no coherent
 * distortion field to model. Only retracing features against imagery beats this.
 *
 * my campus's Batch.json routing graph and the ActiveMap.svg artwork were also checked
 * against each other, with no reference to OSM, by counting path nodes that fall
 * inside a building footprint. The optimum over a +-6 unit shift grid is exactly
 * (0, 0), and the best rescale saves 4 nodes out of 113 while a deliberate 1%
 * rescale costs 9 — noise. The two layers share one coordinate system, so a
 * single transform is correct for both.
 *
 * Three ways to get this wrong, all of which produced convincing false numbers:
 *
 *   - Do not derive control points from src/buildings.json. Its names are
 *     attached by point-in-polygon and are a step removed from the source; a fit
 *     done that way was contaminated and landed at 15 m instead of 2 m.
 *   - Do not shortcut the path parser by treating every number in a `d`
 *     attribute as a coordinate. Relative commands and bezier control points
 *     make that meaningless, and it scored these same models at 110 m.
 *   - Do not estimate scale from control points that do not span the sheet. A
 *     12-point set covering only 332 m east-west reported the x scale as 0.73%
 *     too small at 5.5 sigma, unanimous across every leave-one-out fit — and the
 *     full-campus bootstrap puts the probability of an error that large at 1.2%.
 *     Scale is barely identifiable over a short baseline, so a narrow set will
 *     report one confidently and wrongly. Check the span before the p-value.
 *   - Do not trust a bootstrap confidence interval to rule a scale error *out*
 *     when the control points do not reach the edge. On the core-only set the
 *     y-scale CI was -0.21%..+1.11% and was read here as "contains zero, so
 *     nothing to fix". It was wrong: every leave-one-out fit put the y scale
 *     above the shipped value, and cross-validation preferred freeing it. When a
 *     wide interval and a unanimous jackknife disagree, get better data at the
 *     edge rather than picking whichever answer is more convenient.
 *
 * ~2 m is the floor FOR A TRANSFORM. The basemap is a stylised illustration,
 * not a survey, so the residual is its own draughting licence and no global
 * transform removes it — the residual offsets cancel out (mean offset 0.8 m
 * against a typical magnitude of 3.5 m, a ratio of 0.24), which is what says
 * there is no shift, scale or rotation left to find.
 *
 * Two corrections to the numbers above, both mine:
 *
 *   - The accuracy figures here were measured by matching each node to the
 *     nearest OSM way within 8 m. That discards the nodes that are worst, so it
 *     measures the parts already correct. Matching on bearing instead, which
 *     allows a 25 m search without grabbing unrelated ways, the honest figure
 *     is 3.5 m median with a tail past 20 m — roughly double what is quoted.
 *   - "No transform removes it" is not the same as "nothing removes it". my campus
 *     drew individual paths several metres off, coherently along their length,
 *     and that is fixed per-node by src/path-corrections.json — see
 *     scripts/build-snap.mjs. Held-out median 2.04 m -> 1.60 m, and it lowers
 *     the count of path nodes stranded inside a building from 112 to 105.
 *     Building footprints are deliberately left alone; they were already right.
 */

export const LEFT_LON = -121.351255212;
export const TOP_LAT = 38.653866848;
export const SVG_TO_LON = 0.000018957771;
export const SVG_TO_LAT = 0.000014855558;

/** Ground metres per SVG unit, along each axis. */
export const M_PER_UNIT_X = 1.6503;
export const M_PER_UNIT_Y = 1.6491;
export const M2_PER_UNIT2 = M_PER_UNIT_X * M_PER_UNIT_Y;

/** ~1 cm. Nodes are projected once and reused, so shared endpoints stay exact. */
const DECIMALS = 7;

export function project([x, y]) {
  return [
    Number((LEFT_LON + x * SVG_TO_LON).toFixed(DECIMALS)),
    Number((TOP_LAT - y * SVG_TO_LAT).toFixed(DECIMALS)),
  ];
}
