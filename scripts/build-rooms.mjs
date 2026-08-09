/**
 * Turn my campus's published class schedule into "which building is that room in?"
 *
 * The wayfinding data this project already had stops at the building. my campus's own
 * wayfinding app knows 120 named locations and not one of them is a room, so a
 * student holding a printout that says "STEM 320" had nothing on this map to
 * type. The class schedule is the only public place the two are written down
 * together, once per section:
 *
 *     <li><span class='label'>Building</span>Main Campus, STEM, 320</li>
 *
 * Source: the district's class-search endpoint, the endpoint
 * behind the college's class-schedule page. Unauthenticated GET,
 * one request per second, 125 pages for the whole term. the college's
 * robots.txt disallows `/*?term=*` only, and this endpoint takes `strm`; the
 * host serving it publishes no robots.txt at all. Archived under
 * campus-data/schedule/, which is gitignored — the committed artifact is
 * src/rooms.json, and only the join, not their HTML.
 *
 * Deliberately NOT scraped: the employee directory, which is linked from every
 * class card and would give office rooms for the buildings teaching does not
 * reach. Those rooms are attached to named people, and a campus map does not
 * need to know where an individual sits to tell you where a building is.
 *
 * ---------------------------------------------------------------------------
 * A room number is not enough, and the data says so
 *
 * The obvious hope is that my campus numbers rooms in per-building blocks, so "320"
 * alone would be enough. It does not: of the eight hundreds-blocks in use, three
 * are owned by a single building and five are shared, 1xx by eight buildings.
 *
 * Testing the weaker, more useful claim directly — how many distinct room
 * numbers name exactly one building — gives 104 of 125, or 83%. But the 21 that
 * collide are the busy ones, and the build prints what share of actual meetings
 * they carry. The worst pair is Science and Technical Education West, which both
 * number 400-412 and account for eleven of the twenty-one collisions on their
 * own; Science is a directory building and TEW is a portable block behind it,
 * so this is two real places with one numbering scheme rather than a data error.
 *
 * So `rooms` is written as a room -> LIST of buildings, and the caller gets to
 * say "did you mean", rather than picking the more popular one silently.
 *
 * Course code -> building has no such problem: the schedule always states the
 * building, so a class always resolves.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (name) => JSON.parse(readFileSync(path.join(root, 'src', name), 'utf8'));

/** Term the archived pages were fetched for. `strm` is PeopleSoft's term code. */
const TERM = { strm: '1269', name: 'Fall 2026', retrieved: '2026-08-09' };

// `<br>` is data here, not layout: a section that meets twice in different
// rooms puts both listings in ONE Building cell separated by a break, and
// stripping tags without honouring it produced "CTE, 127Main Campus, CTE, 129"
// — a building name with a room number buried in the middle of it.
const BREAK = '\u0001';

const text = (s) => s
  .replace(/<br\s*\/?>/gi, BREAK)
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
  .replace(/&[a-z]+;/g, ' ')
  .replace(/[^\S\u0001]+/g, ' ')
  .trim();

// ---------------------------------------------------------------------------
// Reading their HTML
// ---------------------------------------------------------------------------

