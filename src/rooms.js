// What someone means when they type a room number into a campus map.
//
// Three shapes, and they overlap:
//
//   STEM 320    a building and a room. Always one answer.
//   401         a room and nothing else. Usually one answer, sometimes two —
//               see the note on ambiguity below.
//   ACCT 101    a course code. Always answerable, because my campus's schedule states
//               the building for every meeting it lists.
//
// The overlap is real and cannot be parsed away: "ACCT 101" and "STEM 320" are
// the same shape — letters, space, number — and nothing about the string says
// which it is. Only the tables know, and they can both say yes.
//
// As it happens no string in the Fall 2026 data is both (test/room-search.test.js
// asserts that, so the day one appears the assertion says so rather than the
// behaviour quietly changing). It takes one new subject code sharing a
// building's short name to create one, so this does not decide: it looks the
// query up every way it could be meant and returns each answer it finds, best
// first. A search box that offers two rows is right; one that silently picks
// the reading it happened to try first is not.
//
// Pure by construction — no DOM, no map, and it does not even import the data
// it reads. `buildRoomIndex` takes src/rooms.json and hands back everything the
// lookup needs, which is what lets test/room-search.test.js drive it directly.

/**
 * A room number as my campus writes them: 320, 001, 602A, 101B, 103-1, 1024,
 * and the lettered ones — L108 in the Library, N101 at Natomas.
 *
 * Anchored, because this decides whether the last word of a query is a room or
 * part of a name — and "Arts" must not read as one.
 */
const ROOM = /^[A-Za-z]?\d{1,4}[A-Za-z]?(-\d+)?$/;

/**
 * A course number as the schedule writes them: 101, 300, and the Cal-GETC
 * common numbers — C1000, C1000H — which start with a letter.
 *
 * Its own pattern rather than ROOM's, because the two only look alike. ENGL
 * C1000 is one of the most-enrolled courses on campus, and when the room shape
 * was the only gate it was the one course nobody could find.
 */
const COURSE_NUM = /^[A-Za-z]?\d{1,4}[A-Za-z]?$/;

/** A subject prefix as the schedule writes them: ACCT, BIOL, ENGWR, ESLW. */
const SUBJECT = /^[A-Za-z]{2,6}$/;

/** What people put in front of a room number that names no building: "Room 320", "rm 320". */
const ROOM_WORD = /^(room|rm\.?)$/i;

/** The abbreviation the map prints after a name: "Technical Education West (TEW)". */
const ABBREVIATION = /\s*\(([^)]+)\)\s*$/;

