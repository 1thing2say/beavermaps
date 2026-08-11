/**
 * Which shapes on the map are "the ones with a defibrillator in them".
 *
 * The legend used to be a key: eleven rows of glyph-and-caption telling you what
 * a symbol means and nothing about where those symbols are. This turns each row
 * into a query — hover "Defibrillator" and the six buildings holding one light
 * up, hover "Parking" and the tarmac does — which is the one question a printed
 * key cannot answer and a live map can.
 *
 * Nothing here touches the map or the DOM. It takes the four collections the app
 * already fetches and returns indices into an area list, so the whole join is
 * testable from node and the rendering has no geometry in it.
 *
 * THREE KINDS OF AREA, in the order they are searched:
 *
 *   1. Named buildings, from src/directory.json. my campus draws the Health Education
 *      Complex as nine footprints, and outlining one ninth of it because that is
 *      the shard the defibrillator landed in would be worse than not outlining
 *      anything. The directory has already done that grouping.
 *   2. The footprints directory.json did not claim — 38 of the 96 in
 *      buildings.json, the ones with no name to group by. Worth including for
 *      exactly what it buys: one of the six defibrillators, two bike shelters
 *      and four motorcycle bays are inside an unnamed building, and without
 *      these they would each report as standing out in the open.
 *   3. Parking, from the printed sheet's own `parking` polygons. These are not
 *      buildings and are the reason this file talks about "areas": my campus's key
 *      has a row for the car parks, and the only honest way to show 22 car parks
 *      is to paint the car parks.
 *
 * Buildings are searched before parking so a building standing inside a lot
 * wins the point that is inside both.
 *
 * TWO WAYS A POINT FINDS ITS AREA, and the split is deliberate.
 *
 *   - An amenity from amenities.json is where the object physically is, traced
 *     off my campus's artwork. Containment, and nothing else: 13 of the 15 bike racks
 *     stand 1.8 m to 24.7 m from the nearest wall, and a "near enough" rule
 *     generous enough to catch the 1.8 m one would sweep half of them indoors.
 *     A rack outside a building is outside it, and says so.
 *   - A row from places.json is a ROUTING NODE — my campus binds each destination to a
 *     vertex of the walk network, which sits at the door or the kerb rather than
 *     in the middle of the thing it names. All nine car parks and both Para
 *     Transit stops land within 1.3 m of the shape they belong to, and four of
 *     them land just outside it. Hence PLACE_REACH_M, which is small enough that
 *     it can only ever pick the shape the node was placed against.
 */

/** How far a directory row may sit outside the shape it names. See above. */
export const PLACE_REACH_M = 5;

const METRES_PER_DEGREE_LAT = 111320;
const COS_LAT = Math.cos((38.6547 * Math.PI) / 180);

/** Ray casting, same idiom as campus-clip.js. Rings here are closed. */
function inRing([lon, lat], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }
  return hit;
}

/**
 * Inside the polygon proper — outer ring, minus any holes.
 *
 * my campus's sheet does use them: the Parking Garage's ramp well and a couple of
 * courtyards are inner rings, and a point in one of those is outdoors.
 */
function inPolygon(coords, rings) {
  if (!inRing(coords, rings[0])) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (inRing(coords, rings[i])) return false;
  }
  return true;
}

/** Metres from a point to the segment a-b, on the local flat approximation. */
function toSegment(p, a, b) {
  const ax = (a[0] - p[0]) * METRES_PER_DEGREE_LAT * COS_LAT;
  const ay = (a[1] - p[1]) * METRES_PER_DEGREE_LAT;
  const bx = (b[0] - p[0]) * METRES_PER_DEGREE_LAT * COS_LAT;
  const by = (b[1] - p[1]) * METRES_PER_DEGREE_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Metres from a point to an area's nearest edge, 0 if it is inside.
 *
 * Exported for the tests, which use it to state the thing the two attachment
 * rules are built around: how far these points really sit from their shapes.
 */
export function metresToArea(coords, area) {
  let best = Infinity;
  for (const rings of area.polygons) {
    if (inPolygon(coords, rings)) return 0;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i += 1) {
        best = Math.min(best, toSegment(coords, ring[i - 1], ring[i]));
      }
    }
  }
  return best;
}

const polygonsOf = (geometry) => {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
};

/**
 * Everything the legend can outline, in search order.
 *
 * `directory` and `buildings` describe the same footprints — the directory's
 * MultiPolygons are assembled from buildings.json features verbatim — so a
 * footprint already inside a named group is skipped rather than added twice.
 * Identity, not proximity: the coordinates are the same numbers, so comparing
 * the serialised ring is exact and cannot mistake two adjacent portables for
 * one another.
 *
 * Every collection is optional. A failed overlay fetch costs the areas it would
 * have contributed and leaves the rest of the legend working, which is the same
 * bargain every other overlay in this app makes.
 */
