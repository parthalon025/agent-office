// Toast list rules: what stays, what closes, what is pushed out. No browser, no timers. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/toasts.js';

const T = globalThis.OfficeToasts;
const info = (title) => ({ tone: 'info', title });

test('an error and a toast with an action stay; the others close after 8 seconds', () => {
  let l = [];
  l = T.add(l, info('a'), 1, 1000);
  l = T.add(l, { tone: 'error', title: 'e' }, 2, 1000);
  l = T.add(l, { tone: 'info', title: 'go', action: { label: 'Go there' } }, 3, 1000);
  assert.deepEqual(l.map((t) => !!t.until), [true, false, false]);
  assert.equal(T.tick(l, 1000 + T.AFTER_MS - 1, 1000, false).length, 3);
  assert.deepEqual(T.tick(l, 1000 + T.AFTER_MS, 1000, false).map((t) => t.id), [2, 3], 'only the timed toast closed');
  assert.deepEqual(T.tick(l, 1e9, 1000, false).map((t) => t.id), [2, 3], 'the others stay for ever');
});

test('the clocks wait while the pointer or the focus is on the stack', () => {
  let l = T.add([], info('a'), 1, 0);
  l = T.tick(l, 5000, 0, true);           // 5 s on hover
  assert.equal(T.tick(l, 5000 + T.AFTER_MS - 1, 5000, false).length, 1, 'the full time starts again after the pause');
  assert.equal(T.tick(l, 5000 + T.AFTER_MS, 5000, false).length, 0);
});

test('the stack holds 4; a new toast pushes out the oldest timed one, never the newest or one that needs action', () => {
  let l = [];
  l = T.add(l, { tone: 'error', title: 'e1' }, 1, 0);
  l = T.add(l, info('a'), 2, 0);
  l = T.add(l, info('b'), 3, 0);
  l = T.add(l, { tone: 'error', title: 'e2' }, 4, 0);
  l = T.add(l, info('c'), 5, 0);
  assert.deepEqual(l.map((t) => t.id), [1, 3, 4, 5], 'a went, the errors stayed');
  l = T.add(l, { tone: 'error', title: 'e3' }, 6, 0);
  assert.deepEqual(l.map((t) => t.id), [1, 4, 5, 6], 'b went, the timed toast c and both errors stayed');
  assert.equal(l.length, 4);
  assert.equal(l.at(-1).id, 6, 'the newest stays');
  // all four need action: the oldest goes
  let s = [];
  for (let i = 1; i <= 5; i++) s = T.add(s, { tone: 'error', title: 'e' + i }, i, 0);
  assert.deepEqual(s.map((t) => t.id), [2, 3, 4, 5]);
});

test('remove and hasTimed', () => {
  const l = T.add(T.add([], info('a'), 1, 0), { tone: 'error', title: 'e' }, 2, 0);
  assert.equal(T.hasTimed(l), true);
  assert.equal(T.hasTimed(T.remove(l, 1)), false);
  assert.deepEqual(T.remove(l, 2).map((t) => t.id), [1]);
});