const key = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Everything the lookup needs, from the artifact, built once.
 *
 * The building index is keyed on EVERY name a building goes by: what the
 * schedule calls it ("Tech Ed West"), what this map calls it ("Technical
 * Education West (TEW)"), and the two halves of that — "Technical Education
 * West" and "TEW". Students read the first off a timetable and the rest off a
 * sign, and any of them should work.
 *
 * A key holds a LIST. Two schedule buildings can share the map's name — Fine
 * Arts and its one-room "Makeup room" are both Fine & Applied Arts, Science
 * and Science Portable are both Science & Engineering — and a key that held
 * one building let whichever came second replace the first, so "Fine & Applied
 * Arts 501", the name on the sign, found nothing.
 */
export function buildRoomIndex(data) {
  const buildings = new Map();
  const add = (name, b) => {
    const k = key(name);
    if (!k) return;
    const list = buildings.get(k) ?? [];
    if (!list.includes(b)) list.push(b);
    buildings.set(k, list);
  };
  for (const b of Object.values(data.buildings)) {
    add(b.name, b);
    if (!b.mapName) continue;
    add(b.mapName, b);
    const abbreviation = b.mapName.match(ABBREVIATION);
    if (abbreviation) {
      add(abbreviation[1], b);
      add(b.mapName.replace(ABBREVIATION, ''), b);
    }
  }
  return { data, buildings };
}

/** One search row. Same shape the place index produces, so the UI is unchanged. */
function entry(index, buildingName, { name, description }) {
  const b = index.data.buildings[buildingName];
  if (!b) return null;
  return {
    name,
    description,
    // Empty for a site that is not on this campus. The caller shows the row and
    // declines to fly to it, which is the honest answer to "where is my Natomas
    // class" — better than no result, and better than a pin in the wrong place.
    points: b.coords ? [b.coords] : [],
    elsewhere: Boolean(b.offCampus),
    // Named so a row can say WHY it has no coordinates: off campus, or on it
    // but spread over four fields.
    spread: b.spread ?? null,
    place: b.mapName ?? b.campus ?? b.name,
    // Marks a row the place index has never heard of, so picking it is not
    // remembered as a visit: a name like "Room 320" can never come back as a
    // suggestion, and remembering it only cost the shelf a slot.
    room: true,
  };
}

const label = (b) => b.mapName ?? b.name;

/**
 * Every reading of `query` that the schedule can answer, best first.
 *
 * Returns [] for anything that is not a room or a course, which is most typing
 * — the ordinary place search handles those and this must not get in its way.
 */
export function lookupRoom(query, index) {
  const words = (query ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const tail = words.at(-1);
  const isRoom = ROOM.test(tail);
  const isCourse = COURSE_NUM.test(tail);
  if (!isRoom && !isCourse) return [];
  const head = words.slice(0, -1).join(' ');
  // "Room 320" is how this module titles its own rows, and picking one writes
  // that title into the field — so it has to read back as the bare number, or
  // refocusing the field after a pick finds nothing.
  const place = words.slice(ROOM_WORD.test(words[0]) ? 1 : 0, -1).join(' ');
  const room = tail.toUpperCase();
  const hits = [];
  const seen = new Set();
  const push = (row, rank) => {
    if (!row) return;
    const id = `${row.name} ${row.place}`;
    if (seen.has(id)) return;
    seen.add(id);
    hits.push({ ...row, rank });
  };

  // "STEM 320" — a building this map knows, and a room the schedule has put in
  // it. The strongest reading there is: both halves are confirmed. One row per
  // building under that name that has the room, which is one in practice: the
  // buildings sharing a name share it because they are parts of one place.
  const named = isRoom && place ? index.buildings.get(key(place)) ?? [] : [];
  for (const b of named.filter((n) => n.rooms.includes(room))) {
    // Titled the same way a bare room number is — "Room 320", then the building
    // underneath — so the two readings of a room look like one kind of answer.
    // Putting the building in the title instead gives rows like "Diane Bryant
    // STEM Innovation Center 320", which buries the number that was typed.
    push(entry(index, b.name, {
      name: `Room ${room}`,
      description: b.offCampus ? `${label(b)} — ${b.campus}` : label(b),
    }), 0);
  }

  // "ACCT 101" — a course code. Equally certain, and often the same string as
  // the reading above, which is why both are tried rather than one chosen.
  if (isCourse && SUBJECT.test(head)) {
    const code = `${head.toUpperCase()} ${room}`;
    const course = index.data.courses[code];
    for (const name of course?.in ?? []) {
      const b = index.data.buildings[name];
      push(entry(index, name, {
        name: `${code} — ${course.title}`,
        description: b.offCampus ? `${b.campus} — not on this campus` : label(b),
      }), 1);
    }
  }

  // "401" on its own. One row per building that uses the number, because 21 of
  // the 125 rooms on this campus are used by more than one and the two are as
  // much as 411 m apart — picking the more popular one would be wrong for
  // nearly a third of scheduled classes.
  if (isRoom && !place) {
    const names = index.data.rooms[room] ?? [];
    for (const name of names) {
      push(entry(index, name, {
        name: `Room ${room}`,
        description: names.length > 1
          ? `${label(index.data.buildings[name])} — one of ${names.length}`
          : label(index.data.buildings[name]),
      }), 2);
    }
  }

  // Reading first, then on-campus before elsewhere. A course taught at both a
  // campus building and an outreach centre listed the centre first, purely
  // because `in` is sorted alphabetically and "Natomas" precedes "STEM" — on a
  // map of one campus, the row you can actually walk to belongs at the top.
  return hits.sort((a, b) => a.rank - b.rank || Number(a.elsewhere) - Number(b.elsewhere));
}
