// src/rooms.js — what a typed query means.
//
// The parser's whole job is deciding whether "STEM 320" is a building and a
// room or a subject and a course number, and the honest answer is that it can
// be either and sometimes is both. Everything here is about that: that a query
// with two readings returns two rows, that a query with one returns one, and
// that the things which merely LOOK like room numbers are left alone so the
// ordinary place search still gets them.
//
// The failure mode this guards is quiet and bad. A parser that returns a
// confident single answer for an ambiguous room sends someone 411 m across
// campus to the wrong building, and nothing anywhere reports an error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRoomIndex, lookupRoom } from '../src/rooms.js';
import { root } from './helpers.js';

const data = JSON.parse(readFileSync(path.join(root, 'src', 'rooms.json'), 'utf8'));
const index = buildRoomIndex(data);
const find = (q) => lookupRoom(q, index);

test('a building and a room resolves to exactly that building', () => {
  const [hit, ...rest] = find('STEM 320');
  assert.ok(hit, 'STEM 320 found nothing');
  assert.equal(hit.place, 'Diane Bryant STEM Innovation Center');
  assert.equal(hit.name, 'Room 320', 'the row is titled by the building, burying what was typed');
  assert.equal(hit.description, 'Diane Bryant STEM Innovation Center');
  assert.equal(hit.points.length, 1);
  assert.equal(rest.length, 0, 'STEM 320 is not ambiguous and should return one row');

  // Both names a building has, because a student reads one off a timetable and
  // the other off the sign on the door.
  assert.deepEqual(find('Tech Ed West 401')[0].place, 'Technical Education West (TEW)');
  assert.deepEqual(find('Technical Education West (TEW) 401')[0].place,
    'Technical Education West (TEW)');
  // ...and neither is case- or punctuation-sensitive.
  assert.equal(find('stem 320')[0].place, 'Diane Bryant STEM Innovation Center');
});

test('a bare room number returns every building that uses it', () => {
  // The reason the artifact stores a list. 401 is Science and Technical
  // Education West, 103 m apart; answering with one of them is a coin flip.
  const both = find('401');
  assert.equal(both.length, 2, `401 returned ${both.length} rows`);
  assert.deepEqual(
    both.map((h) => h.place).sort(),
    ['Science & Engineering', 'Technical Education West (TEW)'],
  );
  for (const hit of both) {
    assert.match(hit.description, /one of 2/, 'an ambiguous row does not say it is one of several');
    assert.equal(hit.points.length, 1, 'an ambiguous row still has to be navigable');
  }

  // A room only one building uses says so plainly, with no "one of".
  const one = find('320');
  assert.equal(one.length, 1);
  assert.doesNotMatch(one[0].description, /one of/);

  // And every ambiguous room in the artifact comes back with all its answers.
  for (const [room, names] of Object.entries(data.rooms)) {
    if (names.length < 2) continue;
    assert.equal(find(room).length, names.length, `room ${room} lost an answer`);
  }
});

test('a course code resolves through the schedule, not the room number', () => {
  const [hit] = find('ACCT 101');
  assert.ok(hit, 'ACCT 101 found nothing');
  assert.match(hit.name, /^ACCT 101 — /, 'a course row does not name the course');
  assert.match(hit.name, /Accounting/, 'a course row does not carry its title');
  assert.equal(hit.place, 'Diane Bryant STEM Innovation Center');

  // A course that meets in two buildings — a lecture and its lab — keeps both.
  const split = Object.entries(data.courses).find(([, c]) => c.in.length === 2);
  assert.equal(find(split[0]).length, 2, `${split[0]} collapsed to one building`);
});

test('a class that is not on this campus is answered, not hidden', () => {
  // my campus teaches at two outreach centres and a dozen union apprenticeship halls.
  // "That one is at Natomas" is the correct answer and the only useful one; a
  // silent empty result would look like the search was broken.
  const away = Object.entries(data.courses)
    .find(([, c]) => c.in.every((n) => data.buildings[n].offCampus));
  assert.ok(away, 'no course is taught only off campus — the fixture is wrong');
  const [hit] = find(away[0]);
  assert.ok(hit, `${away[0]} found nothing`);
  assert.equal(hit.elsewhere, true);
  assert.deepEqual(hit.points, [], 'an off-campus row must not carry a coordinate');
  assert.match(hit.description, /not on this campus/);

  // ...but it goes last. A course taught both here and at an outreach centre
  // listed the centre first, because `in` is sorted alphabetically and
  // "Natomas" precedes "STEM". On a map of one campus that is backwards.
  const mixed = Object.entries(data.courses).find(([, c]) =>
    c.in.some((n) => data.buildings[n].offCampus) && c.in.some((n) => !data.buildings[n].offCampus));
  assert.ok(mixed, 'no course is taught both here and away — the fixture is wrong');
  const rows = find(mixed[0]);
  assert.equal(rows[0].elsewhere, false, `${mixed[0]} offers the off-campus room first`);
  assert.equal(rows.at(-1).elsewhere, true);
});

test('things that are not rooms are left to the ordinary search', () => {
  // This runs ahead of the place index on every keystroke, so anything it
  // claims wrongly is a result someone else should have had. A query has to end
  // in something shaped like a room number before it is even considered.
  for (const q of ['library', 'Student Center', 'parking', '', '   ', 'Raef Hall',
    'defibrillator', 'Fine Arts']) {
    assert.deepEqual(find(q), [], `"${q}" was read as a room`);
  }
  // A room-shaped number nobody uses is not invented.
  assert.deepEqual(find('9999'), []);
  assert.deepEqual(find('STEM 9999'), []);
  // ...and a real room in the wrong building is not quietly re-homed.
  assert.deepEqual(find('Library 320'), [], 'a room was assigned to a building that lacks it');
});

