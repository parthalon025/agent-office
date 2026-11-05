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

// #79: the stack never covers the top controls, the floors card, the dock, a request bar or a message box (keep), at
// any width and window height, with any panel open. It covers the chat, the room card or a panel (avoid) only when no
// band is free of them. T.place gives { x, bottom, maxH } or { hidden: true }. The layouts below are measured in the
// browser (#79 review): px, top-left origin.
const R = (left, top, right, bottom) => ({ left, top, right, bottom });
const box = (view, sw, p) => R(p.x, view.h - p.bottom - p.maxH, p.x + sw, view.h - p.bottom);
const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
function clear(view, sw, p, keep, msg) {
  assert.ok(!p.hidden, msg + ': the stack shows');
  const s = box(view, sw, p);
  assert.ok(s.left >= 0 && s.right <= view.w && s.top >= 0 && s.bottom <= view.h, msg + ': inside the window');
  assert.ok(p.maxH >= T.LEAST, msg + ': at least ' + T.LEAST + ' px high');
  keep.forEach((k, i) => assert.ok(!hits(s, k), `${msg}: covers keep box ${i} ${JSON.stringify(k)} (stack ${JSON.stringify(s)})`));
  return s;
}

test('place: with nothing in the way the stack stands at home, its bottom on the dock line', () => {
  const view = { w: 1360, h: 860 };
  const p = T.place(view, { w: 360 }, { x: 362, y: 690 }, [], []);
  assert.deepEqual(p, { x: 362, bottom: 860 - 690, maxH: 690 - T.GAP });
  const top = R(16, 12, 1344, 56);
  assert.equal(T.place(view, { w: 360 }, { x: 362, y: 690 }, [top], []).maxH, 690 - 56 - T.GAP, 'it stops under the top controls');
  assert.equal(T.place(view, { w: 360 }, { x: 362, y: 690 }, [R(0, 0, 0, 10), R(5, 5, 5, 5)], []).x, 362, 'an empty box does not count');
});

test('place: 400 x 800, board and stats panels: the request bars at the top of the panel stay clear (review #2)', () => {
  const view = { w: 400, h: 800 }, sw = 368, home = { x: 16, y: 630 };
  const keep = [R(16, 12, 384, 143), R(16, 108, 384, 200),   // the DS header, the floor strip
    R(24, 241, 376, 481),                                     // three request bars, one under the other, at the top of the panel
    R(24, 489, 376, 525),                                     // Back to the room
    R(16, 642, 384, 788)];                                    // the dock
  const panel = R(16, 228, 384, 630);
  const p = T.place(view, { w: sw }, home, keep, [panel]);
  const s = clear(view, sw, p, keep, 'board 400x800');
  assert.equal(p.bottom, 800 - 630, 'its bottom stays on the dock line');
  assert.ok(s.top >= 525, 'it stands under the request bars and the Back button, over the lower part of the panel');
});

test('place: 400 x 640, terminal panel with two requests: the request bar grows upward and stays clear (review #2)', () => {
  const view = { w: 400, h: 640 }, sw = 368, home = { x: 16, y: 470 };
  const keep = [R(16, 12, 384, 143), R(16, 108, 384, 201), R(16, 150, 384, 190),   // header, floor strip, panel head (Back)
    R(16, 276, 384, 437), R(16, 437, 384, 470),                                     // two requests, the message box
    R(16, 480, 384, 628)];
  const p = T.place(view, { w: sw }, home, keep, [R(16, 150, 384, 470)]);
  const s = clear(view, sw, p, keep, 'terminal 400x640');
  assert.ok(p.maxH < T.MIN_H, 'only a short band is free: the stack takes it and scrolls');
  assert.ok(s.bottom <= 276, 'it ends above the first request');
});

