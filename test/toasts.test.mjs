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
// terminal, board and stats panels, the Since you left card) and below the top controls (the DS header and the floors
// card), so it covers neither. T.lift gives { bottom, maxH }: the distance from the bottom of the view to the bottom of
// the stack, and the most height it may take.
test('lift: with no box above the dock, the stack stops at the dock (--strip-clear)', () => {
  assert.equal(T.lift(800, 170, [], 0).bottom, 170);
  assert.equal(T.lift(800, 170, [{ top: 300, bottom: 400 }], 0).bottom, 170, 'a box that is not on the dock does not count');
  assert.equal(T.lift(800, 170, [{ top: 0, bottom: 0 }], 0).bottom, 170, 'an empty box does not count');
  assert.equal(T.lift(800, 170).bottom, 170, 'no boxes and no top edge');
});

test('lift: the stack sits above the highest box that is anchored to the dock, with a gap', () => {
  const room = { top: 410, bottom: 630 };   // 800 - 170 = 630: it ends at the dock
  assert.equal(T.lift(800, 170, [room], 150).bottom, 800 - 410 + T.GAP);
  const chat = { top: 300, bottom: 630 };
  assert.equal(T.lift(800, 170, [room, chat], 150).bottom, 800 - 300 + T.GAP, 'the highest box wins');
  assert.equal(T.lift(800, 170, [{ top: 410, bottom: 629 }], 150).bottom, 800 - 410 + T.GAP, 'one pixel of rounding still counts');
});

test('lift: the height is the free band between the top controls and the stack', () => {
  const r = T.lift(800, 170, [{ top: 410, bottom: 630 }], 200);
  assert.equal(r.maxH, 800 - r.bottom - 200 - T.GAP);
  assert.equal(T.lift(800, 170, [], 200).maxH, 800 - 170 - 200 - T.GAP, 'no box: the band above the dock');
});

test('lift: the stack never covers the top controls (400 x 800: header to 143, floors card to 200)', () => {
  const edge = 200;
  // a tall chat reaches up to y 210: the free band above it is under MIN_H, so the stack hangs under the controls
  const tall = T.lift(800, 170, [{ top: 210, bottom: 630 }], edge);
  assert.equal(tall.bottom, null);
  assert.ok(tall.top >= edge + T.GAP, 'its top stays below the controls');
  // a box whose top leaves a band of exactly MIN_H keeps the stack above it, and the stack fits the band
  const boxTop = 800 - (800 - edge - T.GAP - T.MIN_H) + T.GAP;
  const fit = T.lift(800, 170, [{ top: boxTop, bottom: 630 }], edge);
  assert.equal(fit.bottom, 800 - boxTop + T.GAP);
  assert.equal(fit.maxH, T.MIN_H);
  // a band of 90 px (400 x 800 with a tall room card) is used in full: the stack shrinks and scrolls, it does not cover the card
  const shrink = T.lift(800, 170, [{ top: 800 - (800 - edge - T.GAP - 90) + T.GAP, bottom: 630 }], edge);
  assert.equal(shrink.maxH, 90);
  assert.ok(shrink.bottom > 170);
  assert.ok(800 - fit.bottom - fit.maxH >= edge + T.GAP, 'its top stays below the controls');
});

test('lift: a band shorter than MIN_H puts the stack under the top controls, over the top of the box, never over its bottom', () => {
  // 400 x 800 terminal panel (228 to 630): the controls end at 201, the dock is 170 high
  const tall = T.lift(800, 170, [{ top: 228, bottom: 630 }], 201);
  assert.equal(tall.top, 201 + T.GAP, 'the top edge is just under the controls');
  assert.equal(tall.bottom, null, 'a bottom rule is off, so the stack does not stand on the dock edge');
  assert.ok(tall.top + tall.maxH <= 800 - 170, 'it ends above the dock');
  // 800 x 450 landscape: the top controls end at 160, the dock is 150 high, the box reaches up to 142
  const land = T.lift(450, 150, [{ top: 142, bottom: 300 }], 160);
  assert.equal(land.top, 160 + T.GAP);
  assert.equal(land.maxH, 450 - 150 - 160 - T.GAP);
  assert.ok(land.top + land.maxH <= 450 - 150);
  // with no top controls the stack starts at the gap
  assert.equal(T.lift(300, 170, [{ top: 20, bottom: 130 }], 0).top, T.GAP);
  // no band at all: the stack still gets MIN_H, so a toast can be read and scrolled
  assert.equal(T.lift(300, 170, [], 200).maxH, T.MIN_H);
  // enough room above the box: the stack stands above it and sets no top
  assert.equal(T.lift(800, 170, [{ top: 410, bottom: 630 }], 150).top, null);
});

test('the narrow stack stands at --toast-lift and takes at most --toast-room, which office.js sets; a top is set only by office.js, and the CSS has no fixed top rule', () => {
  const css = fs.readFileSync(new URL('../public/office.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const narrow = css.slice(css.indexOf('@media (max-width: 820px) {\n  .page-toasts'));
  const block = narrow.slice(0, narrow.indexOf('\n}\n'));
  assert.match(block, /\.page-toasts \{[^}]*bottom: var\(--toast-lift\)/);
  assert.match(block, /\.page-toasts \{[^}]*max-height: min\([^;]*var\(--toast-room\)/);
  assert.match(block, /\.page-toasts \{[^}]*top: var\(--toast-top\)/);
  assert.doesNotMatch(css, /\.page-toasts[^{]*\{[^}]*(?<![-\w])top: (?!var\(--toast-top\))/, 'a fixed top rule would cover the DS header');
  assert.match(css, /\.page-toasts \{[^}]*--toast-top: auto/, 'the default top is auto');
  assert.match(css, /\.page-toasts \{[^}]*--toast-lift: var\(--strip-clear/, 'the default is the dock edge');
  assert.match(css, /\.page-toasts \{[^}]*--toast-room: 100vh/, 'above 820 px the stack has no height rule');
  assert.match(fs.readFileSync(new URL('../public/office.js', import.meta.url), 'utf8'), /OfficeToasts\.lift\(/);
});

test('from 821 to 1100 px the stack stands between the floors card and the chat column, so it covers neither', () => {
  const css = fs.readFileSync(new URL('../public/office.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const m = css.match(/@media \(min-width: 821px\) and \(max-width: 1100px\) \{ \.page-toasts \{([^}]*)\} \}/);
  assert.ok(m, 'a rule for 821 to 1100 px');
  const left = Number(/left: (\d+)px/.exec(m[1])?.[1]);
  assert.ok(left >= 16 + 220 + 16, 'it starts right of the floors card (16 px edge, 220 px card, 16 px gap)');
  assert.match(m[1], /width: min\(360px, calc\(100vw - (\d+)px\)\)/);
  const cut = Number(/calc\(100vw - (\d+)px\)/.exec(m[1])[1]);
  assert.ok(cut >= left + 16 + 272 + 16, 'it ends left of the chat column (272 px wide, 16 px edge and gap)');
  assert.doesNotMatch(css, /@media \(max-width: 1100px\) \{ \.page-toasts \{ left: var\(--space-4\)/, 'the old rule put it over the floors card');
});