test('a query that is genuinely two things returns both', () => {
  // "letters number" is the shape of a course code AND of a building plus room,
  // so a string can be both. Driven from a fixture rather than from src/rooms.json
  // ON PURPOSE: this term happens to contain no such string — checked below —
  // so testing it against the real data would assert nothing at all while
  // looking like it asserted something. The collision is one new subject code
  // away, and this is the path it would take.
  const real = Object.keys(data.courses).filter((code) => {
    const [subject, number] = code.split(' ');
    return data.buildings[subject]?.rooms.includes(number);
  });
  assert.deepEqual(real, [], 'the real data now has a dual query — test it directly as well');

  const fixture = buildRoomIndex({
    buildings: {
      MUS: { name: 'MUS', offCampus: false, rooms: ['101'], mapName: 'Music', coords: [-121.35, 38.65] },
      'Fine Arts': { name: 'Fine Arts', offCampus: false, rooms: ['501'], mapName: 'Fine & Applied Arts', coords: [-121.349, 38.652] },
    },
    rooms: { 101: ['MUS'], 501: ['Fine Arts'] },
    courses: { 'MUS 101': { title: 'Music Appreciation', in: ['Fine Arts'] } },
  });
  const hits = lookupRoom('MUS 101', fixture);
  assert.equal(hits.length, 2, 'a dual query did not return both readings');
  // The room reading leads: someone typing a building and a number is standing
  // somewhere and wants the way there; a course code is a question about a
  // timetable, and its answer may be in a different building entirely.
  assert.equal(hits[0].rank, 0);
  assert.equal(hits[0].description, 'Music');
  assert.match(hits[1].name, /^MUS 101 — Music Appreciation/);
  assert.equal(hits[1].description, 'Fine & Applied Arts');
});

test('no row promises somewhere to go without having one', () => {
  // Every reachable row needs a coordinate and every unreachable one needs a
  // reason, because the caller branches on exactly that.
  const queries = [...Object.keys(data.rooms), ...Object.keys(data.courses)];
  let checked = 0;
  for (const q of queries) {
    for (const hit of find(q)) {
      checked += 1;
      if (hit.points.length) {
        assert.equal(hit.points.length, 1);
        assert.equal(hit.points[0].length, 2, `${q} has a malformed coordinate`);
      } else {
        assert.ok(hit.elsewhere || hit.spread, `${q} has no coordinate and no reason`);
      }
    }
  }
  assert.ok(checked > 600, `only ${checked} rows exercised`);
});

test('two schedule buildings sharing the map name both answer to it', () => {
  // Fine Arts and its one-room "Makeup room" are both Fine & Applied Arts on
  // the map. When a name held one building, the second replaced the first and
  // the name on the sign found nothing for the main building.
  assert.equal(find('Fine & Applied Arts 501')[0]?.name, 'Room 501');
  assert.equal(find('Fine & Applied Arts 501')[0]?.place, 'Fine & Applied Arts');
  assert.equal(find('Fine & Applied Arts 519')[0]?.name, 'Room 519');
  assert.equal(find('Science & Engineering 401')[0]?.name, 'Room 401');
  assert.equal(find('Science & Engineering 401').length, 1, 'the TEW 401 leaked into a named query');
  // Science Portable is filed under the Science Success Center now (see
  // build-rooms.mjs), so its rooms answer to that name and to the schedule's,
  // and no longer to Science & Engineering's.
  assert.equal(find('Science Success Center 490')[0]?.name, 'Room 490', 'the portable was lost');
  assert.equal(find('Science Portable 490')[0]?.place, 'Science Success Center');
  assert.equal(find('Science & Engineering 490').length, 0);
});

test('every name on the sign finds the building, abbreviation included', () => {
  // The map labels say "Technical Education West (TEW)"; people say TEW.
  for (const [q, place] of [
    ['TEW 400', 'Technical Education West (TEW)'],
    ['Technical Education West 400', 'Technical Education West (TEW)'],
    ['LRC 125', 'Learning Resource Center (LRC)'],
    ['ER 001', 'Environmental Resources (ER)'],
    ['CDC 350', 'Child Development Center (CDC)'],
  ]) {
    const hits = find(q);
    assert.equal(hits.length, 1, `"${q}" returned ${hits.length} rows`);
    assert.equal(hits[0].place, place, `"${q}" went to ${hits[0].place}`);
  }
  // A lettered room in a building that has it.
  assert.equal(find('Library L108')[0]?.place, 'Library');
  assert.equal(find('l108')[0]?.place, 'Library');
});

test('the title a room row carries reads back as that room', () => {
  // Picking a room writes "Room 320" into the field, so refocusing it has to
  // find the same room again rather than nothing.
  assert.deepEqual(find('Room 320'), find('320'));
  assert.deepEqual(find('room 401'), find('401'));
  assert.deepEqual(find('rm 320'), find('320'));
  assert.equal(find('Room 320').length, 1);
});

test('every course in the schedule can be found by its code', () => {
  // Including the Cal-GETC common numbers — ENGL C1000, STAT C1000H — whose
  // number starts with a letter and once failed the room-shape gate before the
  // course reading was ever tried.
  const lost = Object.keys(data.courses).filter((code) =>
    !find(code).some((hit) => hit.name.startsWith(`${code} — `)));
  assert.deepEqual(lost, []);
  assert.match(find('engl c1000')[0]?.name ?? '', /^ENGL C1000 — /);
});