test('place: 1100 x 800 and 821 x 700, terminal, board and stats panels: the stack keeps off the request bars (review #1)', () => {
  // 1100 x 800: the floors card is on the left, the panel on the right; the stack stays in its own column
  let view = { w: 1100, h: 800 }, sw = 360, home = { x: 16, y: 620 };
  let keep = [R(16, 12, 1084, 56), R(16, 68, 236, 300), R(16, 636, 720, 688),
    R(524, 68, 1084, 108), R(523, 520, 1083, 580), R(524, 580, 1084, 620)];   // panel head, request bar, message box
  let p = T.place(view, { w: sw }, home, keep, [R(524, 68, 1084, 620)]);
  let s = clear(view, sw, p, keep, 'terminal 1100x800');
  assert.equal(p.x, 16);
  assert.ok(s.right <= 524, 'the stack does not touch the panel when there is room beside it');
  assert.ok(s.top >= 300, 'and stays under the floors card');
  // 821 x 700: the panel (245 to 805) crosses every column; the stack covers the terminal screen, never its request bar
  view = { w: 821, h: 700 }; home = { x: 16, y: 520 };
  const cast = R(16, 638, 481, 686);
  for (const asks of [R(245, 420, 805, 480), R(245, 300, 805, 480)]) {   // one request, then three
    keep = [R(16, 12, 805, 56), R(16, 68, 236, 280), R(16, 536, 441, 588), cast, R(245, 68, 805, 108), asks, R(245, 480, 805, 520)];
    p = T.place(view, { w: sw }, home, keep, [R(245, 68, 805, 520)]);
    s = clear(view, sw, p, keep, 'terminal 821x700');
    assert.ok(s.bottom <= asks.top - T.GAP, 'over the terminal screen, above the request bar');
  }
  assert.equal(p.x, 16 + 220 + T.GAP, 'with three requests the band under the floors card is too short: the stack moves right of the card');
  // board or stats panel at 821: the request bars sit at the top of the panel (420 px wide, 385 to 805)
  keep = [R(16, 12, 805, 56), R(16, 68, 236, 280), R(16, 536, 441, 588), cast, R(393, 80, 797, 300), R(393, 308, 797, 340)];
  p = T.place(view, { w: sw }, home, keep, [R(385, 68, 805, 520)]);
  clear(view, sw, p, keep, 'board 821x700');
});

test('place: short windows: the stack never covers the top controls or the zoom column (review #3)', () => {
  // 1100 x 540 Sublevel: the top controls end at 100, the floors card at 300
  let view = { w: 1100, h: 540 }, sw = 360;
  let keep = [R(16, 12, 1084, 100), R(16, 68, 236, 300), R(16, 376, 720, 428), R(766, 470, 800, 526)];
  let p = T.place(view, { w: sw }, { x: 16, y: 360 }, keep, [R(814, 68, 1084, 360)]);
  clear(view, sw, p, keep, '1100x540');
  // 821 x 700 with four sticky toasts: whatever the stack holds, its box ends in a free band; the zoom column stays clear
  view = { w: 821, h: 700 };
  keep = [R(16, 12, 805, 56), R(16, 68, 236, 280), R(16, 536, 441, 588), R(487, 470, 521, 640)];
  p = T.place(view, { w: sw }, { x: 16, y: 520 }, keep, [R(535, 68, 805, 520)]);
  clear(view, sw, p, keep, '821x700 zoom');
  // 1360 x 540
  view = { w: 1360, h: 540 };
  keep = [R(16, 12, 1344, 100), R(16, 68, 236, 300), R(362, 400, 984, 464)];
  p = T.place(view, { w: sw }, { x: 362, y: 380 }, keep, [R(994, 68, 1344, 380)]);
  const s = clear(view, sw, p, keep, '1360x540');
  assert.equal(p.x, 362, 'its own column has room');
  assert.ok(s.top >= 100 + T.GAP && s.bottom <= 400 - T.GAP);
});

test('place: when a band is free of the boxes too, the stack takes it before it covers one (the room card stays clear)', () => {
  const view = { w: 400, h: 800 }, sw = 368;
  const keep = [R(16, 12, 384, 143), R(16, 108, 384, 200), R(16, 642, 384, 788)];
  const card = R(16, 410, 384, 630);
  const p = T.place(view, { w: sw }, { x: 16, y: 630 }, keep, [card]);
  const s = clear(view, sw, p, keep.concat([card]), 'room card');
  assert.equal(s.bottom, 410 - T.GAP, 'it stands just above the card');
  assert.equal(s.top, 200 + T.GAP, 'and takes the band up to the floor strip');
  // a band under MIN_H above the chat: the stack covers the chat log, never a request or the message box in it
  const chat = R(16, 230, 384, 630), act = R(28, 470, 372, 510), composer = R(16, 560, 384, 630);
  const q = T.place(view, { w: sw }, { x: 16, y: 630 }, keep.concat([act, composer]), [chat]);
  clear(view, sw, q, keep.concat([act, composer]), 'chat 400x800');
});