export function buildAreas({ directory, buildings, basemap, zoneKinds = ['parking'] } = {}) {
  const areas = [];
  const claimed = new Set();
  const zones = new Set(zoneKinds);

  for (const feature of directory?.features ?? []) {
    const polygons = polygonsOf(feature.geometry);
    if (!polygons.length) continue;
    for (const rings of polygons) claimed.add(JSON.stringify(rings));
    areas.push({ kind: 'building', name: feature.properties.name ?? null, polygons });
  }

  for (const feature of buildings?.features ?? []) {
    const polygons = polygonsOf(feature.geometry);
    if (polygons.length !== 1 || claimed.has(JSON.stringify(polygons[0]))) continue;
    areas.push({ kind: 'building', name: feature.properties?.name ?? null, polygons });
  }

  // The sheet carries two `parking` LineStrings among the polygons — aisle
  // markings, not surfaces — and polygonsOf drops them.
  for (const feature of basemap?.features ?? []) {
    const sheet = feature.properties?.kind;
    if (!zones.has(sheet)) continue;
    const polygons = polygonsOf(feature.geometry);
    if (!polygons.length) continue;
    areas.push({ kind: 'zone', sheet, name: null, polygons });
  }

  return areas;
}

/** The index of the first area containing `coords`, or null. */
export function areaAt(coords, areas) {
  for (let i = 0; i < areas.length; i += 1) {
    for (const rings of areas[i].polygons) {
      if (inPolygon(coords, rings)) return i;
    }
  }
  return null;
}

/** The nearest area within `reach` metres, containment first. */
function areaNear(coords, areas, reach) {
  const inside = areaAt(coords, areas);
  if (inside !== null || reach <= 0) return inside;

  let best = { d: reach, index: null };
  for (let i = 0; i < areas.length; i += 1) {
    const d = metresToArea(coords, areas[i]);
    if (d <= best.d) best = { d, index: i };
  }
  return best.index;
}

/**
 * What one legend row lights up.
 *
 * Returns the areas to outline, the points that belong to no area, and the
 * counts the row prints under its caption. Those counts are the honest part of
 * this: "Bike Rack" outlines two car parks and leaves thirteen racks standing in
 * the open, and a row that said nothing about the thirteen would read as a map
 * that had lost them.
 *
 * `category.zones` names a sheet class the whole of which belongs to the row —
 * only Parking has one, because only Parking is a row about ground rather than
 * about objects. Its own directory rows still resolve individually, which is
 * what puts the Parking Garage's outline on the garage.
 */
export function highlightFor(category, { areas = [], amenities, places } = {}) {
  const selected = new Set();
  const points = [];

  if (category.zones) {
    for (let i = 0; i < areas.length; i += 1) {
      if (areas[i].sheet === category.zones) selected.add(i);
    }
  }

  if (category.kinds && amenities) {
    const wanted = new Set(category.kinds);
    for (const feature of amenities.features) {
      if (!wanted.has(feature.properties.kind)) continue;
      const coords = feature.geometry.coordinates;
      const index = areaAt(coords, areas);
      if (index === null) points.push(coords);
      else selected.add(index);
    }
  }

  if (category.match && places) {
    for (const feature of places.features) {
      if (!feature.geometry || !category.match(feature.properties.name ?? '')) continue;
      const coords = feature.geometry.coordinates;
      const index = areaNear(coords, areas, PLACE_REACH_M);
      if (index === null) points.push(coords);
      else selected.add(index);
    }
  }

  const indices = [...selected].sort((a, b) => a - b);
  return {
    indices,
    points,
    counts: {
      buildings: indices.filter((i) => areas[i].kind === 'building').length,
      zones: indices.filter((i) => areas[i].kind === 'zone').length,
      outside: points.length,
    },
  };
}

/** The outlined areas as something a geojson source will take. */
export function areaCollection(areas, indices) {
  return {
    type: 'FeatureCollection',
    features: indices.map((i) => ({
      type: 'Feature',
      properties: { kind: areas[i].kind, name: areas[i].name },
      geometry: { type: 'MultiPolygon', coordinates: areas[i].polygons },
    })),
  };
}

/** The loose points, likewise. */
export function pointCollection(points) {
  return {
    type: 'FeatureCollection',
    features: points.map((coords) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: coords },
    })),
  };
}

/**
 * The two corners of everything a row lights up.
 *
 * Corners rather than every vertex because this feeds the camera, and the
 * camera's "is it already on screen" test projects each point it is given: 22
 * car parks is about 1,100 vertices and exactly one rectangle.
 */
export function extentOf(areas, { indices = [], points = [] } = {}) {
  let west = Infinity; let south = Infinity;
  let east = -Infinity; let north = -Infinity;

  const see = ([lon, lat]) => {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  };

  for (const i of indices) {
    for (const rings of areas[i].polygons) for (const c of rings[0]) see(c);
  }
  for (const c of points) see(c);

  if (west === Infinity) return [];
  return [[west, south], [east, north]];
}
