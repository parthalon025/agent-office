// Toast list rules: what stays, what closes, what is pushed out. No browser, no timers. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// #79: on a narrow screen the stack sits above every box that is anchored to the dock (the DS room card, the chat, the
// terminal, board and stats panels, the Since you left card), so it never covers one. T.lift gives the distance from the
// bottom of the view to the bottom of the stack.
test('lift: with no box above the dock, the stack stops at the dock (--strip-clear)', () => {
  assert.equal(T.lift(800, 170, []), 170);
  assert.equal(T.lift(800, 170, [{ top: 300, bottom: 400 }]), 170, 'a box that is not on the dock does not count');
  assert.equal(T.lift(800, 170, [{ top: 0, bottom: 0 }]), 170, 'an empty box does not count');
});

test('lift: the stack sits above the highest box that is anchored to the dock, with a gap', () => {
  const room = { top: 310, bottom: 630 };   // 800 - 170 = 630: it ends at the dock
  assert.equal(T.lift(800, 170, [room]), 800 - 310 + T.GAP);
  const chat = { top: 200, bottom: 630 };
  assert.equal(T.lift(800, 170, [room, chat]), 800 - 200 + T.GAP, 'the highest box wins');
  assert.equal(T.lift(800, 170, [{ top: 310, bottom: 629 }]), 800 - 310 + T.GAP, 'one pixel of rounding still counts');
});

test('lift: the stack never rises above the room it needs below the top of the view', () => {
  const tall = { top: 70, bottom: 630 };
  assert.equal(T.lift(800, 170, [tall]), 800 - T.TOP - T.ROOM);
  assert.equal(T.lift(300, 170, [{ top: 10, bottom: 130 }]), 170, 'a short window keeps the dock edge');
});

test('the narrow stack stands at --toast-lift, which office.js sets; no rule puts it at the top over the DS header', () => {
  const css = fs.readFileSync(new URL('../public/office.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const narrow = css.slice(css.indexOf('@media (max-width: 820px) {\n  .page-toasts'));
  const block = narrow.slice(0, narrow.indexOf('\n}\n'));
  assert.match(block, /\.page-toasts \{[^}]*bottom: var\(--toast-lift\)/);
  assert.doesNotMatch(css, /\.page-toasts[^{]*\{[^}]*top:/, 'a top rule would cover the DS header');
  assert.match(css, /\.page-toasts \{ --toast-lift: var\(--strip-clear/, 'the default is the dock edge');
  assert.match(fs.readFileSync(new URL('../public/office.js', import.meta.url), 'utf8'), /OfficeToasts\.lift\(/);
});