test('place: no band of LEAST px is free: the stack waits out of sight', () => {
  const view = { w: 400, h: 300 };
  assert.deepEqual(T.place(view, { w: 368 }, { x: 16, y: 200 }, [R(0, 0, 400, 140), R(0, 170, 400, 300)], []), { hidden: true });
  assert.ok(!T.place(view, { w: 368 }, { x: 16, y: 200 }, [R(0, 0, 400, 100), R(0, 160, 400, 300)], []).hidden, 'a band of 44 px is enough');
});

test('place: random layouts: never over a keep box, inside the window, and hidden only when no column has room', () => {
  let seed = 79;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  const rect = (W, H) => { const l = rnd(W), t = rnd(H); return R(l, t, Math.min(W, l + 20 + rnd(W / 2)), Math.min(H, t + 10 + rnd(H / 3))); };
  // a brute-force band search on every whole-pixel column, with the same gap rule
  const free = (W, H, sw, boxes, least) => {
    for (let x = T.EDGE; x <= Math.max(T.EDGE, W - T.EDGE - sw); x++) {
      const cut = boxes.filter((r) => r.left - T.GAP < x + sw && r.right + T.GAP > x).map((r) => [r.top - T.GAP, r.bottom + T.GAP]).sort((a, b) => a[0] - b[0]);
      let y = T.GAP;
      for (const c of cut) { if (c[0] - y >= least) return true; y = Math.max(y, c[1]); }
      if (H - T.GAP - y >= least) return true;
    }
    return false;
  };
  let shown = 0, hidden = 0;
  for (let n = 0; n < 400; n++) {
    const W = [400, 820, 1100, 1360][n % 4], H = 400 + rnd(500), sw = Math.min(360, W - 32);
    const keep = Array.from({ length: 1 + rnd(6) }, () => rect(W, H)), avoid = Array.from({ length: rnd(4) }, () => rect(W, H));
    const p = T.place({ w: W, h: H }, { w: sw }, { x: W > 1100 ? 362 : 16, y: H - 150 - rnd(60) }, keep, avoid);
    if (p.hidden) { hidden++; assert.ok(!free(W, H, sw, keep, T.LEAST), 'hidden, but a column has room: layout ' + n); continue; }
    shown++;
    clear({ w: W, h: H }, sw, p, keep, 'layout ' + n);
    if (free(W, H, sw, keep.concat(avoid), T.MIN_H)) {
      const s = box({ w: W, h: H }, sw, p);
      avoid.forEach((a) => assert.ok(!hits(s, a), 'a free band existed, but the stack covers an avoid box: layout ' + n));
    }
  }
  assert.ok(shown > 200 && hidden > 0, `both cases are tried (${shown} shown, ${hidden} hidden)`);
});

test('the stack is placed by office.js at every width: no width rule moves it, and the palette stands above it (review #1, #6)', () => {
  const css = fs.readFileSync(new URL('../public/office.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const js = fs.readFileSync(new URL('../public/office.js', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/([^{}]*\.page-toasts[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]);
  assert.ok(rules.some((r) => /left: var\(--toast-x\)/.test(r) && /bottom: var\(--toast-bottom\)/.test(r) && /max-height:[^;]*var\(--toast-room\)/.test(r)), 'the base rule reads the placement');
  rules.forEach((r) => assert.doesNotMatch(r, /(?<![-\w])(left|top|bottom): (?!var\(--toast-)/, 'only office.js places the stack: ' + r));
  assert.doesNotMatch(css, /@media \(min-width: 821px\) and \(max-width: 1100px\) \{ \.page-toasts/, 'no 821 to 1100 px literal');
  assert.match(js, /OfficeToasts\.place\(/);
  const keep = /var KEEP = '([^']*)'/.exec(js)?.[1] || '';
  for (const sel of ['.ao-hud-top', '.ao-hud-left', '.ao-hud-zoom', '.strip', '.asks', '.term-input', '.ao-hud-chat .ao-act', '.ao-hud-chat .ao-composer']) {
    assert.ok(keep.split(',').map((x) => x.trim()).includes(sel), 'KEEP lists ' + sel);
  }
  const z = (sel) => /calc\(var\(--z-dialog\) \+ (\d+)\)/.exec(css.slice(css.indexOf(sel + ' {')))?.[1];
  assert.ok(Number(z('.ao-cmdk-o')) > Number(z('.page-toasts')), 'the Ctrl+K palette is above the toast stack');
});