/** Every timetabled meeting in the archive: course, class number, where. */
function* meetings() {
  const dir = path.join(root, 'campus-data', 'schedule');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
    const page = readFileSync(path.join(dir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const card of page.split('<article class="class-card"').slice(1)) {
      const head = /class="class-card-subj-num">(.*?)<\/span>(.*?)<\/div>/s.exec(card);
      if (!head) continue;
      const course = text(head[1]);
      const title = text(head[2]);
      // One `detail` block per section; a course with three sections has three,
      // and they can be in three different buildings.
      for (const detail of card.split("<div class='detail").slice(1)) {
        const fields = {};
        for (const [, li] of detail.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
          const label = /<span class=['"]?label['"]?[^>]*>([\s\S]*?)<\/span>/.exec(li);
          if (label) fields[text(label[1])] = text(li.slice(label.index + label[0].length));
        }
        // "Main Campus, STEM, 320" — campus, building, room. One listing per
        // break; a section can hold two, and "To Be Announced" holds a
        // well-formed one with both fields empty.
        for (const listing of (fields.Building ?? '').split(BREAK)) {
          const parts = listing.split(',').map((p) => p.trim());
          if (parts.length < 3) continue;
          const [campus, room] = [parts[0], parts.at(-1)];
          const building = parts.slice(1, -1).join(', ');
          if (!building || !room) continue;
          yield { course, title, section: fields.Class ?? '', campus, building, room };
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Their names for a building, and ours
// ---------------------------------------------------------------------------

/**
 * The schedule's spelling, normalised.
 *
 * Everything here is a variant of a name the schedule itself uses elsewhere, so
 * the fix is spelling rather than judgement: "Environmental Res." and
 * "Environmental Resources" are one building, "Science portable" and "Science
 * Portable" differ by a capital, and "LRC - Reading Across Disciplin" is a
 * course name that has been truncated into the building column at 30
 * characters. `Library--Orientation Lab` is a room inside the Library, and
 * `ITC Training Room` a room inside the ITC.
 */
const SPELLING = {
  'Environmental Res.': 'Environmental Resources',
  'Science portable': 'Science Portable',
  'LRC - Reading Across Disciplin': 'Learning Resource',
  'Library--Orientation Lab': 'Library',
  'ITC Training Room': 'ITC',
};

/**
 * What each schedule building is called on this map.
 *
 * Only the ones a normalised string comparison cannot get to. Everything absent
 * from this table is matched automatically below, and the test asserts that
 * every name in the schedule ends up resolved one way or the other — so a term
 * that introduces a new building fails the build rather than vanishing.
 *
 * `Makeup room` is not a building at all; the schedule uses it for two sections
 * in room 519, and 5xx is Fine Arts throughout, so it is filed there. That is
 * the one entry below inferred from the room number rather than from a name.
 */
const OURS = {
  STEM: 'Diane Bryant STEM Innovation Center',
  CTE: 'Career Technical Education (CTE)',
  Science: 'Science & Engineering',
  'Fine Arts': 'Fine & Applied Arts',
  'Arts and Science': 'Arts & Sci',
  'Physical Education': 'Kinesiology & Athletics (Physical Education)',
  'Adaptive P.E.': 'Adaptive PE',
  'Health and Ed': 'Health Education Complex',
  'Child Development Ctr.': 'Child Development Center (CDC)',
  'Learning Resource': 'Learning Resource Center (LRC)',
  'Environmental Resources': 'Environmental Resources (ER)',
  'Art Gallery': 'Kaneko Art Gallery',
  'Makeup room': 'Fine & Applied Arts',
  // Not directory buildings — the printed sheet names them but the 30-building
  // directory does not cover them, so they resolve to a label or a place. The
  // resolver below finds them; they are listed here only because their schedule
  // spelling differs from the sheet's.
  'Tech Ed West': 'Technical Education West (TEW)',
  'Swimming Pool': 'Pool',
  'Science Portable': 'Science & Engineering',
};

/**
 * Sites that are not this campus.
 *
 * my campus teaches at two outreach centres, a handful of union apprenticeship halls
 * (the four-letter prefixes are trades — DRLTH drylining, ELEVA elevator
 * constructors, IW ironworkers, SHME sheet metal, PLUMB, ELECT, CARPT), a
 * hospital, and study abroad. None of them belong on a map of one campus, and
 * silently dropping them would be worse than naming them: a student looking for
 * their Natomas class should be told it is not here, not shown nothing.
 */
const ELSEWHERE = /^(Natomas|Mather|McClellan|Off Campus|Field Trips|Hospital|UC Davis|CARPT|PLUMB|ELECT|DRLTH|ELEVA|IW|SHME|Finishing Trades)\b/;

/**
 * On this campus, but not in one place.
 *
 * `PE Fields` is what the schedule calls outdoor physical education, and the
 * sheet draws four separate things it could mean — the stadium, the soccer
 * stadium, the baseball field and the softball field, spread over 300 m. There
 * is no coordinate that is right for it, so it gets none and says why, rather
 * than resolving to whichever the matcher happened to reach first.
 */
const SPREAD = {
  'PE Fields': 'outdoor PE, which the sheet draws as four separate fields',
};

/** Anything on this map that can be pointed at, in the order we prefer. */
function targets() {
  const found = new Map();
  const add = (name, kind, coords) => {
    if (name && coords && !found.has(name)) found.set(name, { name, kind, coords });
  };

  const ring = (geometry) =>
    (geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates[0])[0];
  const middle = (geometry) => {
    if (geometry.type === 'Point') return geometry.coordinates;
    const r = ring(geometry).slice(0, -1);
    return [
      Number((r.reduce((s, p) => s + p[0], 0) / r.length).toFixed(7)),
      Number((r.reduce((s, p) => s + p[1], 0) / r.length).toFixed(7)),
    ];
  };

  // Buildings first: a directory entry carries an entrance and a name a student
  // would recognise, which is what a search result should fly to.
  for (const f of src('directory.json').features) {
    add(f.properties.name, 'building', f.properties.anchor ?? middle(f.geometry));
  }
  // Then the sheet's own labels, which cover the structures the directory does
  // not — Technical Education West, the pool, the theatre.
  for (const f of src('labels.json').features) {
    add(f.properties.text, 'label', middle(f.geometry));
  }
  // Then places, which are the finest-grained thing with a coordinate.
  for (const f of src('places.json').features) {
    if (f.geometry) add(f.properties.name, 'place', middle(f.geometry));
  }
  return found;
}

const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve one schedule name to something on the map, or null. */
function resolve(name, found) {
  const wanted = OURS[name] ?? name;
  if (found.has(wanted)) return found.get(wanted);
  const k = key(wanted);
  for (const t of found.values()) if (key(t.name) === k) return t;
  // A last resort, and deliberately the narrowest one: the map's name may carry
  // a parenthetical the schedule drops ("Environmental Resources (ER)"). Only
  // a prefix counts — a bare `includes` matched "STEM" against a HomeBase place
  // whose description happened to contain it.
  for (const t of found.values()) if (key(t.name).startsWith(k)) return t;
  return null;
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

const found = targets();
const rows = [...meetings()];

const buildings = new Map();
const unresolved = [];
for (const m of rows) {
  const name = SPELLING[m.building] ?? m.building;
  if (!buildings.has(name)) {
    const offCampus = ELSEWHERE.test(name) || m.campus !== 'Main Campus';
    const spread = SPREAD[name];
    const at = offCampus || spread ? null : resolve(name, found);
    if (!offCampus && !spread && !at) unresolved.push(name);
    buildings.set(name, {
      name, offCampus, campus: m.campus, sections: 0, rooms: new Set(),
      ...(spread ? { spread } : {}),
      ...(at ? { mapName: at.name, mapKind: at.kind, coords: at.coords } : {}),
    });
  }
  const b = buildings.get(name);
  b.sections += 1;
  b.rooms.add(m.room);
}

const rooms = new Map();
const courses = new Map();
for (const m of rows) {
  const name = SPELLING[m.building] ?? m.building;
  if (buildings.get(name).offCampus) continue;
  if (!rooms.has(m.room)) rooms.set(m.room, new Set());
  rooms.get(m.room).add(name);
  if (!courses.has(m.course)) courses.set(m.course, new Set());
  courses.get(m.course).add(name);
}

const sorted = (set) => [...set].sort();
const artifact = {
  term: TERM,
  source: 'the district's class-search endpoint',
  note: 'Room -> building is a LIST: 21 of 149 room numbers are used by more than one building.',
  buildings: Object.fromEntries(
    [...buildings.values()]
      .sort((a, b) => b.sections - a.sections)
      .map(({ rooms: r, ...b }) => [b.name, { ...b, rooms: sorted(r) }]),
  ),
  rooms: Object.fromEntries([...rooms].sort(([a], [b]) => a.localeCompare(b)).map(([r, s]) => [r, sorted(s)])),
  courses: Object.fromEntries([...courses].sort(([a], [b]) => a.localeCompare(b)).map(([c, s]) => [c, sorted(s)])),
};

writeFileSync(path.join(root, 'src', 'rooms.json'), `${JSON.stringify(artifact, null, 1)}\n`);

const onCampus = [...buildings.values()].filter((b) => !b.offCampus);
const ambiguous = [...rooms.values()].filter((s) => s.size > 1).length;
const here = rows.filter((m) => !buildings.get(SPELLING[m.building] ?? m.building).offCampus);
const shared = here.filter((m) => (rooms.get(m.room)?.size ?? 0) > 1).length;
console.log(`${rows.length} timetabled meetings across ${buildings.size} buildings`);
console.log(`  ${onCampus.length} on this campus, ${buildings.size - onCampus.length} elsewhere`);
console.log(`  ${rooms.size} rooms, ${ambiguous} of them in more than one building`);
console.log(`  ${shared} of ${here.length} on-campus meetings sit in a shared room number`
  + ` (${((shared / here.length) * 100).toFixed(0)}%)`);
console.log(`  ${Object.keys(artifact.courses).length} courses`);
if (unresolved.length) console.log(`  UNRESOLVED: ${[...new Set(unresolved)].join(', ')}`);
