// Wheel gate: scrolling out leaves one level per gesture, with a pause and three pushes at the building level.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/wheel-gate.js';

const G = globalThis.OfficeWheelGate;
const NEXT = { floor: 'building', building: 'city' };

// Plays wheel events (time in ms) from the floor level. Returns [{ at, from }] for each level left.
function play(times, opts) {
  const g = G.create(opts);
  let level = 'floor';
  const left = [];
  for (const t of times) {
    if (level === 'city') break;
    if (g.push(level, t, true)) { left.push({ at: t, from: level }); level = NEXT[level]; }
  }
  return left;
}
const run = (from, to, step) => { const a = []; for (let t = from; t <= to; t += step) a.push(t); return a; };

test('one long trackpad flick leaves one level, never two', () => {
  for (const step of [8, 16, 33, 50, 100]) {
    const left = play(run(0, 2500, step));
    assert.deepEqual(left.map((x) => x.from), ['floor'], 'step ' + step);
  }
});

test('a flick with a long tail of small events still leaves one level', () => {
  const t = run(0, 300, 16).concat(run(400, 1800, 90));
  assert.deepEqual(play(t).map((x) => x.from), ['floor']);
});

test('a second gesture after a pause leaves the building', () => {
  const t = run(0, 300, 16).concat(run(1200, 1500, 16));
  const left = play(t);
  assert.deepEqual(left.map((x) => x.from), ['floor', 'building']);
  assert.ok(left[1].at >= 1200);
});

test('the building level needs three pushes', () => {
  const g = G.create();
  assert.equal(g.push('building', 0), false);
  assert.equal(g.push('building', 200), false);
  assert.equal(g.push('building', 400), true);
});

test('the floor level needs two pushes', () => {
  const g = G.create();
  assert.equal(g.push('floor', 0), false);
  assert.equal(g.push('floor', 200), true);
});

test('pushes far apart do not add up', () => {
  const g = G.create();
  assert.equal(g.push('building', 0), false);
  assert.equal(g.push('building', 1000), false);
  assert.equal(g.push('building', 2000), false);
  assert.equal(g.push('building', 3000), false);
});

test('slow pushes inside the 600 ms pause are ignored', () => {
  const g = G.create();
  assert.equal(g.push('floor', 0), false);
  assert.equal(g.push('floor', 200), true);
  // three slow pushes at the building level, all inside the pause
  assert.equal(g.push('building', 300), false);
  assert.equal(g.push('building', 450), false);
  assert.equal(g.push('building', 590), false);
  // the pause is over: three pushes count
  assert.equal(g.push('building', 800), false);
  assert.equal(g.push('building', 1000), false);
  assert.equal(g.push('building', 1200), true);
});

test('events that are not eligible do not count and break a run', () => {
  const g = G.create();
  assert.equal(g.push('building', 0, true), false);
  assert.equal(g.push('building', 100, true), false);
  assert.equal(g.push('building', 200, false), false);
  assert.equal(g.push('building', 300, true), false);
});
