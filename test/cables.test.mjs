// The reporting lines of the HQ as cables (#226): the pure part of public/cables.js. A cable joins two desks of the floor on screen under
// the tray, or runs to the elevator when the other end sits on another floor, with a label there that names that floor and the people.
// No browser. Run: node --test test/cables.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/cables.js';

const C = globalThis.OfficeCables.pure;
const GEO = { tray: { y: 4.85, z: -5.1, sx: -9.5 }, elev: { x: -11, z: 4.75 }, depth: 12 };
const LINES = [
  { from: 'Ada', to: 'Grace', fromFloor: 3, toFloor: 4, fromFloorName: 'Engineering', toFloorName: 'Executive' },
  { from: 'Linus', to: 'Ada', fromFloor: 3, toFloor: 3, fromFloorName: 'Engineering', toFloorName: 'Engineering' },
  { from: 'Nia', to: 'Ada', fromFloor: 2, toFloor: 3, fromFloorName: 'Product', toFloorName: 'Engineering' },
];
const SEATS = { Ada: { x: -4, z: 1 }, Linus: { x: 3, z: 1.5 } };

test('a cable joins two desks of the floor on screen: up from the desk, along the tray, down at the manager', () => {
  const r = C.routes(LINES, 3, SEATS, GEO);
  const same = r.routes.find((x) => x.key === 'Linus>Ada');
  assert.deepEqual(same.points[0], [2.05, 0.95, 0.6], 'it starts at the left edge of the desk of the employee');
  assert.deepEqual(same.points.at(-1), [-4.95, 0.95, 0.1], 'it ends at the desk of the manager');
  assert.ok(same.points.slice(1, -1).every((p) => p[1] < GEO.tray.y && p[1] > 4), 'it runs just under the tray');
  for (const b of C.boxes(same.points, 0.08)) assert.equal([b.w, b.h, b.d].filter((v) => v > 0.08 + 1e-9).length, 1, 'every piece runs along one axis');
});

test('a manager or a report on another floor: the cable runs to the elevator, up or down, and a label names the floor and the people', () => {
  const r = C.routes(LINES, 3, SEATS, GEO);
  assert.deepEqual(r.routes.map((x) => x.key), ['Ada>Grace', 'Linus>Ada', 'Nia>Ada']);
  const up = r.routes[0].points, down = r.routes[2].points;
  assert.deepEqual(up.at(-2), [GEO.elev.x, 5.7, GEO.elev.z], 'it reaches the elevator');
  assert.ok(up.at(-1)[1] > 5.7, 'the manager sits above: the cable goes up the shaft');
  assert.ok(down.at(-1)[1] < 5.7, 'the report sits below: the cable goes down');
  assert.deepEqual(r.labels.map((l) => [l.title, l.sub]), [['Up to Executive', 'Reports to Grace'], ['Down to Product', 'Nia reports here']]);
  assert.notDeepEqual(r.routes[0].points[2], r.routes[1].points[2], 'two cables take two lanes under the tray');
});

test('nothing for a floor with no end of a line; a line whose bot is not seated yet draws nothing; no elevator, no label', () => {
  assert.deepEqual(C.routes(LINES, 9, SEATS, GEO), { routes: [], labels: [] });
  assert.deepEqual(C.routes(LINES, 3, { Linus: SEATS.Linus }, GEO).routes, []);
  const r = C.routes(LINES, 3, SEATS, { ...GEO, elev: null });
  assert.deepEqual([r.routes.map((x) => x.key), r.labels], [['Linus>Ada'], []]);
  const many = C.routes(Array.from({ length: 5 }, (_, i) => ({ from: 'R' + i, to: 'Ada', fromFloor: 2, toFloor: 3, fromFloorName: 'Product' })), 3, SEATS, GEO);
  assert.deepEqual(many.labels.map((l) => l.sub), ['R0, R1 and 3 more report here'], 'one label per floor, the names cut short');
  assert.deepEqual(C.boxes([[0, 0, 0], [0, 0, 0], [0, 2, 0]], 0.1), [{ x: 0, y: 1, z: 0, w: 0.1, h: 2.1, d: 0.1 }], 'a point twice is no piece');
});
